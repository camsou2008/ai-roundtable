import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentPrompt, parseCodexOutput, parseHermesOutput } from "../server.mjs";

test("parseCodexOutput extracts the thread and final agent message", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "第一版" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "最终观点" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");

  assert.deepEqual(parseCodexOutput(output), {
    sessionId: "thread-123",
    response: "最终观点",
    error: "",
  });
});

test("parseHermesOutput keeps stdout clean and reads the latest stderr session", () => {
  const parsed = parseHermesOutput(
    "Warning: Unknown toolsets: messaging\n## **这是 Hermes 的观点。**\n",
    "↻ Resumed session old\n\nsession_id: 20260704_010203_abc123\n",
  );

  assert.deepEqual(parsed, {
    sessionId: "20260704_010203_abc123",
    response: "这是 Hermes 的观点。",
    error: "",
  });
});

test("buildAgentPrompt includes bounded context and discussion safety rules", () => {
  const prompt = buildAgentPrompt({
    agent: "codex",
    topic: "长期记忆",
    message: "给出立场",
    context: [{ speaker: "你", text: "先独立思考" }],
  });

  assert.match(prompt, /Codex/);
  assert.match(prompt, /长期记忆/);
  assert.match(prompt, /不要执行命令/);
});
