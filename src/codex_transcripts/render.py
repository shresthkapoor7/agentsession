from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from typing import Any

from jinja2 import Environment, PackageLoader
import markdown


_jinja_env = Environment(
    loader=PackageLoader("codex_transcripts", "templates"),
    autoescape=True,
)

_macros_template = _jinja_env.get_template("macros.html")
_macros = _macros_template.module


def get_template(name: str):
    return _jinja_env.get_template(name)


COMMIT_PATTERN = re.compile(r"\[[\w\-/]+ ([a-f0-9]{7,})\] (.+?)(?:\n|$)")
GITHUB_REPO_FROM_URL = re.compile(
    r"(?:github\\.com[:/])(?P<repo>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:\\.git)?/?$"
)

PROMPTS_PER_PAGE = 5
LONG_TEXT_THRESHOLD = 300


def format_json(obj: Any) -> str:
    try:
        if isinstance(obj, str):
            obj = json.loads(obj)
        formatted = json.dumps(obj, indent=2, ensure_ascii=False)
        return f'<pre class="json">{html.escape(formatted)}</pre>'
    except (json.JSONDecodeError, TypeError):
        return f"<pre>{html.escape(str(obj))}</pre>"


def render_markdown_text(text: str | None) -> str:
    if not text:
        return ""
    return markdown.markdown(text, extensions=["fenced_code", "tables"])


def is_json_like(text: Any) -> bool:
    if not text or not isinstance(text, str):
        return False
    text = text.strip()
    return (text.startswith("{") and text.endswith("}")) or (
        text.startswith("[") and text.endswith("]")
    )


def detect_github_repo_from_url(url: str | None) -> str | None:
    if not url:
        return None
    match = GITHUB_REPO_FROM_URL.search(url.strip())
    if not match:
        return None
    return match.group("repo")


def detect_github_repo_from_session_meta(meta: dict[str, Any] | None) -> str | None:
    if not meta:
        return None
    git = meta.get("git")
    if not isinstance(git, dict):
        return None
    return detect_github_repo_from_url(git.get("repository_url"))


def render_todo_write(tool_input: dict[str, Any], tool_id: str) -> str:
    todos = tool_input.get("todos", [])
    if not todos:
        return ""
    return _macros.todo_list(todos, tool_id)


def render_write_tool(tool_input: dict[str, Any], tool_id: str) -> str:
    file_path = tool_input.get("file_path", "Unknown file")
    content = tool_input.get("content", "")
    return _macros.write_tool(file_path, content, tool_id)


def render_edit_tool(tool_input: dict[str, Any], tool_id: str) -> str:
    file_path = tool_input.get("file_path", "Unknown file")
    old_string = tool_input.get("old_string", "")
    new_string = tool_input.get("new_string", "")
    replace_all = tool_input.get("replace_all", False)
    return _macros.edit_tool(file_path, old_string, new_string, replace_all, tool_id)


def render_bash_tool(tool_input: dict[str, Any], tool_id: str) -> str:
    command = tool_input.get("command", "")
    description = tool_input.get("description", "")
    return _macros.bash_tool(command, description, tool_id)


def _codex_tool_alias(name: str) -> str:
    # Codex CLI harness tool names are often fully-qualified.
    if name.startswith("functions."):
        return name.removeprefix("functions.")
    return name


def render_content_block(block: Any, github_repo: str | None) -> str:
    if not isinstance(block, dict):
        return f"<p>{html.escape(str(block))}</p>"
    block_type = block.get("type", "")

    if block_type == "image":
        source = block.get("source", {})
        media_type = source.get("media_type", "image/png")
        data = source.get("data", "")
        return _macros.image_block(media_type, data)

    if block_type == "thinking":
        content_html = render_markdown_text(block.get("thinking", ""))
        return _macros.thinking(content_html)

    if block_type == "text":
        content_html = render_markdown_text(block.get("text", ""))
        return _macros.assistant_text(content_html)

    if block_type == "tool_use":
        tool_name = block.get("name", "Unknown tool")
        tool_input = block.get("input", {}) if isinstance(block.get("input"), dict) else {}
        tool_id = block.get("id", "")
        alias = _codex_tool_alias(tool_name)

        # Special-cases for Codex-harness tool shapes.
        if alias == "exec_command":
            cmd = tool_input.get("cmd") or tool_input.get("command") or ""
            desc = tool_input.get("justification") or tool_input.get("description") or ""
            return _macros.bash_tool(cmd, desc, tool_id)

        if alias == "update_plan":
            return _macros.tool_use(alias, "", json.dumps(tool_input, indent=2, ensure_ascii=False), tool_id)

        if alias == "apply_patch":
            patch = tool_input.get("patch")
            if isinstance(patch, str):
                return _macros.tool_use(
                    alias,
                    "",
                    json.dumps({"patch": patch}, indent=2, ensure_ascii=False),
                    tool_id,
                )

        if alias == "todo_write":
            return render_todo_write(tool_input, tool_id)

        if alias == "write":
            return render_write_tool(tool_input, tool_id)

        if alias == "edit":
            return render_edit_tool(tool_input, tool_id)

        if alias == "bash":
            return render_bash_tool(tool_input, tool_id)

        description = tool_input.get("description", "")
        display_input = {k: v for k, v in tool_input.items() if k != "description"}
        input_json = json.dumps(display_input, indent=2, ensure_ascii=False)
        return _macros.tool_use(tool_name, description, input_json, tool_id)

    if block_type == "tool_result":
        content = block.get("content", "")
        is_error = block.get("is_error", False)

        if isinstance(content, str):
            commits_found = list(COMMIT_PATTERN.finditer(content))
            if commits_found:
                parts: list[str] = []
                last_end = 0
                for match in commits_found:
                    before = content[last_end : match.start()].strip()
                    if before:
                        parts.append(f"<pre>{html.escape(before)}</pre>")

                    commit_hash = match.group(1)
                    commit_msg = match.group(2)
                    parts.append(_macros.commit_card(commit_hash, commit_msg, github_repo))
                    last_end = match.end()

                after = content[last_end:].strip()
                if after:
                    parts.append(f"<pre>{html.escape(after)}</pre>")

                content_html = "".join(parts)
            else:
                content_html = f"<pre>{html.escape(content)}</pre>"
        elif isinstance(content, list) or is_json_like(content):
            content_html = format_json(content)
        else:
            content_html = format_json(content)
        return _macros.tool_result(content_html, is_error)

    if block_type == "system_record":
        label = block.get("label") if isinstance(block.get("label"), str) else "system"
        record = block.get("record")
        try:
            record_json = json.dumps(record, indent=2, ensure_ascii=False)
        except TypeError:
            record_json = json.dumps({"record": str(record)}, indent=2, ensure_ascii=False)
        return _macros.system_record(label, record_json)

    return format_json(block)


