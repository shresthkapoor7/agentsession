import type { TokenUsage, Transcript } from "@/lib/codex-rollout";

export type PublishVisibility = "public" | "password";

type ShareMetrics = {
  cached_tokens: number;
  generated_tokens: number;
  models: string[];
  patches: number;
  processed_tokens: number;
  reasoning_tokens: number;
  tasks: number;
  tools: number;
};

type PublishIntent = {
  manage_token: string;
  publish_intent_id: string;
  upload_headers: Record<string, string>;
  upload_method: string;
  upload_url: string;
  view_token: string;
};

type PublishComplete = {
  expires_at: string;
  manage_url: string;
  share_url: string;
};

export type PublishedShare = PublishComplete & {
  share_url: string;
};

const encoder = new TextEncoder();

export function getApiUrl() {
  const value = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "");
  if (!value) throw new Error("Publishing is not configured. Set NEXT_PUBLIC_API_URL for this deployment.");
  return value;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function responseJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const detail = await response.json().then((body: { detail?: unknown }) =>
    typeof body.detail === "string" ? body.detail : null,
  ).catch(() => null);
  throw new Error(detail ?? `Request failed (${response.status}).`);
}

async function gzip(bytes: Uint8Array) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("This browser cannot compress a transcript for publishing. Use a current browser version.");
  }
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encryptPayload(payload: unknown) {
  const compressed = await gzip(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, compressed));
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const blob = new Uint8Array(1 + iv.length + ciphertext.length);
  blob[0] = 1;
  blob.set(iv, 1);
  blob.set(ciphertext, 1 + iv.length);
  return { blob, key: base64Url(rawKey) };
}

function usageFor(transcripts: Transcript[]) {
  return transcripts.reduce<TokenUsage>((total, transcript) => transcript.usageEvents.reduce<TokenUsage>((usage, event) => ({
    input: usage.input + event.input,
    cachedInput: usage.cachedInput + event.cachedInput,
    cacheWrite: usage.cacheWrite + event.cacheWrite,
    output: usage.output + event.output,
    reasoning: usage.reasoning + event.reasoning,
    total: usage.total + event.total,
  }), total), { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
}

export function metricsFor(transcripts: Transcript[]): ShareMetrics {
  const usage = usageFor(transcripts);
  const models = [...new Set(transcripts.flatMap((transcript) => transcript.turnContexts.flatMap((context) => context.model ? [context.model] : [])))].slice(0, 20);
  return {
    cached_tokens: usage.cachedInput,
    generated_tokens: usage.output,
    models,
    patches: transcripts.reduce((total, transcript) => total + transcript.patchApplyCount, 0),
    processed_tokens: usage.total,
    reasoning_tokens: usage.reasoning,
    tasks: transcripts.reduce((total, transcript) => total + transcript.turns.filter((turn) => turn.status === "completed").length, 0),
    tools: transcripts.reduce((total, transcript) => total + transcript.entries.filter((entry) => entry.kind === "tool").length, 0),
  };
}

export async function publishSessions({ displayName, password, transcripts, visibility }: {
  displayName: string;
  password: string;
  transcripts: Transcript[];
  visibility: PublishVisibility;
}): Promise<PublishedShare> {
  if (!transcripts.length) throw new Error("Load a session before publishing.");
  const provider = transcripts[0].provider;
  if (transcripts.some((transcript) => transcript.provider !== provider)) {
    throw new Error("A share can contain only one provider at a time.");
  }
  if (!displayName.trim()) throw new Error("Enter the name you want shown on the share.");
  if (visibility === "password" && password.length < 8) {
    throw new Error("Use a password with at least 8 characters.");
  }

  const encrypted = await encryptPayload({
    format: "agentsession.share.v1",
    provider,
    published_at: new Date().toISOString(),
    transcripts,
  });
  const baseUrl = getApiUrl();
  const intent = await responseJson<PublishIntent>(await fetch(`${baseUrl}/v1/publish-intents`, {
    body: JSON.stringify({
      compressed_bytes: encrypted.blob.byteLength,
      display_name: displayName.trim(),
      metrics: metricsFor(transcripts),
      password: visibility === "password" ? password : null,
      provider,
      schema_version: 1,
      visibility,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));

  const upload = await fetch(intent.upload_url, {
    body: encrypted.blob,
    headers: intent.upload_headers,
    method: intent.upload_method,
  });
  if (!upload.ok) throw new Error("The encrypted transcript could not be uploaded. Please try again.");

  const complete = await responseJson<PublishComplete>(await fetch(`${baseUrl}/v1/publish-intents/${intent.publish_intent_id}/complete`, {
    body: JSON.stringify({ manage_token: intent.manage_token, view_token: intent.view_token }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));
  const url = new URL(complete.share_url);
  url.hash = `k=${encrypted.key}`;
  return { ...complete, share_url: url.toString() };
}
