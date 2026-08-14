import assert from "node:assert/strict";
import test from "node:test";

import { parseClaudeSession } from "../lib/claude-session.ts";
import { createCumulativeSession } from "../lib/cumulative-session.ts";
import { parseCodexRollout } from "../lib/codex-rollout.ts";
import { createSessionView } from "../lib/session-tabs.ts";

function jsonl(...records: object[]) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

function codexSession(id: string, total: number, filename: string) {
  return parseCodexRollout(jsonl(
    { timestamp: "2026-08-01T00:00:00Z", type: "session_meta", payload: { id } },
    { timestamp: "2026-08-01T00:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: total - 1, output_tokens: 1, total_tokens: total } } } },
  ), filename);
}

function claudeSession(id: string, total: number, filename: string) {
  return parseClaudeSession(jsonl(
    { type: "user", timestamp: "2026-08-01T00:00:00Z", sessionId: id, uuid: `prompt-${id}`, message: { role: "user", content: "Hello" } },
    { type: "assistant", timestamp: "2026-08-01T00:00:01Z", sessionId: id, message: { id: `message-${id}`, role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: total - 1, output_tokens: 1 }, content: [{ type: "text", text: "Hi" }] } },
  ), filename);
}

test("creates cumulative and individual tabs for multiple Codex sessions", () => {
  const sessions = [codexSession("codex-1", 20, "first.jsonl"), codexSession("codex-2", 30, "second.jsonl")];

  const cumulative = createSessionView(sessions, "cumulative");
  const second = createSessionView(sessions, 1);

  assert.ok(cumulative);
  assert.equal(cumulative.cumulative, true);
  assert.equal(cumulative.currentTranscript.provider, "codex");
  assert.equal(cumulative.currentTranscript.usageEvents.reduce((sum, event) => sum + event.total, 0), 50);
  assert.deepEqual(cumulative.sessionTabs.map((tab) => [tab.label, tab.active]), [["Cumulative (2)", true], ["first.jsonl", false], ["second.jsonl", false]]);
  assert.ok(second);
  assert.equal(second.cumulative, false);
  assert.equal(second.currentTranscript.filename, "second.jsonl");
  assert.deepEqual(second.sessionTabs.map((tab) => tab.active), [false, false, true]);
});

test("creates cumulative and individual tabs for multiple Claude sessions", () => {
  const sessions = [claudeSession("claude-1", 20, "first.jsonl"), claudeSession("claude-2", 30, "second.jsonl")];

  const cumulative = createSessionView(sessions, "cumulative");
  const first = createSessionView(sessions, 0);

  assert.ok(cumulative);
  assert.equal(cumulative.currentTranscript.provider, "claude");
  assert.equal(cumulative.currentTranscript.filename, "Cumulative Claude sessions");
  assert.ok(first);
  assert.equal(first.currentTranscript.filename, "first.jsonl");
  assert.equal(first.sessionTabs[1].active, true);
});

test("keeps one-session views tabless and falls back from invalid selected tabs", () => {
  const session = codexSession("codex-1", 20, "only.jsonl");

  const view = createSessionView([session], "cumulative");

  assert.ok(view);
  assert.equal(view.cumulative, false);
  assert.equal(view.showTabs, false);
  assert.deepEqual(view.sessionTabs, []);
  assert.equal(view.currentTranscript.filename, "only.jsonl");
  assert.equal(createSessionView([], 0), null);
});

test("refuses a cumulative session that mixes providers", () => {
  const codex = codexSession("codex-1", 20, "codex.jsonl");
  const claude = claudeSession("claude-1", 20, "claude.jsonl");

  assert.throws(() => createCumulativeSession([codex, claude]), /same provider/);
});