def is_tool_result_message(message_data: dict[str, Any]) -> bool:
    content = message_data.get("content", [])
    if not isinstance(content, list):
        return False
    if not content:
        return False
    return all(isinstance(block, dict) and block.get("type") == "tool_result" for block in content)


def render_user_message_content(message_data: dict[str, Any], github_repo: str | None) -> str:
    content = message_data.get("content", "")
    if isinstance(content, str):
        if is_json_like(content):
            return _macros.user_content(format_json(content))
        return _macros.user_content(render_markdown_text(content))
    if isinstance(content, list):
        return "".join(render_content_block(block, github_repo) for block in content)
    return f"<p>{html.escape(str(content))}</p>"


def render_assistant_message(message_data: dict[str, Any], github_repo: str | None) -> str:
    content = message_data.get("content", [])
    if not isinstance(content, list):
        return f"<p>{html.escape(str(content))}</p>"
    return "".join(render_content_block(block, github_repo) for block in content)


def make_msg_id(timestamp: str) -> str:
    return f"msg-{timestamp.replace(':', '-').replace('.', '-')}"


@dataclass(frozen=True)
class ConversationStats:
    tool_counts: dict[str, int]
    long_texts: list[str]
    commits: list[tuple[str, str, str]]
    final_text: str = ""


def analyze_conversation(messages: list[tuple[str, str, str]]) -> ConversationStats:
    tool_counts: dict[str, int] = {}
    long_texts: list[str] = []
    commits: list[tuple[str, str, str]] = []
    final_text: str = ""

    for _log_type, message_json, timestamp in messages:
        if not message_json:
            continue
        try:
            message_data = json.loads(message_json)
        except json.JSONDecodeError:
            continue

        content = message_data.get("content", [])
        if not isinstance(content, list):
            continue

        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type", "")
            if block_type == "tool_use":
                tool_name = block.get("name", "Unknown")
                if not isinstance(tool_name, str):
                    tool_name = "Unknown"
                tool_name = _codex_tool_alias(tool_name)
                tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1
            elif block_type == "tool_result":
                result_content = block.get("content", "")
                if isinstance(result_content, str):
                    for match in COMMIT_PATTERN.finditer(result_content):
                        commits.append((match.group(1), match.group(2), timestamp))
            elif block_type == "text":
                text = block.get("text", "")
                if isinstance(text, str) and len(text) >= LONG_TEXT_THRESHOLD:
                    long_texts.append(text)
                if _log_type == "assistant" and isinstance(text, str) and text.strip():
                    final_text = text

    return ConversationStats(
        tool_counts=tool_counts, long_texts=long_texts, commits=commits, final_text=final_text
    )


def format_tool_stats(tool_counts: dict[str, int]) -> str:
    if not tool_counts:
        return ""
    parts: list[str] = []
    for name, count in sorted(tool_counts.items(), key=lambda x: -x[1]):
        parts.append(f"{count} {name}")
    return " · ".join(parts)


def render_message(log_type: str, message_json: str, timestamp: str, github_repo: str | None) -> str:
    if not message_json:
        return ""
    try:
        message_data = json.loads(message_json)
    except json.JSONDecodeError:
        return ""

    if log_type == "user":
        content_html = render_user_message_content(message_data, github_repo)
        if is_tool_result_message(message_data):
            role_class, role_label = "tool-reply", "Tool reply"
        else:
            role_class, role_label = "user", "User"
    elif log_type == "assistant":
        content_html = render_assistant_message(message_data, github_repo)
        role_class, role_label = "assistant", "Codex"
    elif log_type == "system":
        content_html = render_assistant_message(message_data, github_repo)
        role_class, role_label = "system", "System"
    else:
        return ""

    if not content_html.strip():
        return ""
    msg_id = make_msg_id(timestamp)
    return _macros.message(role_class, role_label, msg_id, timestamp, content_html)


