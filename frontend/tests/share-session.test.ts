import assert from "node:assert/strict";
import test from "node:test";

import { decryptSharedSessions } from "../lib/share-session.ts";

test("rejects an invalid share key before downloading the encrypted blob", async () => {
  const originalFetch = globalThis.fetch;
  let downloaded = false;
  globalThis.fetch = async () => {
    downloaded = true;
    return new Response();
  };
  try {
    await assert.rejects(
      decryptSharedSessions("https://storage.example/share", "not%base64"),
      /decryption key.*invalid/i,
    );
    assert.equal(downloaded, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
