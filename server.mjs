import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SESSION_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const STATIC_FILES = new Set(["/", "/index.html", "/styles.css", "/app.js"]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

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
      // Ignore non-JSON diagnostic lines; the CLI contract is JSONL on stdout.
    }
  }

  return { sessionId, response: response.trim(), error };
}

export function parseHermesOutput(stdout, stderr) {
  const matches = [...stderr.matchAll(/(?:^|\n)session_id:\s*([^\s]+)/g)];
  const sessionId = matches.at(-1)?.[1] || "";
  const errorLine = stderr
    .split("\n")
    .find((line) => /^Error:/i.test(line.trim()));
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

export function buildAgentPrompt({ agent, topic, message, context = [] }) {
  const identity = agent === "codex" ? "Codex" : "Hermes";
  const transcript = context
    .slice(-10)
    .map((item) => `${item.speaker}: ${String(item.text).slice(0, 1800)}`)
    .join("\n");

  return [
    `你是圆桌聊天室中的 ${identity}，正在与用户和另一位 AI 讨论。`,
    `讨论主题：${topic || "未命名主题"}`,
    transcript ? `最近对话：\n${transcript}` : "这是本轮首条消息。",
    `用户指令：${message}`,
    "直接以自己的身份发言。观点具体、简洁，可以质疑另一位参与者，但不要替其他人发言。",
    "使用纯文本和简短条目，不要使用 Markdown 标题或粗体标记。",
    "本轮是纯讨论：不要调用工具，不要执行命令，不要读取或修改文件。",
  ].join("\n\n");
}

function redact(text) {
  return String(text)
    .replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}/gi, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(-1200);
}

function runCommand(command, args, { timeoutMs = 240_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
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

async function runCodex(payload, signal) {
  const prompt = buildAgentPrompt({ ...payload, agent: "codex" });
  const common = ["--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", ROOT];
  const args = payload.sessionId
    ? ["exec", ...common, "resume", payload.sessionId, prompt]
    : ["exec", ...common, prompt];
  const result = await runCommand("codex", args, { signal });
  const parsed = parseCodexOutput(result.stdout);

  if (result.code !== 0 || parsed.error || !parsed.response) {
    throw new Error(parsed.error || redact(result.stderr) || `Codex 退出码：${result.code}`);
  }
  return parsed;
}

async function runHermes(payload, signal) {
  const prompt = buildAgentPrompt({ ...payload, agent: "hermes" });
  const args = [
    "chat",
    "-Q",
    "--source",
    "tool",
    "--max-turns",
    "1",
    "--pass-session-id",
  ];
  if (payload.sessionId) args.push("--resume", payload.sessionId);
  args.push("-q", prompt);

  const result = await runCommand("hermes", args, { signal });
  const parsed = parseHermesOutput(result.stdout, result.stderr);
  if (result.code !== 0 || parsed.error || !parsed.response) {
    throw new Error(parsed.error || redact(result.stderr) || `Hermes 退出码：${result.code}`);
  }
  return parsed;
}

async function checkAgent(command) {
  try {
    const result = await runCommand(command, ["--version"], { timeoutMs: 5_000 });
    const version = `${result.stdout}\n${result.stderr}`.trim().split("\n")[0];
    return { online: result.code === 0, version };
  } catch {
    return { online: false, version: "" };
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validatePayload(payload) {
  if (!payload || !["codex", "hermes"].includes(payload.agent)) throw new Error("未知参与者");
  if (!String(payload.message || "").trim()) throw new Error("消息不能为空");
  if (String(payload.message).length > 12_000) throw new Error("消息过长");
  if (payload.sessionId && !SESSION_PATTERN.test(payload.sessionId)) throw new Error("无效的会话 ID");
  if (payload.context && !Array.isArray(payload.context)) throw new Error("对话上下文格式错误");
}

export function createAppServer({ runners = { codex: runCodex, hermes: runHermes } } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/api/status") {
      const [codex, hermes] = await Promise.all([checkAgent("codex"), checkAgent("hermes")]);
      return sendJson(response, 200, { codex, hermes });
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      try {
        const payload = await readJson(request);
        validatePayload(payload);
        const abortController = new AbortController();
        request.on("aborted", () => abortController.abort());
        const result = await runners[payload.agent](payload, abortController.signal);
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, 400, { error: redact(error.message || error) });
      }
    }

    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204);
      return response.end();
    }

    if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
      const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      try {
        const content = await readFile(join(ROOT, filename));
        response.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(filename)] || "application/octet-stream",
          "cache-control": "no-cache",
        });
        return response.end(content);
      } catch {
        return sendJson(response, 404, { error: "页面文件不存在" });
      }
    }

    return sendJson(response, 404, { error: "未找到该路径" });
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT || 4173);
  createAppServer().listen(port, "127.0.0.1", () => {
    console.log(`Roundtable running at http://127.0.0.1:${port}`);
  });
}
