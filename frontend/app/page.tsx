"use client";

import { useRef, useState } from "react";

type EntryKind = "user" | "assistant" | "tool" | "result" | "notice";

type TranscriptEntry = {
  content: string;
  kind: EntryKind;
  label: string;
  timestamp: string;
};

type TokenUsage = {
  cachedInput: number;
  cacheWrite: number;
  input: number;
  output: number;
  reasoning: number;
  total: number;
};

type UsageEvent = TokenUsage & { ts: string };

type UsageSnapshot = {
  cumulative: boolean;
  usage: TokenUsage;
};

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

type Transcript = {
  cwd: string | null;
  entries: TranscriptEntry[];
  id: string | null;
  filename: string;
  patchApplyCount: number;
  session: SessionDetails;
  systemRollout: Record<string, number>;
  systemEvent: Record<string, number>;
  systemResponse: Record<string, number>;
  turns: SessionTurn[];
  turnContexts: TurnContext[];
  usageEvents: UsageEvent[];
};

// Record types the CLI viewer renders/handles (so they are NOT counted as
// "system/internal records"). Kept in sync with src/codex_transcripts/rollout.py.
const HANDLED_ROLLOUT = new Set(["session_meta", "event_msg", "response_item", "compacted", "turn_context"]);
const HANDLED_EVENT = new Set(["user_message", "agent_message", "context_compacted", "turn_aborted", "agent_reasoning", "agent_reasoning_raw_content", "token_count"]);
const HANDLED_ITEM = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call", "function_call_output", "custom_tool_call_output", "local_shell_call_output", "message", "reasoning"]);

type FilePickerHandle = { getFile: () => Promise<File>; name: string };
type FilePickerWindow = Window & {
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FilePickerHandle[]>;
};

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

function usageFromPayload(payload: Record<string, unknown>): UsageSnapshot | null {
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

function parseCodexRollout(raw: string, filename: string): Transcript {
  const entries: TranscriptEntry[] = [];
  let cwd: string | null = null;
  let id: string | null = null;
  const session: SessionDetails = { cliVersion: null, gitBranch: null, gitCommit: null, originator: null, source: null };
  const systemRollout: Record<string, number> = {};
  const systemEvent: Record<string, number> = {};
  const systemResponse: Record<string, number> = {};
  const usageEvents: UsageEvent[] = [];
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
        entries.push({
          content: reason ? `Turn aborted: ${reason}` : "Turn aborted",
          kind: "notice",
          label: "Session",
          timestamp,
        });
        const turn = turns.get(stringValue(data.turn_id));
        if (turn) turn.status = "interrupted";
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
      }
      else if (rolloutType && !HANDLED_ROLLOUT.has(rolloutType)) bump(systemRollout, rolloutType);
      continue;
    }
    const itemType = stringValue(data.type);
    if (["function_call", "custom_tool_call", "local_shell_call"].includes(itemType)) {
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
    if (turn.status !== "running") continue;
    const aborted = entries.some((entry) => entry.kind === "notice" && entry.timestamp >= turn.startedAt && entry.content.toLowerCase().includes("turn aborted"));
    if (aborted) turn.status = "interrupted";
  }
  return {
    cwd, entries, filename, id, patchApplyCount, session, systemRollout, systemEvent, systemResponse,
    turns: [...turns.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    turnContexts: turnContexts.sort((a, b) => a.ts.localeCompare(b.ts)),
    usageEvents: usageEvents.sort((a, b) => a.ts.localeCompare(b.ts)),
  };
}

function groupConversation(entries: TranscriptEntry[]) {
  const groups: TranscriptEntry[][] = [];
  let current: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "user" && current.length) { groups.push(current); current = []; }
    current.push(entry);
  }
  if (current.length) groups.push(current);
  return groups;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Inline markdown: `code`, **bold**, *italic*, [text](url). Input is escaped first.
function renderInline(text: string) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

