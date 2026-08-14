import type { Transcript } from "./codex-rollout.ts";
import { createCumulativeSession } from "./cumulative-session.ts";

export type SessionTab = {
  active: boolean;
  label: string;
  value: number | "cumulative";
};

export type SessionView = {
  cumulative: boolean;
  currentTranscript: Transcript;
  sessionTabs: SessionTab[];
  showTabs: boolean;
};

export function createSessionView(transcripts: Transcript[], activeTab: number | "cumulative"): SessionView | null {
  if (!transcripts.length) return null;

  const showTabs = transcripts.length > 1;
  const cumulative = showTabs && activeTab === "cumulative";
  const selectedIndex = typeof activeTab === "number" && activeTab >= 0 && activeTab < transcripts.length ? activeTab : 0;

  return {
    cumulative,
    currentTranscript: cumulative ? createCumulativeSession(transcripts) : transcripts[selectedIndex],
    sessionTabs: showTabs
      ? [{ active: cumulative, label: `Cumulative (${transcripts.length})`, value: "cumulative" }, ...transcripts.map((transcript, index) => ({ active: !cumulative && selectedIndex === index, label: transcript.filename, value: index }))]
      : [],
    showTabs,
  };
}
