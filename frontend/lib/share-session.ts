import type { Transcript } from "@/lib/codex-rollout";

const decoder = new TextDecoder();

class SharePayloadError extends Error {}

type SharedPayload = {
  format: "agentsession.share.v1";
  transcripts: Transcript[];
};

function base64UrlBytes(value: string) {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new SharePayloadError("The decryption key in this link is invalid.");
  }
}

function isTranscript(value: unknown): value is Transcript {
  if (!value || typeof value !== "object") return false;
  const transcript = value as Partial<Transcript>;
  return (transcript.provider === "codex" || transcript.provider === "claude")
    && Array.isArray(transcript.entries)
    && Array.isArray(transcript.usageEvents)
    && Array.isArray(transcript.turns)
    && Array.isArray(transcript.turnContexts);
}

export async function decryptSharedSessions(downloadUrl: string, keyFragment: string): Promise<Transcript[]> {
  try {
    const keyBytes = base64UrlBytes(keyFragment);
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error("The encrypted share could not be downloaded. Refresh the link and try again.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 30 || bytes[0] !== 1) throw new SharePayloadError("This share uses an unsupported encrypted format.");
    if (typeof DecompressionStream === "undefined") throw new SharePayloadError("This browser cannot open encrypted transcript shares. Use a current browser version.");
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const compressed = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(1, 13) }, key, bytes.slice(13));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const payload = JSON.parse(decoder.decode(await new Response(stream).arrayBuffer())) as Partial<SharedPayload>;
    if (payload.format !== "agentsession.share.v1" || !Array.isArray(payload.transcripts) || !payload.transcripts.every(isTranscript)) {
      throw new SharePayloadError("This link does not contain a supported agentsession share.");
    }
    return payload.transcripts;
  } catch (caught) {
    if (caught instanceof SharePayloadError) throw caught;
    throw new Error("This share cannot be decrypted. Make sure you opened the complete share link.");
  }
}
