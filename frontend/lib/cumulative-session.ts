import type { Transcript } from "./codex-rollout.ts";

function sumCounts(transcripts: Transcript[], field: "systemEvent" | "systemResponse" | "systemRollout") {
  const counts: Record<string, number> = {};
  for (const transcript of transcripts) {
    for (const [key, value] of Object.entries(transcript[field])) counts[key] = (counts[key] ?? 0) + value;
  }
  return counts;
}

export function createCumulativeCodexSession(transcripts: Transcript[]): Transcript {
  if (!transcripts.length || transcripts.some((transcript) => transcript.provider !== "codex")) {
    throw new Error("A cumulative Codex session requires one or more Codex transcripts.");
  }

  return {
    cwd: null,
    entries: transcripts.flatMap((transcript) => transcript.entries),
    filename: "Cumulative Codex sessions",
    id: null,
    patchApplyCount: transcripts.reduce((total, transcript) => total + transcript.patchApplyCount, 0),
    provider: "codex",
    session: { cliVersion: null, gitBranch: null, gitCommit: null, originator: "Cumulative Codex sessions", source: `${transcripts.length} local sessions` },
    systemEvent: sumCounts(transcripts, "systemEvent"),
    systemResponse: sumCounts(transcripts, "systemResponse"),
    systemRollout: sumCounts(transcripts, "systemRollout"),
    turns: transcripts.flatMap((transcript, index) => transcript.turns.map((turn) => ({ ...turn, id: `${index}:${turn.id}` }))).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    turnContexts: transcripts.flatMap((transcript) => transcript.turnContexts).sort((a, b) => a.ts.localeCompare(b.ts)),
    usageEvents: transcripts.flatMap((transcript) => transcript.usageEvents).sort((a, b) => a.ts.localeCompare(b.ts)),
  };
}