// Block-level markdown: fenced code blocks, headings, lists, paragraphs.
function renderMarkdown(source: string) {
  const codeBlocks: string[] = [];
  const withPlaceholders = source.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    const cleaned = code.replace(/^[a-zA-Z0-9_+-]*\n/, "").replace(/\n$/, "");
    codeBlocks.push(`<pre><code>${escapeHtml(cleaned)}</code></pre>`);
    return `CB${codeBlocks.length - 1}`;
  });
  const html = withPlaceholders.split(/\n{2,}/).map((block) => {
    if (/^CB\d+$/.test(block.trim())) return block.trim();
    const lines = block.split("\n");
    if (lines.length && lines.every((line) => /^\s*[-*]\s+/.test(line)))
      return `<ul>${lines.map((line) => `<li>${renderInline(line.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    if (lines.length && lines.every((line) => /^\s*\d+\.\s+/.test(line)))
      return `<ol>${lines.map((line) => `<li>${renderInline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
    const heading = block.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading && lines.length === 1) {
      const level = Math.min(6, heading[1].length);
      return `<h${level}>${renderInline(heading[2])}</h${level}>`;
    }
    return `<p>${lines.map(renderInline).join("<br>")}</p>`;
  }).join("");
  return html.replace(/CB(\d+)/g, (_m, index) => codeBlocks[Number(index)] ?? "");
}

function viewerMessageHtml(entry: TranscriptEntry, index: number) {
  const id = `msg-${index}`;
  const content = escapeHtml(entry.content);
  const body = entry.kind === "user" ? `<div class="user-content">${renderMarkdown(entry.content)}</div>`
    : entry.kind === "assistant" ? `<div class="assistant-text">${renderMarkdown(entry.content)}</div>`
    : entry.kind === "tool" ? `<div class="tool-use"><div class="tool-header"><span class="tool-icon">⚙</span>${escapeHtml(entry.label)}</div><pre>${content}</pre></div>`
    : entry.kind === "result" ? `<div class="tool-result"><pre>${content}</pre></div>`
    : `<div class="thinking"><div class="thinking-label">Session</div>${renderMarkdown(entry.content)}</div>`;
  const messageClass = entry.kind === "result" ? "tool-reply" : entry.kind === "notice" ? "system" : entry.kind;
  return `<div class="message ${messageClass}" id="${id}"><div class="message-content">${body}</div><div class="message-meta"><span class="role-label">${escapeHtml(entry.label)}</span><a href="#${id}" class="timestamp-link"><time datetime="${entry.timestamp}">${entry.timestamp}</time></a></div></div>`;
}

function viewerDocument(transcript: Transcript) {
  const groups = groupConversation(transcript.entries);
  const groupDurations = groups.map((group) => {
    const start = Date.parse(group[0].timestamp);
    const end = Date.parse(group[group.length - 1].timestamp);
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  });
  const taskDurations = groups.flatMap((group, index) => group.some((entry) => entry.kind === "user") ? [groupDurations[index]] : []);
  const durationLabel = (milliseconds: number) => {
    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  };
  const tokenLabel = (tokens: number) => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
    return String(tokens);
  };
  // Per-conversation metrics are assigned by their event timestamps.
  const groupStartMs = groups.map((group) => (group.length ? Date.parse(group[0].timestamp) : 0));
  const groupIndexForTs = (ts: string) => {
    const ms = Date.parse(ts);
    let idx = 0;
    for (let i = 0; i < groupStartMs.length; i++) { if (groupStartMs[i] <= ms) idx = i; else break; }
    return idx;
  };
  const aliasTool = (name: string) => {
    const lower = name.toLowerCase();
    if (["local_shell_call", "shell", "exec_command", "bash"].includes(lower)) return "exec";
    return name;
  };
  const groupFilters = groups.map((group, index) => {
    const tokenCount = transcript.usageEvents.reduce((total, event) =>
      groupIndexForTs(event.ts) === index ? total + event.total : total, 0);
    const tools = group.filter((entry) => entry.kind === "tool");
    return {
      duration_ms: groupDurations[index],
      token_count: tokenCount,
      tool_calls: tools.length,
      exec_count: tools.filter((entry) => aliasTool(entry.label) === "exec").length,
      interrupted: group.some((entry) => entry.kind === "notice" && entry.content.toLowerCase().includes("turn aborted")),
      context_compacted: group.some((entry) => entry.kind === "notice" && entry.content.toLowerCase().includes("context compacted")),
      commits: group.filter((entry) => entry.kind === "result").some((entry) => /\[[\w/-]+ [a-f0-9]{7,}\]/i.test(entry.content)) ? 1 : 0,
    };
  });
  const avgMs = taskDurations.length ? Math.floor(taskDurations.reduce((total, value) => total + value, 0) / taskDurations.length) : 0;
  const minMs = taskDurations.length ? Math.min(...taskDurations) : 0;
  const maxMs = taskDurations.length ? Math.max(...taskDurations) : 0;
  const items = transcript.entries.map(viewerMessageHtml);
  let start = 0;
  const summary = groups.map((group, index) => {
    const end = start + group.length - 1;
    const prompt = group.find((entry) => entry.kind === "user")?.content ?? "(session start)";
    const response = [...group].reverse().find((entry) => entry.kind === "assistant")?.content ?? "";
    const collapsed = response.replace(/\s+/g, " ").trim();
    const responsePreview = collapsed.slice(0, 600) + (collapsed.length > 600 ? "…" : "");
    const responseHtml = responsePreview
      ? `<div class="conversation-response"><span class="conversation-response-label">Codex</span><div class="conversation-response-text"><p>${renderInline(responsePreview)}</p></div></div>`
      : "";
    const counts: Record<string, number> = {};
    group.forEach((entry) => { if (entry.kind === "tool") { const name = aliasTool(entry.label); counts[name] = (counts[name] ?? 0) + 1; } });
    const statsStr = Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => `${count} ${name}`)
      .join(" · ");
    const durationMs = groupDurations[index];
    const tokens = groupFilters[index].token_count;
    const tokenLabel = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${Math.round(tokens / 1_000)}K` : String(tokens);
    const metaExtra = [statsStr, tokens ? `${tokenLabel} processed` : "", `⏱ ${durationLabel(durationMs)}`].filter(Boolean).join(" · ");
    const html = `<details class="conversation index-item" data-group-index="${index}" data-start="${start}" data-end="${end}"><summary class="conversation-summary" data-preview="${escapeHtml(prompt)}" data-label="#${index + 1}"><div class="index-item-content conversation-prompt"><p>${renderInline(prompt)}</p></div><div class="conversation-meta"><span class="index-item-number">#${index + 1}</span><span class="conversation-jump"><time datetime="${group[0].timestamp}">${group[0].timestamp}</time></span><span class="conversation-stats-line">· ${metaExtra}</span></div>${responseHtml}</summary><div class="conversation-body"><div class="conversation-messages" id="group-${index}"></div></div></details>`;
    start = end + 1;
    return html;
  }).join("");
  const noticeSection = (title: string, counts: Record<string, number>) =>
    Object.keys(counts).length
      ? `<div class="system-records-notice-section"><div class="system-records-notice-section-title">${title}</div><pre class="json">${escapeHtml(JSON.stringify(counts, null, 2))}</pre></div>`
      : "";
  const systemTotal = [transcript.systemRollout, transcript.systemEvent, transcript.systemResponse]
    .reduce((total, counts) => total + Object.values(counts).reduce((sum, value) => sum + value, 0), 0);
  const noticeHtml = systemTotal
    ? `<div class="system-records-notice"><div class="system-records-notice-title">System/internal records: ${systemTotal}</div><div class="system-records-notice-subtitle">Internal Codex records not shown in the transcript, grouped by type.</div><details><summary>Details (counts by type)</summary>${noticeSection("rollout", transcript.systemRollout)}${noticeSection("event_msg", transcript.systemEvent)}${noticeSection("response_item", transcript.systemResponse)}</details></div>`
    : "";
  const sortHtml = `<section class="conversation-sort" aria-label="Sort conversations"><span class="conversation-sort-heading">Sort by</span><div class="sort-controls" role="group"><button class="sort-btn active" data-field="index" type="button">Order<span class="sort-caret">↑</span></button><button class="sort-btn" data-field="tokens" type="button">Tokens<span class="sort-caret"></span></button><button class="sort-btn" data-field="duration" type="button">Time taken<span class="sort-caret"></span></button><button class="sort-btn" data-field="tools" type="button">Tool calls<span class="sort-caret"></span></button></div></section>`;
  const stat = (inner: string) => `<span class="stat">${inner}</span>`;
  const usage = transcript.usageEvents.reduce<TokenUsage>((total, event) => ({
    input: total.input + event.input,
    cachedInput: total.cachedInput + event.cachedInput,
    cacheWrite: total.cacheWrite + event.cacheWrite,
    output: total.output + event.output,
    reasoning: total.reasoning + event.reasoning,
    total: total.total + event.total,
  }), { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
  const completedTurns = transcript.turns.filter((turn) => turn.status === "completed");
  const interruptedTurns = transcript.turns.filter((turn) => turn.status === "interrupted");
  const activeMs = completedTurns.reduce((total, turn) => total + (turn.durationMs ?? 0), 0);
  const firstTurn = transcript.turns[0];
  const lastTurn = [...transcript.turns].reverse().find((turn) => turn.completedAt);
  const elapsedMs = firstTurn && lastTurn?.completedAt
    ? Math.max(0, Date.parse(lastTurn.completedAt) - Date.parse(firstTurn.startedAt)) : 0;
  const usageByTurn = completedTurns.map((turn, index) => {
    const startMs = Date.parse(turn.startedAt);
    const endMs = Date.parse(turn.completedAt ?? turn.startedAt);
    const processed = transcript.usageEvents.reduce((total, event) => {
      const eventMs = Date.parse(event.ts);
      return eventMs >= startMs && eventMs <= endMs ? total + event.total : total;
    }, 0);
    return { index: index + 1, processed, turn };
  });
  const peakTurn = Math.max(...usageByTurn.map((turn) => turn.processed), 1);
  const settings = new Map<string, number>();
  for (const context of transcript.turnContexts) {
    const name = [context.model, context.effort].filter(Boolean).join(" · ") || "Unavailable";
    settings.set(name, (settings.get(name) ?? 0) + 1);
  }
  const toolCounts = new Map<string, number>();
  for (const entry of transcript.entries) {
    if (entry.kind !== "tool") continue;
    const name = aliasTool(entry.label);
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }
  const metric = (label: string, value: string, detail: string) => `<article class="usage-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(detail)}</p></article>`;
  const bars = usageByTurn.length
    ? usageByTurn.map(({ index, processed, turn }) => `<div class="usage-bar-item"><span>${index}</span><div class="usage-bar-track"><div class="usage-bar" style="height:${Math.max(8, Math.round((processed / peakTurn) * 100))}%" title="Task ${index}: ${tokenLabel(processed)} processed tokens in ${durationLabel(turn.durationMs ?? 0)}"></div></div><b>${tokenLabel(processed)}</b></div>`).join("")
    : `<p class="usage-empty">No task-level usage is available in this session.</p>`;
  const settingsHtml = [...settings.entries()].map(([setting, count]) => `<li><code>${escapeHtml(setting)}</code><span>${count} turn${count === 1 ? "" : "s"}</span></li>`).join("") || "<li>Unavailable</li>";
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${count} ${escapeHtml(name)}`).join(" · ") || "No tool calls";
  const modelName = transcript.turnContexts.find((context) => context.model)?.model ?? "Model unavailable";
  const dashboardHtml = `<section class="usage-dashboard" aria-labelledby="usage-heading"><div class="usage-header"><div><p class="usage-eyebrow">Local session telemetry</p><h2 id="usage-heading">Session usage</h2><p>${escapeHtml(modelName)} · ${transcript.usageEvents.length} usage updates · cumulative deltas are summed.</p></div><span class="usage-status">${completedTurns.length} completed${interruptedTurns.length ? ` · ${interruptedTurns.length} interrupted` : ""}</span></div><div class="usage-metrics">${metric("Processed tokens", tokenLabel(usage.total), `${tokenLabel(usage.input)} input across updates`)}${metric("Cached input", tokenLabel(usage.cachedInput), `${usage.input ? ((usage.cachedInput / usage.input) * 100).toFixed(1) : "0.0"}% of observed input`)}${metric("Generated", tokenLabel(usage.output), `Includes ${tokenLabel(usage.reasoning)} reasoning`)}${metric("Active task time", durationLabel(activeMs), `${durationLabel(elapsedMs)} elapsed session time`)}</div><div class="usage-detail-grid"><figure class="usage-chart"><figcaption><div><p class="usage-eyebrow">Completed tasks</p><h3>Processed-token activity</h3></div><span>Peak update: ${tokenLabel(Math.max(...transcript.usageEvents.map((event) => event.total), 0))}</span></figcaption><div class="usage-bars" role="img" aria-label="Processed token totals by completed task">${bars}</div><p>Each bar sums cumulative-usage deltas recorded within that task. This includes input context and generated output.</p></figure><section class="usage-activity" aria-label="Session activity"><div><p class="usage-eyebrow">Activity</p><h3>${[...toolCounts.values()].reduce((sum, count) => sum + count, 0)} tool calls · ${transcript.patchApplyCount} patches</h3><p>${topTools}</p></div><div><p class="usage-eyebrow">Model settings</p><ul>${settingsHtml}</ul></div></section></div><details class="usage-details"><summary>Session details</summary><dl><div><dt>Working directory</dt><dd>${escapeHtml(transcript.cwd ?? "Unavailable")}</dd></div><div><dt>Source</dt><dd>${escapeHtml([transcript.session.originator, transcript.session.source].filter(Boolean).join(" · ") || "Unavailable")}</dd></div><div><dt>CLI version</dt><dd>${escapeHtml(transcript.session.cliVersion ?? "Unavailable")}</dd></div><div><dt>Git revision</dt><dd>${escapeHtml([transcript.session.gitBranch, transcript.session.gitCommit?.slice(0, 12)].filter(Boolean).join(" · ") || "Unavailable")}</dd></div></dl></details></section>`;
  const summaryHtml =
    dashboardHtml + `<div class="viewer-summary">` +
    stat(`<b>${groups.length}</b> conversations`) +
    stat(`<b>${items.length}</b> messages`) +
    (taskDurations.length
      ? stat(`⏱ avg <b>${durationLabel(avgMs)}</b>`) + stat(`min <b>${durationLabel(minMs)}</b>`) + stat(`max <b>${durationLabel(maxMs)}</b>`)
      : "") +
    `</div>`;
  const meta = { format: "codex-transcripts.viewer.v3", total: items.length, chunk_size: 200, chunks: [""], kinds: transcript.entries.map((entry) => entry.kind[0]).join(""), ids: items.map((_, index) => `msg-${index}`), ts: transcript.entries.map((entry) => entry.timestamp), groups: groups.map((group, index) => ({ start: groups.slice(0, index).reduce((total, item) => total + item.length, 0), end: groups.slice(0, index + 1).reduce((total, item) => total + item.length, 0) - 1, prompt: group.find((entry) => entry.kind === "user")?.content ?? null, filters: groupFilters[index] })) };
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/codex-transcripts.css"></head><body><div class="container"><div class="header-row"><h1>Codex transcript</h1><button id="cmdk-trigger" class="cmdk-trigger" type="button"><svg class="cmdk-trigger-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg><span class="cmdk-trigger-label">Search</span><kbd class="cmdk-trigger-kbd">⌘K</kbd></button></div><div class="summary-row">${summaryHtml}${sortHtml}</div>${noticeHtml}<nav id="side-nav" class="side-nav" aria-label="Jump between conversations"></nav><div id="conversations" class="conversations">${summary}</div><footer class="conversation-end" aria-label="End of session">End of session</footer><aside id="detail-pane" class="detail-pane" aria-hidden="true"><div class="detail-header"><span class="detail-role" id="detail-role"></span><span class="detail-time" id="detail-time"></span><button class="detail-close" id="detail-close">×</button></div><div class="detail-body" id="detail-body"></div></aside><dialog id="cmdk" class="cmdk"><div class="cmdk-box"><div class="cmdk-input-row"><input id="cmdk-input" placeholder="Search commands and transcript…"></div><div id="cmdk-list" class="cmdk-list"></div><div class="cmdk-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Select</span><span><kbd>Esc</kbd> Close</span></div></div></dialog></div><script>window.__CODEX_TRANSCRIPTS_META__=${JSON.stringify(meta)};window.__CODEX_TRANSCRIPTS__={chunks:{0:${JSON.stringify(items)}}};</script><script src="/codex-transcripts-viewer.js"></script></body></html>`;
}

type ProviderKey = "codex" | "claude";
const PROVIDERS: Record<ProviderKey, { label: string; title: string; path: string; file: string }> = {
  codex: { label: "Codex", title: "Open a Codex session", path: "~/.codex/sessions", file: "rollout-*.jsonl" },
  claude: { label: "Claude", title: "Open a Claude session", path: "~/.claude/projects", file: "*.jsonl" },
};

export default function Home() {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [pathCopied, setPathCopied] = useState(false);
  const [provider, setProvider] = useState<ProviderKey>("codex");
  const fallbackInput = useRef<HTMLInputElement>(null);
  const cfg = PROVIDERS[provider];

  function copyPath() {
    navigator.clipboard.writeText(cfg.path).then(() => setPathCopied(true)).catch(() => setPathCopied(false));
  }

  async function loadCodexFile(file: File) {
    setIsLoading(true);
    setError(null);
    try {
      setTranscript(parseCodexRollout(await file.text(), file.name));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read this transcript.");
    } finally {
      setIsLoading(false);
    }
  }

  async function openCodexPicker() {
    setError(null);
    try {
      await navigator.clipboard.writeText(cfg.path);
      setPathCopied(true);
    } catch {
      setPathCopied(false);
    }
    const picker = (window as FilePickerWindow).showOpenFilePicker;
    if (!picker) {
      fallbackInput.current?.click();
      return;
    }

    try {
      const [handle] = await picker({
        multiple: false,
        types: [{ description: "Codex rollout", accept: { "application/json": [".jsonl"] } }],
      });
      if (handle) await loadCodexFile(await handle.getFile());
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError("The file picker could not be opened. Please try again.");
    }
  }

  if (transcript) {
    return <iframe className="codex-transcript-frame" srcDoc={viewerDocument(transcript)} title="Codex transcript" />;
    /*
    const groups = groupConversation(transcript.entries);
    const matches = groups.map((group, index) => ({ group, index })).filter(({ group }) =>
      group.some((entry) => `${entry.label} ${entry.content}`.toLowerCase().includes(search.toLowerCase()))
    );
    return (
      <main className="codex-viewer">
        <div className="container">
          <div className="header-row">
            <h1>Codex transcript</h1>
            <div className="header-controls"><button className="viewer-control" onClick={() => setSearchOpen(true)} type="button">Search <kbd>⌘K</kbd></button><button className="viewer-control" onClick={() => setTranscript(null)} type="button">Choose another file</button></div>
          </div>
          <p className="viewer-summary">
            {transcript.entries.length} messages · {transcript.cwd ?? transcript.filename}
          </p>
          <nav className="side-nav" aria-label="Jump between conversations">{groups.map((group, index) => <a href={`#turn-${index}`} key={index}>#{index + 1}</a>)}</nav>
          <section className="conversations" aria-label="Codex conversation">
            {groups.map((group, groupIndex) => {
              const prompt = group.find((entry) => entry.kind === "user");
              const response = [...group].reverse().find((entry) => entry.kind === "assistant");
              return <details className="conversation index-item" id={`turn-${groupIndex}`} key={groupIndex} open={groupIndex === 0}>
                <summary className="conversation-summary"><div className="index-item-content conversation-prompt">{prompt?.content ?? "(session start)"}</div><div className="conversation-meta"><span className="index-item-number">#{groupIndex + 1}</span><time>{formatTime(group[0].timestamp)}</time><span>· {group.length} messages</span></div>{response ? <div className="conversation-response"><span>Codex</span>{response.content}</div> : null}</summary>
                <div className="conversation-messages">{group.map((entry, index) => {
              const messageClass = entry.kind === "result" ? "tool-reply" : entry.kind === "notice" ? "system" : entry.kind;
              return <article className={`message ${messageClass}`} key={`${entry.timestamp}-${index}`} onClick={() => setDetail(entry)}>
                <div className="message-content">
                  {entry.kind === "user" ? <div className="user-content">{entry.content}</div> : null}
                  {entry.kind === "assistant" ? <div className="assistant-text">{entry.content}</div> : null}
                  {entry.kind === "tool" ? <div className="tool-use"><div className="tool-header"><span className="tool-icon">⚙</span>{entry.label}</div><pre>{entry.content}</pre></div> : null}
                  {entry.kind === "result" ? <div className="tool-result"><pre>{entry.content}</pre></div> : null}
                  {entry.kind === "notice" ? <div className="thinking"><div className="thinking-label">Session</div>{entry.content}</div> : null}
                </div>
                <div className="message-meta"><span className="role-label">{entry.label}</span><time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time></div>
              </article>;
            })}</div></details>;
            })}
          </section>
          {detail ? <aside className="detail-pane" aria-label="Message detail"><div className="detail-header"><strong>{detail.label}</strong><time>{formatTime(detail.timestamp)}</time><button onClick={() => setDetail(null)} type="button">×</button></div><pre>{detail.content}</pre></aside> : null}
          {searchOpen ? <dialog className="cmdk" open><div className="cmdk-box"><div className="cmdk-input-row"><input autoFocus onChange={(event) => setSearch(event.target.value)} placeholder="Search commands and transcript…" value={search} /><button onClick={() => setSearchOpen(false)} type="button">Close</button></div><div className="cmdk-list">{matches.map(({ group, index }) => <button key={index} onClick={() => { document.getElementById(`turn-${index}`)?.scrollIntoView(); setSearchOpen(false); }} type="button"><strong>#{index + 1}</strong><span>{group.find((entry) => entry.kind === "user")?.content ?? "Session start"}</span></button>)}</div></div></dialog> : null}
        </div>
      </main>
    );
    */
  }

  return (
    <main className="agentsession-shell">
      <section className="agentsession-card" aria-labelledby="page-title">
        <header className="agentsession-brand">
          <svg className="agentsession-logo" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="1" y="1" width="30" height="30" rx="6" fill="#0d0d0f" stroke="#2b2b30" />
            <polyline points="9,11 15,16 9,21" fill="none" stroke="#e6e6e8" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="17" y1="21.5" x2="24" y2="21.5" stroke="#4a90ff" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <span>agentsession</span>
        </header>

        <div className="provider-toggle" role="group" aria-label="Session type">
          {(Object.keys(PROVIDERS) as ProviderKey[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={provider === key}
              className={provider === key ? "active" : ""}
              onClick={() => { setProvider(key); setPathCopied(false); setError(null); }}
            >
              {PROVIDERS[key].label}
            </button>
          ))}
        </div>

        <h1 id="page-title">{cfg.title}</h1>
        <p className="agentsession-sub">
          Choose a local <code>{cfg.file}</code> file. It’s parsed entirely in your browser — nothing is uploaded.
        </p>

        <div className="path-row">
          <code>{cfg.path}</code>
          <button onClick={copyPath} type="button">{pathCopied ? "Copied" : "Copy path"}</button>
        </div>
        <p className="agentsession-hint">
          Copy the path above. In the file dialog, press <kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>G</kbd>, paste it, hit Return, then pick your file.
        </p>

        <button className="open-session" disabled={isLoading} onClick={openCodexPicker} type="button">
          {isLoading ? "Reading…" : "Open session"}
        </button>

        <input accept=".jsonl,application/json" className="file-input" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadCodexFile(file); }} ref={fallbackInput} type="file" />
        {error ? <p className="error-message" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
