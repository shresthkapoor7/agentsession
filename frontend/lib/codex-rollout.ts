export type EntryKind = "user" | "assistant" | "tool" | "result" | "notice";

export type TranscriptEntry = {
  content: string;
  kind: EntryKind;
  label: string;
  timestamp: string;
};

export type TokenUsage = {
  cachedInput: number;
  cacheWrite: number;
  input: number;
  output: number;
  reasoning: number;
  total: number;
};

type UsageEvent = TokenUsage & { ts: string };

type SessionTurn = {
  completedAt: string | null;
  durationMs: number | null;
  id: string;
  startedAt: string;
  status: "completed" | "interrupted" | "running";
};

type TurnContext = {
  effort: string | null;
  model: string | null;
  ts: string;
  turnId: string | null;
};

type SessionDetails = {
  cliVersion: string | null;
  gitBranch: string | null;
  gitCommit: string | null;
  originator: string | null;
  source: string | null;
};

export type Transcript = {
  cwd: string | null;
  entries: TranscriptEntry[];
  id: string | null;
  filename: string;
  patchApplyCount: number;
  provider: "claude" | "codex";
  session: SessionDetails;
  systemRollout: Record<string, number>;
  systemEvent: Record<string, number>;
  systemResponse: Record<string, number>;
  turns: SessionTurn[];
  turnContexts: TurnContext[];
  usageEvents: UsageEvent[];
};

export type TranscriptExport = {
  content: string;
  filename: string;
};

const HANDLED_ROLLOUT = new Set(["session_meta", "event_msg", "response_item", "compacted", "turn_context"]);
const HANDLED_EVENT = new Set(["user_message", "agent_message", "context_compacted", "turn_aborted", "agent_reasoning", "agent_reasoning_raw_content", "token_count"]);
const HANDLED_ITEM = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call", "function_call_output", "custom_tool_call_output", "local_shell_call_output", "message", "reasoning"]);

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function prettyValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "(unavailable)";
  }
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageFromPayload(payload: Record<string, unknown>) {
  const info = payload.info;
  if (!info || typeof info !== "object") return null;
  const infoValues = info as Record<string, unknown>;
  const cumulative = infoValues.total_token_usage;
  const usage = cumulative ?? infoValues.last_token_usage;
  if (!usage || typeof usage !== "object") return null;
  const values = usage as Record<string, unknown>;
  const input = numberValue(values.input_tokens);
  const output = numberValue(values.output_tokens);
  return {
    cumulative: Boolean(cumulative && typeof cumulative === "object"),
    usage: {
      input,
      cachedInput: numberValue(values.cached_input_tokens),
      cacheWrite: numberValue(values.cache_write_input_tokens),
      output,
      reasoning: numberValue(values.reasoning_output_tokens),
      total: numberValue(values.total_tokens) || input + output,
    },
  };
}

function usageDelta(current: TokenUsage, previous: TokenUsage | null): TokenUsage {
  if (!previous || current.total < previous.total) return current;
  const delta = (key: keyof TokenUsage) => Math.max(0, current[key] - previous[key]);
  return {
    input: delta("input"),
    cachedInput: delta("cachedInput"),
    cacheWrite: delta("cacheWrite"),
    output: delta("output"),
    reasoning: delta("reasoning"),
    total: delta("total"),
  };
}

