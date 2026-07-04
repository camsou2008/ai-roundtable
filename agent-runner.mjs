import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SESSION_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

function redact(text) {
  return String(text)
    .replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}/gi, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(-1200);
}

function runCommand(command, args, { timeoutMs = 240_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fn(value);
    };

    const abort = () => {
      child.kill("SIGTERM");
      finish(reject, new Error("请求已取消"));
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error(`${command} 响应超时`));
    }, timeoutMs);

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => finish(resolve, { code, stdout, stderr }));
  });
}

function buildAgentPrompt({ agentName, topic, message, context = [], promptPrefix = "" }) {
  const transcript = context
    .slice(-10)
    .map((item) => `${item.sender_name}: ${String(item.content).slice(0, 1800)}`)
    .join("\n");

  const parts = [
    promptPrefix,
    `你是圆桌聊天室中的 ${agentName}，正在与用户和其他参与者讨论。`,
    topic ? `讨论主题：${topic}` : "",
    transcript ? `最近对话：\n${transcript}` : "这是本轮首条消息。",
    `用户指令：${message}`,
    "直接以自己的身份发言。观点具体、简洁，可以质疑其他人，但不要替别人发言。",
    "使用纯文本和简短条目，不要使用 Markdown 标题或粗体标记。",
    "本轮是纯讨论：不要调用工具，不要执行命令，不要读取或修改文件。",
  ].filter(Boolean).join("\n\n");

  return parts;
}

export function parseCodexOutput(stdout) {
  let sessionId = "";
  let response = "";
  let error = "";

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started") sessionId = event.thread_id || "";
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        response = event.item.text || response;
      }
      if (event.type === "error") error = event.message || "Codex 返回错误";
      if (event.type === "turn.failed") error = event.error?.message || error || "Codex 回合失败";
    } catch {
      // ignore non-JSON lines
    }
  }

  return { sessionId, response: response.trim(), error };
}

export function parseHermesOutput(stdout, stderr) {
  const matches = [...stderr.matchAll(/(?:^|\n)session_id:\s*([^\s]+)/g)];
  const sessionId = matches.at(-1)?.[1] || "";
  const errorLine = stderr.split("\n").find((line) => /^Error:/i.test(line.trim()));
  const response = stdout
    .split("\n")
    .filter((line) => !/^Warning:\s+Unknown toolsets:/i.test(line.trim()))
    .join("\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/^\*\*$/gm, "")
    .trim();

  return {
    sessionId,
    response,
    error: errorLine?.replace(/^Error:\s*/i, "").trim() || "",
  };
}

// ── 运行 Agent ──
// agents 表中的 command 字段: "codex" 或 "hermes"
// sessionStr 是持久化的 sessionId（可选）

export async function runAgent(agentName, command, prompt, topic, context, sessionStr, signal) {
  const fullPrompt = buildAgentPrompt({
    agentName,
    topic,
    message: prompt,
    context,
    promptPrefix: "",
  });

  if (command === "codex") {
    return runCodex(fullPrompt, sessionStr, signal);
  } else if (command === "hermes") {
    return runHermes(fullPrompt, sessionStr, signal);
  } else {
    // Generic: pipe prompt via stdin
    return runGeneric(command, fullPrompt, signal);
  }
}

async function runCodex(prompt, sessionStr, signal) {
  const common = ["--json", "--sandbox", "read-only", "--skip-git-repo-check"];
  const args = sessionStr
    ? ["exec", ...common, "resume", sessionStr, prompt]
    : ["exec", ...common, prompt];
  const result = await runCommand("codex", args, { signal });
  const parsed = parseCodexOutput(result.stdout);

  if (result.code !== 0 || parsed.error || !parsed.response) {
    throw new Error(parsed.error || redact(result.stderr) || `Codex 退出码：${result.code}`);
  }
  return parsed;
}

async function runHermes(prompt, sessionStr, signal) {
  const args = [
    "chat", "-Q", "--source", "tool", "--max-turns", "1", "--pass-session-id",
  ];
  if (sessionStr) args.push("--resume", sessionStr);
  args.push("-q", prompt);

  const result = await runCommand("hermes", args, { signal });
  const parsed = parseHermesOutput(result.stdout, result.stderr);
  if (result.code !== 0 || parsed.error || !parsed.response) {
    throw new Error(parsed.error || redact(result.stderr) || `Hermes 退出码：${result.code}`);
  }
  return parsed;
}

async function runGeneric(command, prompt, signal) {
  // 通用模式：通过管道 stdin 传入 prompt，读 stdout
  const result = await runCommand(command, [], { signal });
  if (result.code !== 0) {
    throw new Error(redact(result.stderr) || `${command} 退出码：${result.code}`);
  }
  const response = result.stdout.trim();
  if (!response) throw new Error(`${command} 返回为空`);
  return { sessionId: "", response };
}

// ── 检查 Agent 是否可用 ──

export async function checkAgent(command) {
  try {
    const result = await runCommand(command, ["--version"], { timeoutMs: 5_000 });
    const version = `${result.stdout}\n${result.stderr}`.trim().split("\n")[0];
    return { online: result.code === 0, version };
  } catch {
    return { online: false, version: "" };
  }
}