# CSS / JS are borrowed from claude-code-transcripts and intentionally embedded so
# output is standalone (no external assets required).
CSS = """
/* Minimal monochrome palette: one neutral surface family + a single accent.
   Legacy variable names are kept so component rules and the minimap keep working. */
:root {
  color-scheme: light;
  --accent: #2f6fed;
  --bg-color: #ffffff;
  --card-bg: #ffffff;
  --user-bg: #eef3fe;
  --user-border: var(--accent);
  --assistant-bg: #ffffff;
  --assistant-border: #b9b9c0;
  --thinking-bg: #f6f6f7;
  --thinking-border: #c2c2c8;
  --thinking-text: #6b6b73;
  --tool-bg: #f6f6f7;
  --tool-border: #c2c2c8;
  --tool-result-bg: #f6f6f7;
  --tool-error-bg: #fdecec;
  --text-color: #1a1a1e;
  --text-muted: #6b6b73;
  --code-bg: #f2f2f4;
  --code-text: #1a1a1e;

  --shadow-color: rgba(0,0,0,0.05);
  --border-subtle: rgba(0,0,0,0.06);
  --border: rgba(0,0,0,0.10);
  --surface-bg: rgba(0,0,0,0.03);
  --surface-border: rgba(0,0,0,0.08);
  --hover-bg: rgba(0,0,0,0.04);
  --inline-code-bg: rgba(0,0,0,0.06);

  --control-bg: #ffffff;
  --control-bg-hover: #f2f2f4;
  --control-border: rgba(0,0,0,0.14);
  --modal-backdrop: rgba(0,0,0,0.4);

  --bash-grad-from: #f6f6f7;
  --bash-grad-to: #f6f6f7;
  --bash-border: #c2c2c8;

  --write-grad-from: #f6f6f7;
  --write-grad-to: #f6f6f7;
  --write-border: #c2c2c8;
  --write-header: #6b6b73;
  --write-truncate-fade: #f6f6f7;

  --edit-grad-from: #f6f6f7;
  --edit-grad-to: #f6f6f7;
  --edit-border: #c2c2c8;
  --edit-header: #6b6b73;
  --edit-truncate-fade: #f6f6f7;

  --todo-grad-from: #f6f6f7;
  --todo-grad-to: #f6f6f7;
  --todo-border: #c2c2c8;
  --todo-header: #6b6b73;

  --index-commit-border: #c2c2c8;

  --system-bg: #f6f6f7;
  --system-border: #c2c2c8;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    color-scheme: dark;
    --accent: #4a90ff;
    --bg-color: #0d0d0f;
    --card-bg: #161618;
    --user-bg: #1b2740;
    --user-border: var(--accent);
    --assistant-bg: #0d0d0f;
    --assistant-border: #4a4a52;
    --thinking-bg: #161618;
    --thinking-border: #4a4a52;
    --thinking-text: #9a9aa2;
    --tool-bg: #141416;
    --tool-border: #4a4a52;
    --tool-result-bg: #141416;
    --tool-error-bg: #2a1618;
    --text-color: #e6e6e8;
    --text-muted: #8a8a92;
    --code-bg: #101012;
    --code-text: #e6e6e8;

    --shadow-color: rgba(0,0,0,0.4);
    --border-subtle: rgba(255,255,255,0.06);
    --border: rgba(255,255,255,0.10);
    --surface-bg: rgba(255,255,255,0.03);
    --surface-border: rgba(255,255,255,0.08);
    --hover-bg: rgba(255,255,255,0.05);
    --inline-code-bg: rgba(255,255,255,0.07);

    --control-bg: rgba(255,255,255,0.04);
    --control-bg-hover: rgba(255,255,255,0.08);
    --control-border: rgba(255,255,255,0.12);
    --modal-backdrop: rgba(0,0,0,0.6);

    --bash-grad-from: #141416;
    --bash-grad-to: #141416;
    --bash-border: #4a4a52;

    --write-grad-from: #141416;
    --write-grad-to: #141416;
    --write-border: #4a4a52;
    --write-header: #9a9aa2;
    --write-truncate-fade: #141416;

    --edit-grad-from: #141416;
    --edit-grad-to: #141416;
    --edit-border: #4a4a52;
    --edit-header: #9a9aa2;
    --edit-truncate-fade: #141416;

    --todo-grad-from: #141416;
    --todo-grad-to: #141416;
    --todo-border: #4a4a52;
    --todo-header: #9a9aa2;

    --index-commit-border: #4a4a52;

    --system-bg: #161618;
    --system-border: #4a4a52;
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --accent: #4a90ff;
  --bg-color: #0d0d0f;
  --card-bg: #161618;
  --user-bg: #1b2740;
  --user-border: var(--accent);
  --assistant-bg: #0d0d0f;
  --assistant-border: #4a4a52;
  --thinking-bg: #161618;
  --thinking-border: #4a4a52;
  --thinking-text: #9a9aa2;
  --tool-bg: #141416;
  --tool-border: #4a4a52;
  --tool-result-bg: #141416;
  --tool-error-bg: #2a1618;
  --text-color: #e6e6e8;
  --text-muted: #8a8a92;
  --code-bg: #101012;
  --code-text: #e6e6e8;

  --shadow-color: rgba(0,0,0,0.4);
  --border-subtle: rgba(255,255,255,0.06);
  --border: rgba(255,255,255,0.10);
  --surface-bg: rgba(255,255,255,0.03);
  --surface-border: rgba(255,255,255,0.08);
  --hover-bg: rgba(255,255,255,0.05);
  --inline-code-bg: rgba(255,255,255,0.07);

  --control-bg: rgba(255,255,255,0.04);
  --control-bg-hover: rgba(255,255,255,0.08);
  --control-border: rgba(255,255,255,0.12);
  --modal-backdrop: rgba(0,0,0,0.6);

  --bash-grad-from: #141416;
  --bash-grad-to: #141416;
  --bash-border: #4a4a52;

  --write-grad-from: #141416;
  --write-grad-to: #141416;
  --write-border: #4a4a52;
  --write-header: #9a9aa2;
  --write-truncate-fade: #141416;

  --edit-grad-from: #141416;
  --edit-grad-to: #141416;
  --edit-border: #4a4a52;
  --edit-header: #9a9aa2;
  --edit-truncate-fade: #141416;

  --todo-grad-from: #141416;
  --todo-grad-to: #141416;
  --todo-border: #4a4a52;
  --todo-header: #9a9aa2;

  --index-commit-border: #4a4a52;

  --system-bg: #161618;
  --system-border: #4a4a52;
}
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: var(--bg-color); color: var(--text-color); margin: 0; padding: 24px 16px; line-height: 1.6; font-size: 15px; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
.container { max-width: 1040px; margin: 0 auto; transition: max-width 0.2s ease, margin 0.2s ease; }
h1 { font-size: 1.15rem; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 24px; padding-bottom: 8px; border-bottom: 1px solid var(--border-subtle); }
.header-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 12px; margin-bottom: 24px; }
.header-row h1 { border-bottom: none; padding-bottom: 0; margin-bottom: 0; flex: 1; min-width: 200px; }
.header-controls { display: flex; align-items: center; gap: 8px; }
.theme-toggle { padding: 8px; border: 1px solid var(--control-border); border-radius: 8px; background: var(--control-bg); cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-muted); }
.theme-toggle:hover { background: var(--control-bg-hover); }
.theme-toggle svg { display: none; }
.theme-toggle .icon-sun { display: inline; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .theme-toggle .icon-sun { display: none; } :root:not([data-theme]) .theme-toggle .icon-moon { display: inline; } }
:root[data-theme="dark"] .theme-toggle .icon-sun { display: none; }
:root[data-theme="dark"] .theme-toggle .icon-moon { display: inline; }
.system-records-notice { background: var(--surface-bg); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 10px 14px; margin: 12px 0 18px 0; font-size: 0.85rem; }
.system-records-notice-title { font-weight: 600; color: var(--text-muted); font-size: 0.85rem; margin-bottom: 2px; }
.system-records-notice-subtitle { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px; }
.system-records-notice details summary { cursor: pointer; font-size: 0.85rem; color: var(--text-muted); }
.system-records-notice-section { margin-top: 12px; }
.system-records-notice-section-title { font-size: 0.85rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.4px; }
.share-notice { background: var(--surface-bg); border: 1px solid var(--surface-border); border-left: 4px solid var(--user-border); border-radius: 12px; padding: 12px 16px; margin: 16px 0 24px 0; }
.share-notice-title { font-weight: 600; color: var(--user-border); margin-bottom: 4px; }
.share-notice-subtitle { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px; }
.share-notice-command { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85rem; margin: 8px 0 8px 0; }
.share-notice a { color: var(--user-border); text-decoration: none; }
.share-notice a:hover { text-decoration: underline; }
.message { margin-bottom: 18px; display: flex; flex-direction: column; }
.message-content { padding: 0; }
.message-meta { display: flex; align-items: center; gap: 8px; font-size: 0.68rem; color: var(--text-muted); margin-top: 5px; }
.role-label { font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; font-size: 0.66rem; }
.timestamp-link { color: inherit; text-decoration: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.68rem; padding: 1px 4px; border-radius: 4px; transition: background 0.2s; opacity: 0.75; }
.timestamp-link:hover { background: var(--hover-bg); opacity: 1; }

/* Codex (assistant): plain left-aligned prose, no bubble, comfortable size */
.message.assistant { align-items: stretch; }
.message.assistant .message-content { color: var(--text-color); font-size: 1rem; line-height: 1.65; }
.message.assistant .role-label { color: var(--accent); }

/* User: compact right-aligned bubble with time below */
.message.user { align-items: flex-end; }
.message.user .message-content { background: var(--user-bg); border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent); border-radius: 14px; padding: 8px 13px; max-width: 78%; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.message.user .message-content p:first-child { margin-top: 0; }
.message.user .message-content p:last-child { margin-bottom: 0; }

/* Tool reply: muted, understated */
.message.tool-reply .message-content { border-left: 2px solid var(--border); padding-left: 12px; color: var(--text-muted); }
.thinking { background: var(--surface-bg); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 12px; margin: 12px 0; color: var(--text-muted); }
.thinking-label { font-weight: 600; color: var(--text-muted); margin-bottom: 8px; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.6px; }
.tool-use { background: var(--tool-bg); border: 1px solid rgba(156,39,176,0.3); border: 1px solid color-mix(in srgb, var(--tool-border) 35%, transparent); border-radius: 8px; padding: 12px; margin: 12px 0; }
.tool-header { font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; color: var(--text-color); font-size: 0.85rem; }
.tool-icon { font-size: 1rem; }
.tool-description { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px; }
.tool-result { background: var(--tool-result-bg); border: 1px solid rgba(76,175,80,0.3); border: 1px solid color-mix(in srgb, var(--write-border) 35%, transparent); border-radius: 8px; padding: 12px; margin: 12px 0; }
.tool-result.tool-error { background: var(--tool-error-bg); border-color: rgba(244,67,54,0.3); border-color: color-mix(in srgb, #f44336 35%, transparent); }
.commit-card { background: var(--surface-bg); border: 1px solid var(--surface-border); border-radius: 8px; padding: 10px 12px; margin: 10px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
.commit-card a { text-decoration: none; color: inherit; }
.commit-card-hash { font-family: monospace; background: var(--inline-code-bg); padding: 2px 6px; border-radius: 4px; margin-right: 8px; font-size: 0.85rem; }
.bash-tool { background: linear-gradient(135deg, var(--bash-grad-from) 0%, var(--bash-grad-to) 100%); border: 1px solid var(--bash-border); }
.bash-command { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85rem; }
.file-tool { border-radius: 8px; padding: 12px; margin: 12px 0; }
.write-tool { background: linear-gradient(135deg, var(--write-grad-from) 0%, var(--write-grad-to) 100%); border: 1px solid var(--write-border); }
.edit-tool { background: linear-gradient(135deg, var(--edit-grad-from) 0%, var(--edit-grad-to) 100%); border: 1px solid var(--edit-border); }
.file-tool-header { font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; font-size: 0.95rem; }
.write-header { color: var(--write-header); }
.edit-header { color: var(--edit-header); }
.file-tool-icon { font-size: 1rem; }
.file-tool-path { font-family: monospace; background: var(--inline-code-bg); padding: 2px 8px; border-radius: 4px; }
.file-tool-fullpath { font-family: monospace; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 8px; word-break: break-all; }
.file-content { margin: 0; }
.edit-section { display: flex; margin: 4px 0; border-radius: 4px; overflow: hidden; }
.edit-label { padding: 8px 12px; font-weight: bold; font-family: monospace; display: flex; align-items: flex-start; }
.edit-old { background: color-mix(in srgb, #e5484d 12%, transparent); }
.edit-old .edit-label { color: #e5484d; background: color-mix(in srgb, #e5484d 18%, transparent); }
.edit-old .edit-content { color: inherit; }
.edit-new { background: color-mix(in srgb, #30a46c 12%, transparent); }
.edit-new .edit-label { color: #30a46c; background: color-mix(in srgb, #30a46c 18%, transparent); }
.edit-new .edit-content { color: inherit; }
.edit-content { margin: 0; flex: 1; background: transparent; font-size: 0.85rem; }
.edit-replace-all { font-size: 0.75rem; font-weight: normal; color: var(--text-muted); }
.write-tool .truncatable.truncated::after { background: linear-gradient(to bottom, transparent, var(--write-truncate-fade)); }
.edit-tool .truncatable.truncated::after { background: linear-gradient(to bottom, transparent, var(--edit-truncate-fade)); }
.todo-list { background: linear-gradient(135deg, var(--todo-grad-from) 0%, var(--todo-grad-to) 100%); border: 1px solid var(--todo-border); border-radius: 8px; padding: 12px; margin: 12px 0; }
.todo-header { font-weight: 600; color: var(--todo-header); margin-bottom: 10px; display: flex; align-items: center; gap: 8px; font-size: 0.95rem; }
.todo-items { list-style: none; margin: 0; padding: 0; }
.todo-item { display: flex; align-items: flex-start; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border-subtle); font-size: 0.9rem; }
.todo-item:last-child { border-bottom: none; }
.todo-icon { flex-shrink: 0; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; font-weight: bold; border-radius: 50%; }
.todo-completed .todo-icon { color: #30a46c; background: color-mix(in srgb, #30a46c 15%, transparent); }
.todo-completed .todo-content { color: var(--text-muted); text-decoration: line-through; }
.todo-in-progress .todo-icon { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }
.todo-in-progress .todo-content { color: var(--text-color); font-weight: 500; }
.todo-pending .todo-icon { color: var(--text-muted); background: var(--hover-bg); }
.todo-pending .todo-content { color: var(--text-muted); }
pre { background: var(--code-bg); color: var(--code-text); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; line-height: 1.5; margin: 8px 0; white-space: pre-wrap; word-wrap: break-word; }
pre.json { color: var(--code-text); }
code { background: var(--inline-code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
pre code { background: none; padding: 0; }
.user-content { margin: 0; }
.truncatable { position: relative; }
.truncatable.truncated .truncatable-content { max-height: 200px; overflow: hidden; }
.truncatable.truncated::after { content: ''; position: absolute; bottom: 32px; left: 0; right: 0; height: 60px; background: linear-gradient(to bottom, transparent, var(--card-bg)); pointer-events: none; }
.message.user .truncatable.truncated::after { background: linear-gradient(to bottom, transparent, var(--user-bg)); }
.message.tool-reply .truncatable.truncated::after { background: linear-gradient(to bottom, transparent, var(--thinking-bg)); }
.tool-use .truncatable.truncated::after { background: linear-gradient(to bottom, transparent, var(--tool-bg)); }
.tool-result .truncatable.truncated::after { background: linear-gradient(to bottom, transparent, var(--tool-result-bg)); }
.expand-btn { display: none; width: 100%; padding: 8px 16px; margin-top: 4px; background: var(--control-bg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 0.85rem; color: var(--text-muted); }
.expand-btn:hover { background: var(--control-bg-hover); }
.truncatable.truncated .expand-btn, .truncatable.expanded .expand-btn { display: block; }
.pagination { display: flex; justify-content: center; gap: 8px; margin: 24px 0; flex-wrap: wrap; }
.pagination a, .pagination span { padding: 5px 10px; border-radius: 6px; text-decoration: none; font-size: 0.85rem; }
.pagination a { background: var(--card-bg); color: var(--user-border); border: 1px solid var(--user-border); }
.pagination a:hover { background: var(--user-bg); }
.pagination .current { background: var(--user-border); color: white; }
.pagination .disabled { color: var(--text-muted); border: 1px solid var(--border-subtle); }
.pagination .index-link { background: var(--user-border); color: white; }
details.continuation { margin-bottom: 16px; }
details.continuation summary { cursor: pointer; padding: 12px 16px; background: var(--user-bg); border-left: 4px solid var(--user-border); border-radius: 12px; font-weight: 500; color: var(--text-muted); }
details.continuation summary:hover { background: rgba(25, 118, 210, 0.15); }
details.continuation[open] summary { border-radius: 12px 12px 0 0; margin-bottom: 0; }
.index-item { margin-bottom: 10px; border-radius: 14px; overflow: hidden; background: var(--card-bg); border: 1px solid var(--border-subtle); }
.index-item a { display: block; text-decoration: none; color: inherit; }
.index-item a:hover { background: var(--hover-bg); }
.index-item-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; font-size: 0.75rem; }
.index-item-number { font-weight: 600; color: var(--accent); }
.index-item-content { padding: 12px 16px; }
.index-item-stats { padding: 8px 16px 12px 16px; font-size: 0.8rem; color: var(--text-muted); border-top: 1px solid var(--border-subtle); }
.index-item-long-text { margin-top: 12px; }
.index-item-long-text-content { font-size: 1rem; line-height: 1.65; color: var(--text-color); }
.index-commit { margin-bottom: 16px; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px var(--shadow-color); background: var(--card-bg); border-left: 4px solid var(--index-commit-border); }
.index-commit a { display: block; text-decoration: none; color: inherit; }
.index-commit a:hover { background: rgba(76, 175, 80, 0.08); }
.index-commit-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; background: var(--surface-bg); font-size: 0.85rem; }
.index-commit-hash { font-family: monospace; font-weight: 600; color: var(--write-header); }
.index-commit-msg { padding: 12px 16px; }
#search-box { display: flex; align-items: center; gap: 8px; }
#search-input, #modal-search-input { padding: 8px 12px; border: 1px solid var(--control-border); border-radius: 8px; font-size: 0.9rem; width: 200px; max-width: 60vw; background: var(--control-bg); color: var(--text-color); }
#search-btn, #modal-search-btn, #modal-close-btn { padding: 8px; border: 1px solid var(--control-border); border-radius: 8px; background: var(--control-bg); color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; }
#search-btn:hover, #modal-search-btn:hover, #modal-close-btn:hover { background: var(--control-bg-hover); }
#search-modal { width: min(900px, 95vw); border: none; border-radius: 12px; padding: 0; box-shadow: 0 12px 40px rgba(0,0,0,0.25); background: var(--card-bg); color: var(--text-color); }
#search-modal::backdrop { background: var(--modal-backdrop); }
.search-modal-header { display: flex; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border-subtle); align-items: center; }
#search-status { padding: 0 12px; color: var(--text-muted); font-size: 0.85rem; }
#search-results { padding: 12px; max-height: 70vh; overflow: auto; }
.search-result { padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 10px; background: var(--control-bg); }
.search-result a { text-decoration: none; color: inherit; display: block; }
.search-result small { color: var(--text-muted); font-family: monospace; }
.search-highlight { background: rgba(255, 235, 59, 0.6); padding: 0 2px; border-radius: 3px; }

/* Shared controls */
.control-btn { padding: 8px; border: 1px solid var(--control-border); border-radius: 8px; background: var(--control-bg); color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; }
.control-btn:hover { background: var(--control-bg-hover); }
a.control-btn { text-decoration: none; }

/* Unknown record messages (format drift) */
.message.system .message-content { background: var(--surface-bg); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 10px 12px; }
.message.system .role-label { color: var(--text-muted); }
.system-record { background: color-mix(in srgb, var(--system-bg) 65%, var(--card-bg)); border: 1px solid color-mix(in srgb, var(--system-border) 25%, transparent); border-radius: 8px; padding: 12px; margin: 12px 0; }
.system-record-details summary { cursor: pointer; }
.system-record-badge { font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px; font-size: 0.72rem; }
.system-record-label { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text-muted); font-size: 0.85rem; word-break: break-word; }

/* Viewer (index.html) */
.viewer-summary { margin: 0 0 12px 0; color: var(--text-muted); font-size: 0.9rem; }
.message.active { box-shadow: 0 0 0 2px color-mix(in srgb, var(--user-border) 65%, transparent), 0 1px 3px var(--shadow-color); }
.conversations { margin-top: 12px; transition: filter 0.2s ease; }
body.detail-open .conversations { filter: brightness(0.82); }
.conversation-summary { cursor: pointer; padding: 12px 14px; list-style: none; -webkit-user-select: none; user-select: none; }
.conversation-summary::-webkit-details-marker { display: none; }
.conversation-summary::marker { content: ""; }
.conversation-summary:hover { background: var(--hover-bg); }
.conversation-prompt { font-size: 0.98rem; font-weight: 500; line-height: 1.45; color: var(--text-color); overflow-wrap: anywhere; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.conversation-prompt p { margin: 0; display: inline; }
.conversation-prompt code { font-size: 0.85em; }
.conversation-summary .index-item-long-text { display: none; }
.conversation-meta { display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: 8px; margin-top: 6px; font-size: 0.68rem; color: var(--text-muted); }
.conversation-meta .index-item-number { color: var(--accent); font-weight: 600; }
.conversation-meta .conversation-jump { color: inherit; text-decoration: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; opacity: 0.75; }
.conversation-meta .conversation-jump:hover { opacity: 1; text-decoration: underline; }
.conversation-stats-line { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.68rem; }
.conversation-response { display: flex; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-subtle); }
.conversation-response-label { flex-shrink: 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; font-size: 0.62rem; color: var(--accent); margin-top: 2px; }
.conversation-response-text { color: var(--text-muted); font-size: 0.86rem; line-height: 1.45; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.conversation-response-text p { margin: 0; display: inline; }
.conversation-response-text code { font-size: 0.85em; }
.conversation-body { display: none; }
.conversation-loading { padding: 12px 4px; color: var(--text-muted); font-size: 0.9rem; }
.conversation.filtered-out { display: none; }
.conversation.detail-active { border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: color-mix(in srgb, var(--accent) 7%, var(--card-bg)); }
.conversation.detail-active .index-item-number { color: var(--accent); }

/* Command-menu trigger (replaces the header search field) */
.cmdk-trigger { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-bg); color: var(--text-muted); cursor: pointer; font: inherit; font-size: 0.85rem; transition: background 0.15s, border-color 0.15s; }
.cmdk-trigger:hover { background: var(--hover-bg); border-color: var(--border); color: var(--text-color); }
.cmdk-trigger-label { opacity: 0.9; }
.cmdk-trigger-kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.72rem; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--card-bg); color: var(--text-muted); }

/* Side navigator: compact vertical rail of ticks; active/hover grows */
.side-nav { position: fixed; left: max(6px, calc(50vw - 560px)); top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 2px; z-index: 20; padding: 4px 3px; }
@media (max-width: 1180px) { .side-nav { display: none; } }
body.detail-open .side-nav { display: none; }
.side-nav-tick { position: relative; display: flex; align-items: center; border: none; background: none; padding: 1px 0; cursor: pointer; }
.side-nav-bar { display: block; width: 12px; height: 2px; border-radius: 2px; background: var(--border); transition: width 0.16s ease, background 0.16s ease; }
.side-nav-tick:hover .side-nav-bar { width: 22px; background: var(--text-muted); }
.side-nav-tick.active .side-nav-bar { width: 26px; background: var(--accent); }
.side-nav-tip { position: absolute; left: 34px; top: 50%; transform: translateY(-50%) translateX(-4px); background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 7px 10px; box-shadow: 0 8px 24px var(--shadow-color); width: max-content; max-width: 300px; opacity: 0; pointer-events: none; transition: opacity 0.15s ease, transform 0.15s ease; z-index: 21; }
.side-nav-tick:hover .side-nav-tip { opacity: 1; transform: translateY(-50%) translateX(0); }
.side-nav-tip-label { display: block; font-weight: 600; font-size: 0.72rem; color: var(--accent); margin-bottom: 2px; }
.side-nav-tip-text { display: block; font-size: 0.8rem; color: var(--text-color); line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }

/* Master-detail: click a conversation card to open its full thread on the right */
.conversation-summary { position: relative; }
/* Pane overlays the right side; the left list does NOT reflow, so window scroll
   position is preserved when opening/closing the preview. */
.detail-pane { position: fixed; top: 0; right: 0; height: 100vh; width: min(620px, 50vw); background: var(--card-bg); border-left: 1px solid var(--border); box-shadow: -12px 0 40px var(--shadow-color); transform: translateX(100%); transition: transform 0.22s ease; z-index: 40; display: flex; flex-direction: column; }
body.detail-open .detail-pane { transform: translateX(0); }
.detail-header { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle); }
.detail-role { font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; font-size: 0.72rem; color: var(--accent); }
.detail-time { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.72rem; color: var(--text-muted); }
.detail-close { margin-left: auto; border: 1px solid var(--border); background: var(--surface-bg); color: var(--text-muted); border-radius: 8px; width: 28px; height: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 1rem; line-height: 1; }
.detail-close:hover { background: var(--hover-bg); color: var(--text-color); }
.detail-body { padding: 18px; overflow-y: auto; flex: 1; }
.detail-body .message.detail-focus .message-content { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 4px; border-radius: 8px; }
.detail-body .truncatable.truncated .truncatable-content { max-height: none; }
.detail-body .truncatable.truncated::after, .detail-body .expand-btn { display: none; }
.detail-empty { padding: 24px 18px; color: var(--text-muted); font-size: 0.9rem; }
@media (max-width: 720px) { .detail-pane { width: 100vw; } body.detail-open .container { display: none; } }

/* Command palette (Cmd/Ctrl-K) */
.cmdk { width: min(620px, 92vw); border: none; border-radius: 16px; padding: 0; background: transparent; color: var(--text-color); margin-top: 12vh; }
.cmdk::backdrop { background: var(--modal-backdrop); backdrop-filter: blur(2px); }
.cmdk-box { background: var(--card-bg); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 24px 70px rgba(0,0,0,0.45); overflow: hidden; }
.cmdk-input-row { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); color: var(--text-muted); }
#cmdk-input { flex: 1; border: none; outline: none; background: none; color: var(--text-color); font: inherit; font-size: 1rem; }
#cmdk-input::placeholder { color: var(--text-muted); }
.cmdk-list { max-height: min(52vh, 440px); overflow-y: auto; padding: 6px; }
.cmdk-section-title { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted); padding: 10px 10px 4px; }
.cmdk-item { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 10px; cursor: pointer; transition: transform 0.12s ease, background 0.12s ease; transform-origin: left center; }
.cmdk-item.selected { background: var(--hover-bg); transform: scale(1.015); }
.cmdk-item-main { flex: 1; min-width: 0; }
.cmdk-item-label { font-size: 0.92rem; color: var(--text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cmdk-item-sub { font-size: 0.8rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
.cmdk-item-sub mark, .cmdk-item .cmdk-item-sub mark { background: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--text-color); border-radius: 3px; padding: 0 2px; }
.cmdk-item-hint { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.72rem; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-bg); color: var(--text-muted); }
.cmdk-empty { padding: 14px 12px; color: var(--text-muted); font-size: 0.85rem; }
.cmdk-shortcuts { padding: 4px 6px 8px; }
.cmdk-shortcut { display: flex; align-items: center; gap: 12px; padding: 6px 6px; }
.cmdk-shortcut kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.72rem; padding: 2px 7px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-bg); color: var(--text-color); min-width: 84px; text-align: center; }
.cmdk-shortcut span { color: var(--text-muted); font-size: 0.88rem; }
.cmdk-footer { display: flex; gap: 16px; padding: 10px 14px; border-top: 1px solid var(--border-subtle); color: var(--text-muted); font-size: 0.72rem; }
.cmdk-footer kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 1px 5px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface-bg); margin-right: 3px; }
"""


