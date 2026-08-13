import assert from "node:assert/strict";
import test from "node:test";

import { createTranscriptExport, parseCodexRollout } from "../lib/codex-rollout.ts";

function rollout(...records: object[]) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

function event(timestamp: string, payload: Record<string, unknown>) {
  return { timestamp, type: "event_msg", payload };
}

test("parses transcript entries, tools, and session metadata", () => {
  const transcript = parseCodexRollout(rollout(
    { timestamp: "2026-08-01T00:00:00Z", type: "session_meta", payload: { id: "session-1", cwd: "/repo", cli_version: "1.0.0", git: { branch: "main", commit_hash: "abcdef123456" } } },
    event("2026-08-01T00:00:01Z", { type: "user_message", message: "Hello" }),
    { timestamp: "2026-08-01T00:00:02Z", type: "response_item", payload: { type: "function_call", name: "exec", arguments: { cmd: "pwd" } } },
    { timestamp: "2026-08-01T00:00:03Z", type: "response_item", payload: { type: "function_call_output", output: "/repo" } },
    event("2026-08-01T00:00:04Z", { type: "agent_message", message: "Done" }),
  ), "rollout.jsonl");

  assert.equal(transcript.id, "session-1");
  assert.equal(transcript.cwd, "/repo");
  assert.equal(transcript.session.gitBranch, "main");
  assert.deepEqual(transcript.entries.map((entry) => entry.kind), ["user", "tool", "result", "assistant"]);
});

test("converts cumulative token snapshots into non-overlapping deltas", () => {
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: input - 20,
    output_tokens: output,
    reasoning_output_tokens: output - 5,
    total_tokens: input + output,
  });
  const transcript = parseCodexRollout(rollout(
    { timestamp: "2026-08-01T00:00:00Z", type: "session_meta", payload: { id: "session-1" } },
    event("2026-08-01T00:00:01Z", { type: "token_count", info: { total_token_usage: usage(100, 20) } }),
    event("2026-08-01T00:00:02Z", { type: "token_count", info: { total_token_usage: usage(220, 50) } }),
  ), "rollout.jsonl");

  assert.deepEqual(transcript.usageEvents.map((item) => item.total), [120, 150]);
  assert.equal(transcript.usageEvents.reduce((sum, item) => sum + item.total, 0), 270);
  assert.deepEqual(transcript.usageEvents.map((item) => item.input), [100, 120]);
});

test("retains legacy final token snapshots when no cumulative total exists", () => {
  const transcript = parseCodexRollout(rollout(
    { timestamp: "2026-08-01T00:00:00Z", type: "session_meta", payload: { id: "session-1" } },
    event("2026-08-01T00:00:01Z", { type: "token_count", info: { last_token_usage: { input_tokens: 40, output_tokens: 7, total_tokens: 47 } } }),
  ), "rollout.jsonl");

  assert.equal(transcript.usageEvents[0].total, 47);
});

test("keeps unknown Codex record types visible as system counts", () => {
  const transcript = parseCodexRollout(rollout(
    { timestamp: "2026-08-01T00:00:00Z", type: "session_meta", payload: { id: "session-1" } },
    event("2026-08-01T00:00:01Z", { type: "new_event" }),
    { timestamp: "2026-08-01T00:00:02Z", type: "response_item", payload: { type: "new_item" } },
    { timestamp: "2026-08-01T00:00:03Z", type: "new_record", payload: {} },
  ), "rollout.jsonl");

  assert.deepEqual(transcript.systemEvent, { new_event: 1 });
  assert.deepEqual(transcript.systemResponse, { new_item: 1 });
  assert.deepEqual(transcript.systemRollout, { new_record: 1 });
});

test("marks only the turn named by an abort event as interrupted", () => {
  const transcript = parseCodexRollout(rollout(
    { timestamp: "2026-08-01T00:00:00Z", type: "session_meta", payload: { id: "session-1" } },
    event("2026-08-01T00:00:01Z", { type: "task_started", turn_id: "turn-a" }),
    event("2026-08-01T00:00:02Z", { type: "task_started", turn_id: "turn-b" }),
    event("2026-08-01T00:00:03Z", { type: "turn_aborted", turn_id: "turn-a", reason: "interrupted" }),
  ), "rollout.jsonl");

  assert.deepEqual(transcript.turns.map((turn) => [turn.id, turn.status]), [["turn-a", "interrupted"], ["turn-b", "running"]]);
});

test("preserves web search calls as tool entries", () => {
  const transcript = parseCodexRollout(rollout(
    { timestamp: "2026-08-01T00:00:00Z", type: "session_meta", payload: { id: "session-1" } },
    { timestamp: "2026-08-01T00:00:01Z", type: "response_item", payload: { type: "web_search_call", action: { type: "search", query: "Codex docs" } } },
  ), "rollout.jsonl");

  assert.deepEqual(transcript.entries.map((entry) => [entry.kind, entry.label]), [["tool", "web_search_call"]]);
  assert.deepEqual(transcript.systemResponse, {});
});

test("exports a versioned normalized transcript with format-change counts", () => {
  const transcript = parseCodexRollout(rollout(
    { timestamp: "2026-08-01T00:00:00Z", type: "session_meta", payload: { id: "session-1" } },
    event("2026-08-01T00:00:01Z", { type: "new_event" }),
  ), "rollout.jsonl");
  const exported = createTranscriptExport(transcript);
  const payload = JSON.parse(exported.content) as { format: string; transcript: typeof transcript };

  assert.equal(exported.filename, "rollout.agentsession.json");
  assert.equal(payload.format, "agentsession.transcript.v1");
  assert.deepEqual(payload.transcript.systemEvent, { new_event: 1 });
});
