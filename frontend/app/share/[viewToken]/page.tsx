"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { viewerDocument } from "@/app/page";
import type { Transcript } from "@/lib/codex-rollout";
import { getApiUrl } from "@/lib/publish-session";
import { decryptSharedSessions } from "@/lib/share-session";
import { createSessionView } from "@/lib/session-tabs";

type ShareInfo = {
  download_url?: string;
  metadata: { display_name: string; expires_at: string; provider: "claude" | "codex" };
  requires_password: boolean;
};

async function getShare(token: string, password?: string) {
  const url = `${getApiUrl()}/v1/shares/${token}${password === undefined ? "" : "/unlock"}`;
  const response = await fetch(url, password === undefined ? undefined : {
    body: JSON.stringify({ password }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.json().catch(() => null) as (ShareInfo & { detail?: string }) | null;
  if (!response.ok) throw new Error(body?.detail ?? "This share is unavailable.");
  return body as ShareInfo;
}

export default function SharedTranscriptPage() {
  const params = useParams<{ viewToken: string }>();
  const token = params.viewToken;
  const [activeTab, setActiveTab] = useState<number | "cumulative">(0);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const frame = useRef<HTMLIFrameElement>(null);

  async function load(passwordValue?: string) {
    setLoading(true);
    setError(null);
    try {
      const nextInfo = await getShare(token, passwordValue);
      setInfo(nextInfo);
      if (nextInfo.requires_password) return;
      const key = new URLSearchParams(window.location.hash.slice(1)).get("k");
      if (!key) throw new Error("The decryption key is missing. Open the complete share link.");
      if (!nextInfo.download_url) throw new Error("The share download is unavailable.");
      const next = await decryptSharedSessions(nextInfo.download_url, key);
      setTranscripts(next);
      setActiveTab(next.length > 1 ? "cumulative" : 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This share could not be opened.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handleTab(event: MessageEvent<unknown>) {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { source?: unknown; tab?: unknown; type?: unknown } | null;
      if (data?.source !== "agentsession" || data.type !== "session-tab") return;
      if (data.tab === "cumulative") setActiveTab("cumulative");
      else if (typeof data.tab === "string" && /^\d+$/.test(data.tab) && Number(data.tab) < transcripts.length) setActiveTab(Number(data.tab));
    }
    window.addEventListener("message", handleTab);
    return () => window.removeEventListener("message", handleTab);
  }, [transcripts.length]);

  const view = createSessionView(transcripts, activeTab);
  if (view) return <iframe className="codex-transcript-frame" ref={frame} srcDoc={viewerDocument(view.currentTranscript, { allowAddSessions: false, publishable: false, sessionCount: transcripts.length, sessionTabs: view.sessionTabs, sharedBy: info?.metadata.display_name ?? null, sourceSessions: view.cumulative ? transcripts : [], summaryOnly: view.cumulative })} title="Shared transcript" />;
  if (info?.requires_password) return <main className="share-shell"><section className="share-card"><p className="share-eyebrow">Password protected</p><h1>{info.metadata.display_name}&rsquo;s session</h1><p>Enter the password to open this encrypted transcript.</p><form onSubmit={(event) => { event.preventDefault(); void load(password); }}><label>Password<input autoFocus onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>{error ? <p className="share-error" role="alert">{error}</p> : null}<button type="submit">{loading ? "Opening…" : "Open transcript"}</button></form></section></main>;
  return <main className="share-shell"><section className="share-card"><p className="share-eyebrow">Encrypted share</p><h1>{loading ? "Opening shared session…" : "This share is unavailable"}</h1>{error ? <p className="share-error" role="alert">{error}</p> : <p>Loading the encrypted transcript in your browser.</p>}</section></main>;
}
