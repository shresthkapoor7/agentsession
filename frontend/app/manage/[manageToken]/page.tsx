"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { getApiUrl } from "@/lib/publish-session";

export default function ManageSharePage() {
  const { manageToken } = useParams<{ manageToken: string }>();
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [working, setWorking] = useState(false);

  async function revoke() {
    if (!window.confirm("Revoke this share? The link will stop working and its encrypted data will be deleted.")) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`${getApiUrl()}/v1/manage/${manageToken}/revoke`, { method: "POST" });
      const body = await response.json().catch(() => null) as { cleanup_pending?: boolean; detail?: string } | null;
      if (!response.ok) throw new Error(body?.detail ?? "The share could not be revoked.");
      setRevoked(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The share could not be revoked.");
    } finally {
      setWorking(false);
    }
  }

  return <main className="share-shell"><section className="share-card"><p className="share-eyebrow">Share management</p><h1>{revoked ? "Share revoked" : "Revoke this share"}</h1>{revoked ? <p>This link no longer works. The encrypted transcript is being deleted.</p> : <><p>Revoking immediately prevents further access. This cannot be undone.</p>{error ? <p className="share-error" role="alert">{error}</p> : null}<button className="share-danger" disabled={working} onClick={() => void revoke()} type="button">{working ? "Revoking…" : "Revoke share"}</button></>}</section></main>;
}
