import assert from "node:assert/strict";
import test from "node:test";

import { parseClaudeSession } from "../lib/claude-session.ts";

function session(...records: object[]) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

test("normalizes Claude prompts, messages, tools, and results", () => {
  const transcript = parseClaudeSession(session(
    {
      type: "user", timestamp: "2026-08-01T00:00:00Z", sessionId: "claude-1", uuid: "prompt-1", cwd: "/repo", gitBranch: "main", version: "2.1.0",
      message: { role: "user", content: "Inspect the project" },
    },
    {
      type: "assistant", timestamp: "2026-08-01T00:00:01Z", sessionId: "claude-1", uuid: "response-1",
      message: { id: "message-1", role: "assistant", model: "claude-opus-4-8", content: [{ type: "thinking", thinking: "I will inspect it." }] },
    },
    {
      type: "assistant", timestamp: "2026-08-01T00:00:02Z", sessionId: "claude-1", uuid: "response-2",
      message: { id: "message-1", role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "Looking now." }, { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }] },
    },
    {
      type: "user", timestamp: "2026-08-01T00:00:03Z", sessionId: "claude-1", uuid: "result-1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "'/repo'" }] },
    },
  ), "claude.jsonl");

  assert.equal(transcript.provider, "claude");
  assert.equal(transcript.id, "claude-1");
  assert.equal(transcript.cwd, "/repo");
  assert.equal(transcript.session.gitBranch, "main");
  assert.equal(transcript.session.cliVersion, "2.1.0");
  assert.deepEqual(transcript.entries.map((entry) => [entry.kind, entry.label]), [
    ["user", "You"],
    ["notice", "Thinking"],
    ["assistant", "Claude"],
    ["tool", "Bash"],
    ["result", "Tool result"],
  ]);
});

test("counts Claude usage once when one model response spans several JSONL records", () => {
  const usage = { input_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 8, output_tokens: 12 };
  const transcript = parseClaudeSession(session(
    {
      type: "user", timestamp: "2026-08-01T00:00:00Z", sessionId: "claude-1", uuid: "prompt-1",
      message: { role: "user", content: "Do work" },
    },
    {
      type: "assistant", timestamp: "2026-08-01T00:00:01Z", sessionId: "claude-1", uuid: "response-1",
      message: { id: "message-1", role: "assistant", model: "claude-opus-4-8", usage, content: [{ type: "thinking", thinking: "Plan" }] },
    },
    {
      type: "assistant", timestamp: "2026-08-01T00:00:02Z", sessionId: "claude-1", uuid: "response-2",
      message: { id: "message-1", role: "assistant", model: "claude-opus-4-8", usage, content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] },
    },
  ), "claude.jsonl");

  assert.equal(transcript.usageEvents.length, 1);
  assert.deepEqual(transcript.usageEvents[0], {
    ts: "2026-08-01T00:00:01Z",
    input: 3,
    cachedInput: 40,
    cacheWrite: 8,
    output: 12,
    reasoning: 0,
    total: 63,
  });
  assert.deepEqual(transcript.turnContexts.map((context) => context.model), ["claude-opus-4-8"]);
});

test("accepts Claude's standard JSON loglines format", () => {
  const transcript = parseClaudeSession(JSON.stringify({
    loglines: [
      { type: "user", timestamp: "2026-08-01T00:00:00Z", message: { role: "user", content: "Hello" } },
      { type: "assistant", timestamp: "2026-08-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
    ],
  }), "claude.json");

  assert.deepEqual(transcript.entries.map((entry) => entry.content), ["Hello", "Hi"]);
  assert.equal(transcript.provider, "claude");
  assert.equal(transcript.filename, "claude.json");
});