JS = """
(function() {
  function getSystemTheme() {
    try {
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  function getStoredTheme() {
    try {
      var t = localStorage.getItem('theme');
      return (t === 'light' || t === 'dark') ? t : null;
    } catch (e) {
      return null;
    }
  }

  function setStoredTheme(theme) {
    try {
      if (theme === 'light' || theme === 'dark') localStorage.setItem('theme', theme);
      else localStorage.removeItem('theme');
    } catch (e) {}
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function updateThemeToggleLabel(btn) {
    var stored = getStoredTheme();
    var effective = stored || getSystemTheme();
    var modeLabel = stored ? stored : ('system (' + effective + ')');
    var hint = stored ? ' (click to toggle, shift-click for system)' : ' (click to toggle)';
    var title = 'Theme: ' + modeLabel + hint;
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }

  function setupThemeToggle() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;

    updateThemeToggleLabel(btn);

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      if (e.shiftKey) {
        setStoredTheme(null);
        applyTheme(null);
        updateThemeToggleLabel(btn);
        return;
      }
      var stored = getStoredTheme();
      var effective = stored || getSystemTheme();
      var next = effective === 'dark' ? 'light' : 'dark';
      setStoredTheme(next);
      applyTheme(next);
      updateThemeToggleLabel(btn);
    });

    try {
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var handler = function() {
          if (!getStoredTheme()) updateThemeToggleLabel(btn);
        };
        if (mq.addEventListener) mq.addEventListener('change', handler);
        else if (mq.addListener) mq.addListener(handler);
      }
    } catch (e) {}
  }

  function formatTimestamp(ts) {
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      return d.toLocaleString();
    } catch (e) {
      return ts;
    }
  }

  function updateTruncatables(root) {
    var scope = root || document;
    scope.querySelectorAll('.truncatable').forEach(function(el) {
      var content = el.querySelector('.truncatable-content');
      if (!content) return;
      var needs = content.scrollHeight > 240;
      if (needs && !el.classList.contains('expanded')) {
        el.classList.add('truncated');
      }
      var btn = el.querySelector('.expand-btn');
      if (!btn) return;
      btn.onclick = function() {
        el.classList.toggle('expanded');
        el.classList.toggle('truncated');
        btn.textContent = el.classList.contains('expanded') ? 'Show less' : 'Show more';
      };
    });
  }

  function enhance(root) {
    var scope = root || document;
    scope.querySelectorAll('time[data-timestamp]').forEach(function(t) {
      t.textContent = formatTimestamp(t.getAttribute('data-timestamp'));
    });
    updateTruncatables(scope);
  }

  // Expose for dynamically-inserted content (e.g. lazy-loaded conversation groups).
  window.__codexTranscriptsEnhance = enhance;

  // Expose theme controls so the command palette can drive them.
  window.__ctTheme = {
    toggle: function() {
      var stored = getStoredTheme();
      var effective = stored || getSystemTheme();
      var next = effective === 'dark' ? 'light' : 'dark';
      setStoredTheme(next);
      applyTheme(next);
      return next;
    },
    system: function() {
      setStoredTheme(null);
      applyTheme(null);
      return 'system';
    },
    effective: function() {
      return getStoredTheme() || getSystemTheme();
    }
  };

  enhance(document);
  setupThemeToggle();
})();
"""
