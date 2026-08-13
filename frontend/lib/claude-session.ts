import type { TokenUsage, Transcript, TranscriptEntry } from "./codex-rollout.ts";

type ClaudeRecord = {
  cwd?: unknown;
  gitBranch?: unknown;
  isCompactSummary?: unknown;
  isMeta?: unknown;
  message?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  type?: unknown;
  uuid?: unknown;
  version?: unknown;
};

type ClaudeMessage = {
  content?: unknown;
  id?: unknown;
  model?: unknown;
  usage?: unknown;
};

type ClaudeContentBlock = {
  content?: unknown;
  id?: unknown;
  input?: unknown;
  is_error?: unknown;
  name?: unknown;
  text?: unknown;
  thinking?: unknown;
  type?: unknown;
};

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function objectValue<T extends object>(value: unknown): T | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as T : null;
}

function prettyValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "(unavailable)";
  }
}

function blockText(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    const block = objectValue<ClaudeContentBlock>(item);
    if (!block) return [];
    const text = stringValue(block.text) || stringValue(block.thinking);
    return text ? [text] : [];
  }).join("\n\n");
}

function usageFromMessage(message: ClaudeMessage): TokenUsage | null {
  const usage = objectValue<Record<string, unknown>>(message.usage);
  if (!usage) return null;
  const input = numberValue(usage.input_tokens);
  const cachedInput = numberValue(usage.cache_read_input_tokens);
  const cacheWrite = numberValue(usage.cache_creation_input_tokens);
  const output = numberValue(usage.output_tokens);
  return { input, cachedInput, cacheWrite, output, reasoning: 0, total: input + cachedInput + cacheWrite + output };
}

function parseRecords(raw: string): ClaudeRecord[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { loglines?: unknown };
      if (Array.isArray(parsed.loglines)) return parsed.loglines.filter((item): item is ClaudeRecord => Boolean(objectValue<ClaudeRecord>(item)));
    } catch {
      // Fall through to JSONL parsing.
    }
  }
  return raw.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const record = JSON.parse(line);
      return objectValue<ClaudeRecord>(record) ? [record as ClaudeRecord] : [];
    } catch {
      return [];
    }
  });
}

export function parseClaudeSession(raw: string, filename: string): Transcript {
  const entries: TranscriptEntry[] = [];
  const usageEvents: Transcript["usageEvents"] = [];
  const turnContexts: Transcript["turnContexts"] = [];
  const systemRollout: Record<string, number> = {};
  const seenMessageUsage = new Set<string>();
  const promptStarts: Array<{ id: string; startedAt: string }> = [];
  let cwd: string | null = null;
  let id: string | null = null;
  let gitBranch: string | null = null;
  let cliVersion: string | null = null;
  let lastTimestamp = "";
  const bump = (key: string) => { systemRollout[key] = (systemRollout[key] ?? 0) + 1; };

  for (const record of parseRecords(raw)) {
    const type = stringValue(record.type);
    const timestamp = stringValue(record.timestamp);
    if (!timestamp) {
      if (type) bump(type);
      continue;
    }
    lastTimestamp = timestamp;
    cwd = stringValue(record.cwd) || cwd;
    id = stringValue(record.sessionId) || id;
    gitBranch = stringValue(record.gitBranch) || gitBranch;
    cliVersion = stringValue(record.version) || cliVersion;

    if (type !== "user" && type !== "assistant") {
      bump(type || "(missing)");
      continue;
    }
    const message = objectValue<ClaudeMessage>(record.message);
    if (!message) {
      bump(`${type}:missing-message`);
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];

    if (type === "assistant") {
      const messageId = stringValue(message.id) || stringValue(record.uuid);
      const usage = usageFromMessage(message);
      if (usage && messageId && !seenMessageUsage.has(messageId)) {
        seenMessageUsage.add(messageId);
        usageEvents.push({ ts: timestamp, ...usage });
        turnContexts.push({ ts: timestamp, turnId: null, model: stringValue(message.model) || null, effort: null });
      }
    }

    for (const value of blocks) {
      const block = objectValue<ClaudeContentBlock>(value);
      if (!block) continue;
      const blockType = stringValue(block.type);
      if (type === "user" && blockType === "tool_result") {
        const result = blockText(block.content);
        if (result) entries.push({ content: result, kind: "result", label: "Tool result", timestamp });
        continue;
      }
      if (type === "user" && blockType === "text") {
        const content = stringValue(block.text);
        if (!content) continue;
        if (record.isMeta || record.isCompactSummary) {
          entries.push({ content, kind: "notice", label: "Session", timestamp });
        } else {
          entries.push({ content, kind: "user", label: "You", timestamp });
          promptStarts.push({ id: stringValue(record.uuid) || `prompt-${timestamp}`, startedAt: timestamp });
        }
        continue;
      }
      if (type === "assistant" && blockType === "text") {
        const content = stringValue(block.text);
        if (content) entries.push({ content, kind: "assistant", label: "Claude", timestamp });
        continue;
      }
      if (type === "assistant" && blockType === "thinking") {
        const content = stringValue(block.thinking);
        if (content) entries.push({ content, kind: "notice", label: "Thinking", timestamp });
        continue;
      }
      if (type === "assistant" && blockType === "tool_use") {
        entries.push({ content: prettyValue(block.input), kind: "tool", label: stringValue(block.name) || "Tool", timestamp });
        continue;
      }
      if (blockType && blockType !== "image") bump(`${type}:${blockType}`);
    }
  }

  if (!id && entries.length === 0) throw new Error("This file does not contain readable Claude Code session records.");

  return {
    cwd,
    entries,
    filename,
    id,
    patchApplyCount: 0,
    provider: "claude",
    session: { cliVersion, gitBranch, gitCommit: null, originator: "Claude Code", source: null },
    systemRollout,
    systemEvent: {},
    systemResponse: {},
    turns: promptStarts.map((turn, index) => {
      const completedAt = promptStarts[index + 1]?.startedAt ?? (lastTimestamp || turn.startedAt);
      return { ...turn, completedAt, durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(turn.startedAt)), status: "completed" as const };
    }),
    turnContexts,
    usageEvents,
  };
}
