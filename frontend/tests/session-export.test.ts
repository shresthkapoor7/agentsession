import assert from "node:assert/strict";
import test from "node:test";

import { createSessionArchive } from "../lib/session-export.ts";

function zipNames(bytes: Uint8Array) {
  const names: string[] = [];
  for (let offset = 0; offset + 4 <= bytes.length;) {
    const signature = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    if (signature !== 0x04034b50) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    names.push(new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength)));
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return names;
}

test("creates a shareable archive with an index and one source session", () => {
  const archive = createSessionArchive({
    assets: { css: "body{}", viewer: "" },
    indexHtml: '<a href="session.jsonl">Session</a>',
    provider: "codex",
    sessions: [{ content: '{"type":"session_meta"}\n', filename: "rollout.jsonl" }],
  });

  assert.equal(archive.downloadName, "agentsession-codex-sessions.zip");
  assert.deepEqual(archive.sessionFiles, ["session.jsonl"]);
  assert.deepEqual(zipNames(archive.bytes), [
    "agentsession-codex-sessions/",
    "agentsession-codex-sessions/index.html",
    "agentsession-codex-sessions/codex-transcripts.css",
    "agentsession-codex-sessions/codex-transcripts-viewer.js",
    "agentsession-codex-sessions/session.jsonl",
  ]);
});

test("numbers multiple sessions so they can be referenced from the shared index", () => {
  const archive = createSessionArchive({
    assets: { css: "", viewer: "" },
    indexHtml: '<a href="session-1.jsonl">One</a><a href="session-2.jsonl">Two</a>',
    provider: "claude",
    sessions: [{ content: "one", filename: "one.jsonl" }, { content: "two", filename: "two.jsonl" }],
  });

  assert.deepEqual(archive.sessionFiles, ["session-1.jsonl", "session-2.jsonl"]);
  assert.ok(zipNames(archive.bytes).includes("agentsession-claude-sessions/session-2.jsonl"));
});
