/**
 * Log normalization for Eve stream events.
 *
 * Converts raw harness log entries (Claude Code transcripts, Codex events,
 * lifecycle phases, LLM calls) into a uniform shape that any consumer can
 * render without harness-specific knowledge.
 *
 * Used by:
 *  - Eve API (adds `text` field to stream/REST log responses)
 *  - Eve CLI (rich terminal formatting on top of NormalizedLogEvent)
 */

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Normalized harness event — a common shape that all formatters can consume.
 * The `type` field maps to the categories the CLI formatters understand
 * (assistant, tool_use, tool_result, error, status, etc.).
 */
export type NormalizedLogEvent = {
  type: string;
  message?: string;
  tool?: string;
  toolInput?: string;
  raw: Record<string, unknown>;
};

// ── normalizeLogLine ─────────────────────────────────────────────────────────

/**
 * Normalize a stored log line (which may be a NormalizedEvent from eve-agent-cli)
 * into a shape the CLI formatters understand.
 *
 * eve-agent-cli wraps harness output as: {seq, ts, kind, raw: <original_event>, tool?, ...}
 * This function detects that wrapper and maps it to the flat format the CLI expects.
 */
export function normalizeLogLine(line: Record<string, unknown>): NormalizedLogEvent {
  const kind = line.kind as string | undefined;
  const raw = line.raw as Record<string, unknown> | undefined;

  // Not a NormalizedEvent wrapper — return as-is
  if (!kind || !raw) {
    return {
      type: (line.type as string) || 'log',
      message: (line.message as string) || (line.text as string) || undefined,
      tool: line.tool as string | undefined,
      toolInput: line.tool_input as string | undefined,
      raw: line,
    };
  }

  // It's a NormalizedEvent from eve-agent-cli. Map based on kind + raw content.
  const rawType = raw.type as string | undefined;
  const item = raw.item as Record<string, unknown> | undefined;

  // Codex: item.completed events
  if (rawType === 'item.completed' && item) {
    const itemType = item.type as string | undefined;

    // Agent text message
    if (itemType === 'agent_message' && typeof item.text === 'string') {
      return { type: 'assistant', message: item.text, raw: line };
    }

    // Command execution (tool use equivalent)
    if (itemType === 'command_execution') {
      const cmd = item.command as string | undefined;
      const exitCode = item.exit_code as number | undefined;
      const status = item.status as string | undefined;
      if (status === 'completed' || exitCode !== undefined) {
        return { type: 'tool_result', message: `exit ${exitCode ?? '?'}`, tool: 'bash', toolInput: cmd, raw: line };
      }
      return { type: 'tool_use', tool: 'bash', toolInput: cmd, raw: line };
    }

    // File change
    if (itemType === 'file_change') {
      const changes = item.changes as Array<Record<string, unknown>> | undefined;
      if (changes?.length) {
        const summary = changes.map(c => {
          const changeKind = c.kind as string || '?';
          const filePath = c.path as string || '';
          const shortPath = filePath.split('/').slice(-3).join('/');
          return `${changeKind}: ${shortPath}`;
        }).join(', ');
        return { type: 'tool_use', tool: 'file_change', toolInput: summary, raw: line };
      }
    }
  }

  // Codex: item.started events (show command being run)
  if (rawType === 'item.started' && item) {
    const itemType = item.type as string | undefined;
    if (itemType === 'command_execution') {
      const cmd = item.command as string | undefined;
      return { type: 'tool_use', tool: 'bash', toolInput: cmd, raw: line };
    }
  }

  // Codex: turn.completed (usage — handled by llm.call path, skip here)
  if (rawType === 'turn.completed') {
    return { type: 'skip', raw: line };
  }

  // Claude-style: raw.type maps directly
  if (rawType === 'assistant') {
    const message = raw.message as { content?: Array<{ text?: string }> } | undefined;
    const text = message?.content?.filter(c => c.text).map(c => c.text).join('\n');
    return { type: 'assistant', message: text || undefined, raw: line };
  }

  // Use the kind from the NormalizedEvent
  if (kind === 'assistant') {
    const msg = raw.msg as Record<string, unknown> | undefined;
    const text = (msg?.text as string) || (item?.text as string) || undefined;
    return { type: 'assistant', message: text, raw: line };
  }

  if (kind === 'tool_use') {
    return { type: 'tool_use', tool: (line.tool as string) || undefined, raw: line };
  }

  if (kind === 'error') {
    return { type: 'error', message: (raw.error as string) || (raw.content as string) || undefined, raw: line };
  }

  // stderr / harness_startup / other system events
  if (rawType === 'stderr') {
    const content = raw.content as string | undefined;
    return { type: 'status', message: content, raw: line };
  }

  if (rawType === 'harness_startup') {
    return { type: 'skip', raw: line };
  }

  return { type: kind || 'log', raw: line };
}

// ── renderLogText ────────────────────────────────────────────────────────────

/**
 * Render a log payload to human-readable text.
 *
 * Takes the full SSE data payload `{ type, line, ... }` and returns a
 * single string (lines joined with \n) or null to indicate the event
 * should be skipped.
 *
 * This is the server-side equivalent of the CLI's formatLogEntry /
 * formatFollowLogLine — but without timestamps, icons, or colors.
 */
