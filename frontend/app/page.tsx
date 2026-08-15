"use client";

import { useEffect, useRef, useState } from "react";
import { parseCodexRollout, type TokenUsage, type Transcript, type TranscriptEntry } from "@/lib/codex-rollout";
import { parseClaudeSession } from "@/lib/claude-session";
import { publishSessions, type PublishedShare, type PublishVisibility } from "@/lib/publish-session";
import { createSessionView, type SessionTab } from "@/lib/session-tabs";

type FilePickerHandle = { getFile: () => Promise<File>; name: string };
type FilePickerWindow = Window & {
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FilePickerHandle[]>;
};

type SessionComparison = {
  activeMs: number;
  cachedInput: number;
  completed: number;
  endMs: number | null;
  filename: string;
  interrupted: number;
  model: string;
  output: number;
  patches: number;
  reasoning: number;
  startMs: number | null;
  tools: number;
  total: number;
  input: number;
};

function validTimestamp(value: string | null) {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function compareSession(transcript: Transcript): SessionComparison {
  const usage = transcript.usageEvents.reduce<TokenUsage>((total, event) => ({
    input: total.input + event.input,
    cachedInput: total.cachedInput + event.cachedInput,
    cacheWrite: total.cacheWrite + event.cacheWrite,
    output: total.output + event.output,
    reasoning: total.reasoning + event.reasoning,
    total: total.total + event.total,
  }), { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
  const completedTurns = transcript.turns.filter((turn) => turn.status === "completed");
  const timestamps = [
    ...transcript.entries.map((entry) => validTimestamp(entry.timestamp)),
    ...transcript.usageEvents.map((event) => validTimestamp(event.ts)),
    ...transcript.turns.flatMap((turn) => [validTimestamp(turn.startedAt), validTimestamp(turn.completedAt)]),
  ].filter((timestamp): timestamp is number => timestamp !== null);
  const settings = new Map<string, number>();
  for (const context of transcript.turnContexts) {
    const setting = [context.model, context.effort].filter(Boolean).join(" · ") || "Unavailable";
    settings.set(setting, (settings.get(setting) ?? 0) + 1);
  }
  const model = [...settings.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([setting, count]) => `${setting} (${count})`)
    .join(" · ") || "Unavailable";

  return {
    activeMs: completedTurns.reduce((total, turn) => total + (turn.durationMs ?? 0), 0),
    cachedInput: usage.cachedInput,
    completed: completedTurns.length,
    endMs: timestamps.length ? Math.max(...timestamps) : null,
    filename: transcript.filename,
    input: usage.input,
    interrupted: transcript.turns.filter((turn) => turn.status === "interrupted").length,
    model,
    output: usage.output,
    patches: transcript.patchApplyCount,
    reasoning: usage.reasoning,
    startMs: timestamps.length ? Math.min(...timestamps) : null,
    tools: transcript.entries.filter((entry) => entry.kind === "tool").length,
    total: usage.total,
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
    : `<div class="thinking"><div class="thinking-label">${escapeHtml(entry.label)}</div>${renderMarkdown(entry.content)}</div>`;
  const messageClass = entry.kind === "result" ? "tool-reply" : entry.kind === "notice" ? "system" : entry.kind;
  return `<div class="message ${messageClass}" id="${id}"><div class="message-content">${body}</div><div class="message-meta"><span class="role-label">${escapeHtml(entry.label)}</span><a href="#${id}" class="timestamp-link"><time datetime="${entry.timestamp}">${entry.timestamp}</time></a></div></div>`;
}

export function viewerDocument(transcript: Transcript, { allowAddSessions = true, publishable = true, sessionCount = 1, sessionTabs = [], sourceSessions = [], summaryOnly = false }: { allowAddSessions?: boolean; publishable?: boolean; sessionCount?: number; sessionTabs?: SessionTab[]; sourceSessions?: Transcript[]; summaryOnly?: boolean } = {}) {
  const assistantName = transcript.provider === "claude" ? "Claude" : "Codex";
  const groups = summaryOnly ? [] : groupConversation(transcript.entries);
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
  const items = summaryOnly ? [] : transcript.entries.map(viewerMessageHtml);
  let start = 0;
  const summary = groups.map((group, index) => {
    const end = start + group.length - 1;
    const prompt = group.find((entry) => entry.kind === "user")?.content ?? "(session start)";
    const response = [...group].reverse().find((entry) => entry.kind === "assistant")?.content ?? "";
    const collapsed = response.replace(/\s+/g, " ").trim();
    const responsePreview = collapsed.slice(0, 600) + (collapsed.length > 600 ? "…" : "");
    const responseHtml = responsePreview
      ? `<div class="conversation-response"><span class="conversation-response-label">${assistantName}</span><div class="conversation-response-text"><p>${renderInline(responsePreview)}</p></div></div>`
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
    ? `<div class="system-records-notice"><div class="system-records-notice-title">System/internal records: ${systemTotal}</div><div class="system-records-notice-subtitle">Internal ${assistantName} records not shown in the transcript, grouped by type.</div><details><summary>Details (counts by type)</summary>${noticeSection("rollout", transcript.systemRollout)}${noticeSection("event_msg", transcript.systemEvent)}${noticeSection("response_item", transcript.systemResponse)}</details></div>`
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
  const activityNoun = summaryOnly ? "task" : "conversation";
  const activityHeading = summaryOnly ? "Completed tasks" : "Conversations";
  const usageByTurn = summaryOnly
    ? completedTurns.map((turn, index) => {
      const startMs = Date.parse(turn.startedAt);
      const endMs = Date.parse(turn.completedAt ?? turn.startedAt);
      const processed = transcript.usageEvents.reduce((total, event) => {
        const eventMs = Date.parse(event.ts);
        return eventMs >= startMs && eventMs <= endMs ? total + event.total : total;
      }, 0);
      return { groupIndex: null, index: index + 1, processed, turn };
    })
    : groups.map((group, index) => ({
      groupIndex: index,
      index: index + 1,
      processed: groupFilters[index].token_count,
      turn: { durationMs: groupDurations[index] },
    }));
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
    ? usageByTurn.map(({ groupIndex, index, processed, turn }) => {
      const content = `<span>${index}</span><div class="usage-bar-track"><div class="usage-bar" style="height:${Math.max(8, Math.round((processed / peakTurn) * 100))}%" title="${activityHeading.slice(0, -1)} ${index}: ${tokenLabel(processed)} processed tokens in ${durationLabel(turn.durationMs ?? 0)}"></div></div><b>${tokenLabel(processed)}</b>`;
      return groupIndex === null
        ? `<div class="usage-bar-item">${content}</div>`
        : `<button aria-label="Open conversation ${index}" class="usage-bar-item usage-bar-jump" data-usage-group-index="${groupIndex}" type="button">${content}</button>`;
    }).join("")
    : `<p class="usage-empty">No ${activityNoun}-level usage is available in this session.</p>`;
  const settingsHtml = [...settings.entries()].map(([setting, count]) => `<li><code>${escapeHtml(setting)}</code><span>${count} turn${count === 1 ? "" : "s"}</span></li>`).join("") || "<li>Unavailable</li>";
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${count} ${escapeHtml(name)}`).join(" · ") || "No tool calls";
  const modelName = transcript.turnContexts.find((context) => context.model)?.model ?? "Model unavailable";
  const sessionComparisons = summaryOnly ? sourceSessions.map(compareSession) : [];
  const comparisonHtml = sessionComparisons.length > 1 ? (() => {
    const totalProcessed = sessionComparisons.reduce((total, session) => total + session.total, 0);
    const timelineStarts = sessionComparisons.flatMap((session) => session.startMs === null ? [] : [session.startMs]);
    const timelineEnds = sessionComparisons.flatMap((session) => session.endMs === null ? [] : [session.endMs]);
    const timelineStart = timelineStarts.length ? Math.min(...timelineStarts) : 0;
    const timelineEnd = timelineEnds.length ? Math.max(...timelineEnds) : timelineStart;
    const timelineSpan = Math.max(1, timelineEnd - timelineStart);
    const dateLabel = (milliseconds: number | null) => milliseconds === null ? "Unavailable" : new Intl.DateTimeFormat(undefined, { day: "numeric", hour: "numeric", minute: "2-digit", month: "short" }).format(milliseconds);
    const rows = sessionComparisons.map((session, index) => {
      const share = totalProcessed ? `${((session.total / totalProcessed) * 100).toFixed(1)}%` : "0.0%";
      const perTask = session.completed ? tokenLabel(Math.round(session.total / session.completed)) : "0";
      const cacheRate = session.input ? `${((session.cachedInput / session.input) * 100).toFixed(1)}%` : "0.0%";
      const taskLabel = `${session.completed} completed${session.interrupted ? ` · ${session.interrupted} interrupted` : ""}`;
      return `<tr><th scope="row"><span>Session ${index + 1}</span><small title="${escapeHtml(session.filename)}">${escapeHtml(session.filename)}</small></th><td><strong>${tokenLabel(session.total)}</strong><small>${share} · ${perTask}/task</small></td><td><strong>${cacheRate}</strong><small>${tokenLabel(Math.max(0, session.input - session.cachedInput))} uncached</small></td><td><strong>${tokenLabel(session.output)}</strong><small>${tokenLabel(session.reasoning)} reasoning</small></td><td><strong>${taskLabel}</strong></td><td><strong>${durationLabel(session.activeMs)}</strong></td><td><strong>${session.tools} tools · ${session.patches} patches</strong></td><td><code title="${escapeHtml(session.model)}">${escapeHtml(session.model)}</code></td></tr>`;
    }).join("");
    const timelineRows = sessionComparisons.map((session, index) => {
      if (session.startMs === null || session.endMs === null) {
        return `<li><span class="session-timeline-name">Session ${index + 1}</span><span class="session-timeline-track"></span><time>No reliable timestamp range</time></li>`;
      }
      const left = ((session.startMs - timelineStart) / timelineSpan) * 100;
      const width = Math.max(1.2, ((session.endMs - session.startMs) / timelineSpan) * 100);
      const range = `${dateLabel(session.startMs)} – ${dateLabel(session.endMs)}`;
      return `<li><span class="session-timeline-name">Session ${index + 1}</span><span class="session-timeline-track" title="${escapeHtml(range)}"><i style="left:${left}%;width:${width}%"></i></span><time>${escapeHtml(range)}</time></li>`;
    }).join("");
    return `<section class="session-comparison" aria-labelledby="comparison-heading"><header><div><p class="usage-eyebrow">Source sessions</p><h3 id="comparison-heading">Session comparison</h3></div><span>${sessionComparisons.length} local sessions</span></header><div class="session-comparison-table-wrap"><table><thead><tr><th>Session</th><th>Processed</th><th>Cache</th><th>Generated</th><th>Tasks</th><th>Active</th><th>Activity</th><th>Model settings</th></tr></thead><tbody>${rows}</tbody></table></div><section class="session-timeline" aria-label="Session time spans"><header><span>Overall time span</span><span>${escapeHtml(dateLabel(timelineStart))} – ${escapeHtml(dateLabel(timelineEnd))}</span></header><ol>${timelineRows}</ol></section></section>`;
  })() : "";
  const dashboardHtml = `<section class="usage-dashboard" aria-labelledby="usage-heading"><div class="usage-header"><div><p class="usage-eyebrow">Local session telemetry</p><h2 id="usage-heading">Session usage</h2><p>${escapeHtml(modelName)} · ${transcript.usageEvents.length} usage updates${transcript.provider === "codex" ? " · cumulative deltas are summed." : " · model-request totals are summed."}</p></div><span class="usage-status">${completedTurns.length} completed${interruptedTurns.length ? ` · ${interruptedTurns.length} interrupted` : ""}</span></div><div class="usage-metrics">${metric("Processed tokens", tokenLabel(usage.total), `${tokenLabel(usage.input)} input across updates`)}${metric("Cached input", tokenLabel(usage.cachedInput), `${usage.input ? ((usage.cachedInput / usage.input) * 100).toFixed(1) : "0.0"}% of observed input`)}${metric("Generated", tokenLabel(usage.output), `Includes ${tokenLabel(usage.reasoning)} reasoning`)}${metric("Active task time", durationLabel(activeMs), `${durationLabel(elapsedMs)} ${summaryOnly ? "overall time span" : "elapsed session time"}`)}</div>${comparisonHtml}<div class="usage-detail-grid"><figure class="usage-chart"><figcaption><div><p class="usage-eyebrow">${activityHeading}</p><h3>Processed-token activity</h3></div><span>Peak ${activityNoun}: ${tokenLabel(peakTurn)}</span></figcaption><div class="usage-bars" role="group" aria-label="Processed token totals by ${activityHeading.toLowerCase()}">${bars}</div><p>${summaryOnly ? "Each bar sums" : "Click a bar to jump to its conversation. Each bar sums"} ${transcript.provider === "codex" ? "cumulative-usage deltas" : "model-request totals"} recorded within that ${activityNoun}.</p></figure><section class="usage-activity" aria-label="Session activity"><div><p class="usage-eyebrow">Activity</p><h3>${[...toolCounts.values()].reduce((sum, count) => sum + count, 0)} tool calls · ${transcript.patchApplyCount} patches</h3><p>${topTools}</p></div><div><p class="usage-eyebrow">Model settings</p><ul>${settingsHtml}</ul></div></section></div><details class="usage-details"><summary>Session details</summary><dl><div><dt>Working directory</dt><dd>${escapeHtml(transcript.cwd ?? "Unavailable")}</dd></div><div><dt>Source</dt><dd>${escapeHtml([transcript.session.originator, transcript.session.source].filter(Boolean).join(" · ") || "Unavailable")}</dd></div><div><dt>CLI version</dt><dd>${escapeHtml(transcript.session.cliVersion ?? "Unavailable")}</dd></div><div><dt>Git revision</dt><dd>${escapeHtml([transcript.session.gitBranch, transcript.session.gitCommit?.slice(0, 12)].filter(Boolean).join(" · ") || "Unavailable")}</dd></div></dl></details></section>`;
  const summaryHtml =
    dashboardHtml + `<div class="viewer-summary">` +
    stat(`<b>${summaryOnly ? sessionCount : groups.length}</b> ${summaryOnly ? "sessions" : "conversations"}`) +
    stat(`<b>${summaryOnly ? transcript.entries.length : items.length}</b> messages`) +
    (taskDurations.length
      ? stat(`⏱ avg <b>${durationLabel(avgMs)}</b>`) + stat(`min <b>${durationLabel(minMs)}</b>`) + stat(`max <b>${durationLabel(maxMs)}</b>`)
      : "") +
    `</div>`;
  // The iframe receives every message inline in chunk 0, so its chunk size must
  // cover the full transcript. A fixed size left later conversations waiting for
  // chunk files that do not exist.
  const meta = { format: "codex-transcripts.viewer.v3", total: items.length, chunk_size: Math.max(1, items.length), chunks: [""], kinds: transcript.entries.map((entry) => entry.kind[0]).join(""), ids: items.map((_, index) => `msg-${index}`), ts: transcript.entries.map((entry) => entry.timestamp), groups: groups.map((group, index) => ({ start: groups.slice(0, index).reduce((total, item) => total + item.length, 0), end: groups.slice(0, index + 1).reduce((total, item) => total + item.length, 0) - 1, prompt: group.find((entry) => entry.kind === "user")?.content ?? null, filters: groupFilters[index] })) };
  const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  const sessionSwitcher = sessionTabs.length
    ? `<nav class="session-switcher" aria-label="Loaded ${assistantName} sessions" role="tablist">${sessionTabs.map((tab) => `<button aria-selected="${tab.active}" class="${tab.active ? "active" : ""}" data-session-tab="${tab.value}" role="tab" title="${escapeHtml(tab.label)}" type="button">${escapeHtml(tab.label)}</button>`).join("")}${allowAddSessions ? `<button class="session-switcher-add" data-session-add type="button">Add sessions</button>` : ""}</nav>`
    : "";
  const sessionControlsScript = `<script>document.querySelectorAll('[data-session-tab]').forEach(function(button){button.addEventListener('click',function(){window.parent.postMessage({source:'agentsession',type:'session-tab',tab:button.getAttribute('data-session-tab')},'*');});});var addButton=document.querySelector('[data-session-add]');if(addButton){addButton.addEventListener('click',function(){window.parent.postMessage({source:'agentsession',type:'session-add'},'*');});}var publishButton=document.querySelector('[data-session-publish]');if(publishButton){publishButton.addEventListener('click',function(){window.parent.postMessage({source:'agentsession',type:'session-publish'},'*');});}</script>`;
  const bodyContent = summaryOnly
    ? `<section class="cumulative-session-note"><strong>Cumulative session</strong><span>Metrics across ${sessionCount} local ${assistantName} sessions. Individual transcripts remain available in their tabs.</span></section>`
    : `<nav id="side-nav" class="side-nav" aria-label="Jump between conversations"></nav><div id="conversations" class="conversations">${summary}</div><footer class="conversation-end" aria-label="End of session">End of session</footer><aside id="detail-pane" class="detail-pane" aria-hidden="true"><div class="detail-header"><span class="detail-role" id="detail-role"></span><span class="detail-time" id="detail-time"></span><button class="detail-close" id="detail-close">×</button></div><div class="detail-body" id="detail-body"></div></aside><dialog id="cmdk" class="cmdk"><div class="cmdk-box"><div class="cmdk-input-row"><input id="cmdk-input" placeholder="Search commands and transcript…"></div><div id="cmdk-list" class="cmdk-list"></div><div class="cmdk-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Select</span><span><kbd>Esc</kbd> Close</span></div></div></dialog>`;
  const headerControl = summaryOnly ? "" : `<button id="cmdk-trigger" class="cmdk-trigger" type="button"><svg class="cmdk-trigger-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg><span class="cmdk-trigger-label">Search</span><kbd class="cmdk-trigger-kbd">⌘K</kbd></button>`;
  const headerActions = `<div class="header-controls">${publishable ? `<button class="publish-trigger" data-session-publish type="button">Publish</button>` : ""}${headerControl}</div>`;
  const title = summaryOnly ? `Cumulative ${assistantName} usage` : `${assistantName} transcript`;
  return `<!doctype html><html><head><meta charset="utf-8"><script>(function(){var theme;try{theme=localStorage.getItem('theme')}catch(e){}if(theme!=='light'&&theme!=='dark'){theme=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',theme);document.documentElement.style.backgroundColor=theme==='dark'?'#000106':'#FCEFD5';if(window.parent!==window){window.parent.postMessage({source:'agentsession',type:'session-theme',theme:theme},'*')}})()</script><link rel="stylesheet" href="/codex-transcripts.css"></head><body><div class="container"><div class="header-row"><h1>${title}</h1>${headerActions}</div>${sessionSwitcher}<div class="summary-row">${summaryHtml}${summaryOnly ? "" : sortHtml}</div>${noticeHtml}${bodyContent}</div><script>window.__CODEX_TRANSCRIPTS_META__=${scriptJson(meta)};window.__CODEX_TRANSCRIPTS__={chunks:{0:${scriptJson(items)}}};</script>${sessionControlsScript}<script src="/codex-transcripts-viewer.js"></script></body></html>`;
}

type ProviderKey = "codex" | "claude";
const PROVIDERS: Record<ProviderKey, { label: string; title: string; path: string; file: string }> = {
  codex: { label: "Codex", title: "Open a Codex session", path: "~/.codex/sessions", file: "rollout-*.jsonl" },
  claude: { label: "Claude", title: "Open a Claude session", path: "~/.claude/projects", file: "*.jsonl" },
};

export default function Home() {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [activeTab, setActiveTab] = useState<number | "cumulative">(0);
  const [pathCopied, setPathCopied] = useState(false);
  const [provider, setProvider] = useState<ProviderKey>("codex");
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishLinkCopied, setPublishLinkCopied] = useState(false);
  const [publishName, setPublishName] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishPassword, setPublishPassword] = useState("");
  const [publishResult, setPublishResult] = useState<PublishedShare | null>(null);
  const [publishStatus, setPublishStatus] = useState<"idle" | "publishing">("idle");
  const [transcriptTheme, setTranscriptTheme] = useState<"light" | "dark">("dark");
  const [publishVisibility, setPublishVisibility] = useState<PublishVisibility>("public");
  const fallbackInput = useRef<HTMLInputElement>(null);
  const fallbackAppend = useRef(false);
  const transcriptFrame = useRef<HTMLIFrameElement>(null);
  const cfg = PROVIDERS[provider];
  const publishReady = Boolean(publishName.trim()) && (publishVisibility !== "password" || publishPassword.length >= 8);

  useEffect(() => {
    function handleSessionControl(event: MessageEvent<unknown>) {
      if (event.source !== transcriptFrame.current?.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object") return;
      const data = message as { source?: unknown; tab?: unknown; theme?: unknown; type?: unknown };
      if (data.source !== "agentsession") return;
      if (data.type === "session-theme" && (data.theme === "light" || data.theme === "dark")) {
        setTranscriptTheme(data.theme);
        return;
      }
      if (data.type === "session-add") {
        fallbackAppend.current = true;
        fallbackInput.current?.click();
        return;
      }
      if (data.type === "session-publish") {
        setPublishError(null);
        setPublishLinkCopied(false);
        setPublishResult(null);
        setPublishOpen(true);
        return;
      }
      if (data.type !== "session-tab") return;
      if (data.tab === "cumulative") setActiveTab("cumulative");
      else if (typeof data.tab === "string" && /^\d+$/.test(data.tab)) {
        const index = Number(data.tab);
        if (index < transcripts.length) setActiveTab(index);
      }
    }
    window.addEventListener("message", handleSessionControl);
    return () => window.removeEventListener("message", handleSessionControl);
  }, [transcripts.length]);

  function copyPath() {
    navigator.clipboard.writeText(cfg.path).then(() => setPathCopied(true)).catch(() => setPathCopied(false));
  }

  function closePublish() {
    if (publishStatus === "publishing") return;
    setPublishOpen(false);
    setPublishError(null);
    setPublishLinkCopied(false);
  }

  async function copyPublishedLink() {
    if (!publishResult) return;
    try {
      await navigator.clipboard.writeText(publishResult.share_url);
      setPublishLinkCopied(true);
      window.setTimeout(() => setPublishLinkCopied(false), 1800);
    } catch {
      setPublishError("Could not copy the link. Copy it from the field instead.");
    }
  }

  async function submitPublish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPublishError(null);
    setPublishStatus("publishing");
    try {
      setPublishResult(await publishSessions({
        displayName: publishName,
        password: publishPassword,
        transcripts,
        visibility: publishVisibility,
      }));
    } catch (caught) {
      setPublishError(caught instanceof Error ? caught.message : "The session could not be published.");
    } finally {
      setPublishStatus("idle");
    }
  }

  async function loadSessionFiles(fileList: FileList | File[], append = false) {
    const files = Array.from(fileList);
    if (!files.length) return;
    setIsLoading(true);
    setError(null);
    try {
      const results = await Promise.all(files.map(async (file) => {
        try {
          const raw = await file.text();
          return { transcript: provider === "claude" ? parseClaudeSession(raw, file.name) : parseCodexRollout(raw, file.name) };
        } catch (caught) {
          return { error: `${file.name}: ${caught instanceof Error ? caught.message : "Could not read this transcript."}` };
        }
      }));
      const loaded = results.flatMap((result) => result.transcript ? [result.transcript] : []);
      const failed = results.flatMap((result) => result.error ? [result.error] : []);
      if (!loaded.length) throw new Error(failed[0] ?? "Could not read these transcripts.");
      const next = append ? [...transcripts, ...loaded] : loaded;
      setTranscripts(next);
      setActiveTab(next.length > 1 ? "cumulative" : 0);
      if (failed.length) setError(`Loaded ${loaded.length} session${loaded.length === 1 ? "" : "s"}. Skipped ${failed.length}: ${failed.join(" ")}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read these transcripts.");
    } finally {
      setIsLoading(false);
    }
  }

  async function openSessionPicker(append = false) {
    setError(null);
    try {
      await navigator.clipboard.writeText(cfg.path);
      setPathCopied(true);
    } catch {
      setPathCopied(false);
    }
    const picker = (window as FilePickerWindow).showOpenFilePicker;
    if (!picker) {
      fallbackAppend.current = append;
      fallbackInput.current?.click();
      return;
    }

    try {
      const handles = await picker({
        multiple: true,
        types: [{ description: provider === "claude" ? "Claude Code session" : "Codex rollout", accept: { "application/json": [".jsonl", ".json"] } }],
      });
      await loadSessionFiles(await Promise.all(handles.map((handle) => handle.getFile())), append);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError("The file picker could not be opened. Please try again.");
    }
  }

  const fallbackFileInput = <input accept=".jsonl,.json,application/json" className="file-input" multiple onChange={(event) => { const files = event.target.files; if (files?.length) void loadSessionFiles(files, fallbackAppend.current); fallbackAppend.current = false; event.currentTarget.value = ""; }} ref={fallbackInput} type="file" />;

  const sessionView = createSessionView(transcripts, activeTab);
  if (sessionView) {
    const { cumulative, currentTranscript, sessionTabs } = sessionView;
    return <><iframe className="codex-transcript-frame" onLoad={(event) => {
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.contentWindow?.focus();
      const theme = event.currentTarget.contentDocument?.documentElement.getAttribute("data-theme");
      if (theme === "light" || theme === "dark") setTranscriptTheme(theme);
    }} ref={transcriptFrame} srcDoc={viewerDocument(currentTranscript, {
      sessionCount: transcripts.length,
      sessionTabs,
      sourceSessions: cumulative ? transcripts : [],
      summaryOnly: cumulative,
    })} tabIndex={0} title={cumulative ? `Cumulative ${provider === "claude" ? "Claude" : "Codex"} usage` : `${currentTranscript.provider === "claude" ? "Claude" : "Codex"} transcript`} />{fallbackFileInput}{publishOpen ? <div aria-modal="true" className="publish-overlay" data-theme={transcriptTheme} onMouseDown={closePublish} role="dialog" aria-labelledby="publish-title"><section className="publish-dialog" onMouseDown={(event) => event.stopPropagation()}><header><div><p>Encrypted share</p><h2 id="publish-title">Publish this session</h2></div><button aria-label="Close publish dialog" disabled={publishStatus === "publishing"} onClick={closePublish} type="button">×</button></header>{publishResult ? <div className="publish-success"><h3>Share ready</h3><p>This link expires in 21 days. Save the management link below if you may need to revoke it.</p><label>Share link<input readOnly value={publishResult.share_url} /></label><button className="publish-primary" onClick={() => void copyPublishedLink()} type="button">{publishLinkCopied ? "Copied!" : "Copy share link"}</button><label>Management link<input readOnly value={publishResult.manage_url} /></label><p className="publish-muted">The encryption key stays in the share link fragment and is not sent to the server.</p></div> : <form onSubmit={(event) => void submitPublish(event)}><aside className="publish-warning"><strong>Review before publishing</strong><span>Your transcript can contain messages, tool input, local paths, project details, and secrets.</span></aside><label>Your name<input autoComplete="name" autoFocus maxLength={80} onChange={(event) => setPublishName(event.target.value)} placeholder="Name shown on the share" required value={publishName} /></label><fieldset><legend>Access</legend><label className="publish-choice"><input checked={publishVisibility === "public"} name="visibility" onChange={() => setPublishVisibility("public")} type="radio" value="public" /><span><strong>Anyone with the link</strong><small>No password required</small></span></label><label className="publish-choice"><input checked={publishVisibility === "password"} name="visibility" onChange={() => setPublishVisibility("password")} type="radio" value="password" /><span><strong>Password protected</strong><small>Viewers enter a password before opening it</small></span></label></fieldset>{publishVisibility === "password" ? <label>Password<input autoComplete="new-password" minLength={8} onChange={(event) => setPublishPassword(event.target.value)} placeholder="At least 8 characters" required type="password" value={publishPassword} /></label> : null}{publishError ? <p className="publish-error" role="alert">{publishError}</p> : null}<footer><span>Encrypted in your browser · expires in 21 days</span><button className="publish-primary" disabled={publishStatus === "publishing" || !publishReady} type="submit">{publishStatus === "publishing" ? "Publishing…" : "Publish session"}</button></footer></form>}</section></div> : null}</>;
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
              onClick={() => { setProvider(key); setPathCopied(false); setError(null); setTranscripts([]); setActiveTab(0); }}
            >
              {PROVIDERS[key].label}
            </button>
          ))}
        </div>

        <h1 id="page-title">{cfg.title}</h1>
        <p className="agentsession-sub">
          Choose one or more local <code>{cfg.file}</code> files. They’re parsed entirely in your browser — nothing is uploaded.
        </p>

        <div className="path-row">
          <code>{cfg.path}</code>
          <button onClick={copyPath} type="button">{pathCopied ? "Copied" : "Copy path"}</button>
        </div>
        <p className="agentsession-hint">
          Copy the path above. In the file dialog, press <kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>G</kbd>, paste it, hit Return, then pick your file.
        </p>

        <button className="open-session" disabled={isLoading} onClick={() => void openSessionPicker()} type="button">
          {isLoading ? "Reading…" : "Open session"}
        </button>

        {fallbackFileInput}
        {error ? <p className="error-message" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