export function parseCodexRollout(raw: string, filename: string): Transcript {
  const entries: TranscriptEntry[] = [];
  let cwd: string | null = null;
  let id: string | null = null;
  const session: SessionDetails = { cliVersion: null, gitBranch: null, gitCommit: null, originator: null, source: null };
  const systemRollout: Record<string, number> = {};
  const systemEvent: Record<string, number> = {};
  const systemResponse: Record<string, number> = {};
  const usageEvents: UsageEvent[] = [];
  const abortedTurnIds = new Set<string>();
  let previousUsage: TokenUsage | null = null;
  const turns = new Map<string, SessionTurn>();
  const turnContexts: TurnContext[] = [];
  let patchApplyCount = 0;
  const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let record: { timestamp?: unknown; type?: unknown; payload?: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = stringValue(record.timestamp);
    const payload = record.payload;
    if (!timestamp || !payload || typeof payload !== "object") continue;
    const data = payload as Record<string, unknown>;

    if (record.type === "session_meta") {
      cwd = stringValue(data.cwd) || cwd;
      id = stringValue(data.id) || id;
      session.cliVersion = stringValue(data.cli_version) || session.cliVersion;
      session.originator = stringValue(data.originator) || session.originator;
      session.source = stringValue(data.source) || session.source;
      const git = data.git;
      if (git && typeof git === "object") {
        session.gitBranch = stringValue((git as Record<string, unknown>).branch) || session.gitBranch;
        session.gitCommit = stringValue((git as Record<string, unknown>).commit_hash) || session.gitCommit;
      }
      continue;
    }

    if (record.type === "event_msg") {
      const eventType = stringValue(data.type);
      const message = stringValue(data.message);
      if (eventType === "user_message" && message.trim()) {
        entries.push({ content: message, kind: "user", label: "You", timestamp });
      } else if (eventType === "agent_message" && message.trim()) {
        entries.push({ content: message, kind: "assistant", label: "Codex", timestamp });
      } else if (eventType === "context_compacted") {
        entries.push({ content: "Context compacted", kind: "notice", label: "Session", timestamp });
      } else if (eventType === "turn_aborted") {
        const reason = stringValue(data.reason);
        entries.push({ content: reason ? `Turn aborted: ${reason}` : "Turn aborted", kind: "notice", label: "Session", timestamp });
        const turnId = stringValue(data.turn_id);
        if (turnId) abortedTurnIds.add(turnId);
      } else if (eventType === "token_count") {
        const snapshot = usageFromPayload(data);
        if (snapshot) {
          usageEvents.push({ ts: timestamp, ...(snapshot.cumulative ? usageDelta(snapshot.usage, previousUsage) : snapshot.usage) });
          previousUsage = snapshot.cumulative ? snapshot.usage : null;
        }
      } else if (eventType === "task_started") {
        const turnId = stringValue(data.turn_id) || `unknown-${timestamp}`;
        turns.set(turnId, { id: turnId, startedAt: timestamp, completedAt: null, durationMs: null, status: "running" });
      } else if (eventType === "task_complete") {
        const turnId = stringValue(data.turn_id);
        const existing = turns.get(turnId);
        if (existing) {
          existing.completedAt = timestamp;
          existing.durationMs = numberValue(data.duration_ms) || null;
          existing.status = "completed";
        }
      } else if (eventType === "patch_apply_end") {
        patchApplyCount += 1;
      } else if (!HANDLED_EVENT.has(eventType)) {
        bump(systemEvent, eventType || "(missing)");
      }
      continue;
    }

    if (record.type !== "response_item") {
      const rolloutType = stringValue(record.type);
      if (rolloutType === "turn_context") {
        turnContexts.push({
          ts: timestamp,
          turnId: stringValue(data.turn_id) || null,
          model: stringValue(data.model) || null,
          effort: stringValue(data.effort) || null,
        });
      } else if (rolloutType && !HANDLED_ROLLOUT.has(rolloutType)) {
        bump(systemRollout, rolloutType);
      }
      continue;
    }

    const itemType = stringValue(data.type);
    if (["function_call", "custom_tool_call", "local_shell_call", "web_search_call"].includes(itemType)) {
      const name = stringValue(data.name) || itemType;
      const input = data.arguments ?? data.input ?? data;
      entries.push({ content: prettyValue(input), kind: "tool", label: name, timestamp });
    } else if (["function_call_output", "custom_tool_call_output", "local_shell_call_output"].includes(itemType)) {
      const output = data.output ?? data.content ?? data;
      entries.push({ content: prettyValue(output), kind: "result", label: "Tool result", timestamp });
    } else if (!HANDLED_ITEM.has(itemType)) {
      bump(systemResponse, itemType || "(missing)");
    }
  }

  if (!id && entries.length === 0) {
    throw new Error("This file does not contain readable Codex rollout records.");
  }

  for (const turn of turns.values()) {
    if (turn.status === "running" && abortedTurnIds.has(turn.id)) turn.status = "interrupted";
  }

  return {
    cwd, entries, filename, id, patchApplyCount, provider: "codex", session, systemRollout, systemEvent, systemResponse,
    turns: [...turns.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    turnContexts: turnContexts.sort((a, b) => a.ts.localeCompare(b.ts)),
    usageEvents: usageEvents.sort((a, b) => a.ts.localeCompare(b.ts)),
  };
}

export function createTranscriptExport(transcript: Transcript): TranscriptExport {
  const basename = transcript.filename.replace(/\.jsonl$/i, "") || "transcript";
  return {
    filename: `${basename}.agentsession.json`,
    content: JSON.stringify({ format: "agentsession.transcript.v1", transcript }, null, 2),
  };
}