export function renderLogText(payload: Record<string, unknown>): string | null {
  const type = payload.type as string | undefined;
  const line = payload.line as Record<string, unknown> | undefined;

  // ── Lifecycle events ────────────────────────────────────────────────────
  if (type?.startsWith('lifecycle_')) {
    return renderLifecycleText(line);
  }

  // ── System events (job completion) ──────────────────────────────────────
  if (type === 'system' && line) {
    if (line.event === 'completed') {
      const exit = line.exitCode as number | undefined;
      return `Job completed (exit code ${exit ?? '?'})`;
    }
    return null;
  }

  // ── LLM call events ────────────────────────────────────────────────────
  if (type === 'llm.call' && line) {
    return renderLlmCallText(line);
  }

  // ── Agent transcript events (type=event) ────────────────────────────────
  if (type === 'event' && line) {
    // eve-agent-cli NormalizedEvent wrappers have a `kind` field — route
    // through normalizeLogLine which understands both Codex and Claude formats
    if (line.kind) {
      return renderNormalizedText(line);
    }
    // Claude Code transcript format (raw.type = assistant/tool_use/user/result)
    return renderTranscriptText(line);
  }

  // ── Fallback: try normalizeLogLine on the line content ─────────────────
  if (line) {
    return renderNormalizedText(line);
  }

  return null;
}

// ── Internal renderers ───────────────────────────────────────────────────────

function renderLifecycleText(line: Record<string, unknown> | undefined): string | null {
  if (!line) return null;

  const phase = line.phase as string | undefined;
  const action = line.action as string | undefined;
  if (!phase || !action) return null;

  const label = capitalize(phase);

  if (action === 'start') {
    return `Starting ${label}...`;
  }

  if (action === 'end') {
    const ms = line.duration_ms as number | undefined;
    const dur = ms != null ? ` (${formatMs(ms)})` : '';
    return line.success !== false
      ? `${label} completed${dur}`
      : `${label} failed${dur}`;
  }

  if (action === 'log') {
    const meta = line.meta as Record<string, unknown> | undefined;
    const msg = (meta?.message as string) || undefined;
    return msg ? `> ${msg}` : null;
  }

  return null;
}

function renderLlmCallText(line: Record<string, unknown>): string | null {
  const usage = (line.usage as Record<string, unknown> | undefined) ?? {};
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;

  if (inputTokens === 0 && outputTokens === 0) return null;

  const source = (line.source as string) === 'managed' ? 'managed' : 'byok';
  const status = (line.status as string) === 'error' ? ' error' : '';
  const byokLabel = source === 'byok' ? ' (BYOK)' : '';

  return `LLM call${byokLabel}${status}: ${formatNumber(inputTokens)} in / ${formatNumber(outputTokens)} out`;
}

/**
 * Render Claude Code transcript events (type=event).
 *
 * These have the structure: { raw: { type: 'assistant'|'tool_use'|'user'|'result', message: ... } }
 */
function renderTranscriptText(line: Record<string, unknown>): string | null {
  const raw = (line.raw ?? line) as Record<string, unknown>;
  const rawType = raw.type as string | undefined;

  // Assistant messages — extract text AND tool use names
  if (rawType === 'assistant') {
    const msg = raw.message as Record<string, unknown> | undefined;
    const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
    const parts: string[] = [];

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && (block.text as string).length > 0) {
        parts.push(block.text as string);
      } else if (block.type === 'tool_use') {
        const name = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        parts.push(`> ${formatToolUse(name, input)}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  // Standalone tool_use events
  if (rawType === 'tool_use') {
    const msg = raw.message as Record<string, unknown> | undefined;
    const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
    const parts: string[] = [];

    for (const block of content) {
      if (block.type === 'tool_use') {
        const name = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        parts.push(`> ${formatToolUse(name, input)}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  // User messages with tool results — show concise outcome
  if (rawType === 'user') {
    const msg = raw.message as Record<string, unknown> | undefined;
    const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
    const parts: string[] = [];

    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const text = (typeof block.content === 'string' ? block.content : '') as string;
      if (!text) continue;

      const isError = block.is_error === true;
      const firstLine = text.split('\n').find(l => l.trim().length > 0) ?? '';
      const truncated = firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
      if (truncated) {
        parts.push(isError ? `  [error] ${truncated}` : `  ${truncated}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  // Result event — show final summary
  if (rawType === 'result') {
    const result = raw.result as string | undefined;
    if (result && result.length > 0) {
      const firstLine = result.split('\n').find(l => l.trim().length > 0) ?? '';
      const truncated = firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
      return truncated || null;
    }
  }

  return null;
}

/**
 * Render events that go through normalizeLogLine (Codex format via eve-agent-cli).
 */
function renderNormalizedText(line: Record<string, unknown>): string | null {
  const normalized = normalizeLogLine(line);

  if (normalized.type === 'skip') return null;

  const message = normalized.message || (line.message as string) || (line.text as string) || '';
  const tool = normalized.tool || (line.tool as string) || undefined;
  const toolInput = normalized.toolInput || (line.tool_input as string) || undefined;

  switch (normalized.type) {
    case 'assistant':
    case 'text':
      return message || null;

    case 'tool_use':
      if (tool) {
        const inputPreview = toolInput
          ? ` ${toolInput.substring(0, 80)}${toolInput.length > 80 ? '...' : ''}`
          : '';
        return `> ${tool}${inputPreview}`;
      }
      return null;

    case 'tool_result': {
      const preview = (normalized.message || '').substring(0, 100);
      return preview ? `  ${preview}` : null;
    }

    case 'error':
      return `Error: ${message || JSON.stringify(line)}`;

    case 'status':
      return message ? `> ${message}` : null;

    default:
      return message || null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatToolUse(
  name: string,
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return name;

  const path =
    (input.file_path as string) ??
    (input.path as string) ??
    (input.pattern as string);
  if (path) return `${name} ${path}`;

  const cmd = input.command as string;
  if (cmd) {
    const short = cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
    return `${name} ${short}`;
  }

  return name;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
