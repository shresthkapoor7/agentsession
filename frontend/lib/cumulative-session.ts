import type { Transcript } from "./codex-rollout.ts";

function sumCounts(transcripts: Transcript[], field: "systemEvent" | "systemResponse" | "systemRollout") {
  const counts: Record<string, number> = {};
  for (const transcript of transcripts) {
    for (const [key, value] of Object.entries(transcript[field])) counts[key] = (counts[key] ?? 0) + value;
  }
  return counts;
}

export function createCumulativeSession(transcripts: Transcript[]): Transcript {
  const provider = transcripts[0]?.provider;
  if (!provider || transcripts.some((transcript) => transcript.provider !== provider)) {
    throw new Error("A cumulative session requires one or more transcripts from the same provider.");
  }
  const providerName = provider === "claude" ? "Claude" : "Codex";

  return {
    cwd: null,
    entries: transcripts.flatMap((transcript) => transcript.entries),
    filename: `Cumulative ${providerName} sessions`,
    id: null,
    patchApplyCount: transcripts.reduce((total, transcript) => total + transcript.patchApplyCount, 0),
    provider,
    session: { cliVersion: null, gitBranch: null, gitCommit: null, originator: `Cumulative ${providerName} sessions`, source: `${transcripts.length} local ${providerName} sessions` },
    systemEvent: sumCounts(transcripts, "systemEvent"),
    systemResponse: sumCounts(transcripts, "systemResponse"),
    systemRollout: sumCounts(transcripts, "systemRollout"),
    turns: transcripts.flatMap((transcript, index) => transcript.turns.map((turn) => ({ ...turn, id: `${index}:${turn.id}` }))).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    turnContexts: transcripts.flatMap((transcript, index) => transcript.turnContexts.map((context) => ({
      ...context,
      turnId: context.turnId == null ? context.turnId : `${index}:${context.turnId}`,
    }))).sort((a, b) => a.ts.localeCompare(b.ts)),
    usageEvents: transcripts.flatMap((transcript) => transcript.usageEvents).sort((a, b) => a.ts.localeCompare(b.ts)),
  };
}
