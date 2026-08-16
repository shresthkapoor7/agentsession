import assert from "node:assert/strict";
import test from "node:test";

import type { Transcript } from "../lib/codex-rollout.ts";
import { metricsFor, publishSessions } from "../lib/publish-session.ts";

const transcript: Transcript = {
  cwd: "/private/project",
  entries: [
    { content: "secret transcript content", kind: "user", label: "You", timestamp: "2026-08-01T00:00:00Z" },
    { content: "done", kind: "assistant", label: "Codex", timestamp: "2026-08-01T00:00:01Z" },
    { content: "{}", kind: "tool", label: "exec", timestamp: "2026-08-01T00:00:02Z" },
  ],
  filename: "rollout.jsonl",
  id: "session-1",
  patchApplyCount: 2,
  provider: "codex",
  session: { cliVersion: null, gitBranch: null, gitCommit: null, originator: null, source: null },
  systemEvent: {},
  systemResponse: {},
  systemRollout: {},
  turnContexts: [{ effort: "high", model: "gpt-5.6-terra", ts: "2026-08-01T00:00:00Z", turnId: "turn-1" }],
  turns: [{ completedAt: "2026-08-01T00:00:03Z", durationMs: 3_000, id: "turn-1", startedAt: "2026-08-01T00:00:00Z", status: "completed" }],
  usageEvents: [{ cachedInput: 80, cacheWrite: 0, input: 100, output: 20, reasoning: 5, total: 120, ts: "2026-08-01T00:00:01Z" }],
};

test("derives only aggregate share metrics from loaded sessions", () => {
  assert.deepEqual(metricsFor([transcript]), {
    cached_tokens: 80,
    generated_tokens: 20,
    models: ["gpt-5.6-terra"],
    patches: 2,
    processed_tokens: 120,
    reasoning_tokens: 5,
    tasks: 1,
    tools: 1,
  });
});

test("rejects incomplete publish forms before any network call", async () => {
  const originalFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    return new Response();
  };
  try {
    await assert.rejects(
      publishSessions({ displayName: "", password: "", transcripts: [transcript], visibility: "public" }),
      /Enter the name/,
    );
    await assert.rejects(
      publishSessions({ displayName: "Ada", password: "short", transcripts: [transcript], visibility: "password" }),
      /at least 8 characters/,
    );
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploads encrypted bytes and puts the content key only in the share fragment", async () => {
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
  const originalFetch = globalThis.fetch;
  const requests: Array<{ body: BodyInit | null | undefined; url: string }> = [];
  process.env.NEXT_PUBLIC_API_URL = "https://api.agentsession.example";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ body: init?.body, url });
    if (url.endsWith("/v1/publish-intents")) {
      return Response.json({
        manage_token: "b".repeat(43),
        publish_intent_id: "d2719e8a-17c5-4b2a-9df4-58bd82f0e8f2",
        upload_headers: { "content-type": "application/octet-stream", "x-upsert": "false" },
        upload_method: "PUT",
        upload_url: "https://storage.example/upload",
        view_token: "a".repeat(43),
      });
    }
    if (url === "https://storage.example/upload") return new Response(null, { status: 200 });
    return Response.json({
      expires_at: "2026-08-22T00:00:00Z",
      manage_url: "https://agentsession.example/manage/manage-token",
      share_url: "https://agentsession.example/share/view-token",
    });
  };
  try {
    const share = await publishSessions({ displayName: "Ada", password: "", transcripts: [transcript], visibility: "public" });

    assert.match(share.share_url, /^https:\/\/agentsession\.example\/share\/view-token#k=[A-Za-z0-9_-]+$/);
    assert.equal(requests.length, 3);
    assert.equal(JSON.stringify(requests[0].body).includes("secret transcript content"), false);
    assert.ok(requests[1].body instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(requests[1].body as Uint8Array).includes("secret transcript content"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
  }
});
