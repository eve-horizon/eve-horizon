/**
 * Result extraction utilities for parsing harness execution logs.
 *
 * Handles Claude, Codex (item.completed), and NormalizedEvent formats.
 * Extracted from the worker's invoke.service.ts (the superset implementation).
 */

import type { LogEntry, ExtractedResult } from './types.js';

/**
 * Extracts the final assistant message text from logs.
 * Looks for the last message with type 'assistant' that contains text content.
 *
 * Supported formats:
 * - Claude/mclaude/zai: {raw: {type: "assistant", message: {content: [{type: "text", text: "..."}]}}}
 * - Codex: {raw: {type: "item.completed", item: {type: "agent_message", text: "..."}}}
 * - NormalizedEvent: {kind: "assistant", raw: {item: {text: "..."}}} or {kind: "assistant", raw: {msg: {text: "..."}}}
 */
export function extractResultText(logs: LogEntry[]): string | undefined {
  const assistantMsgs: string[] = [];

  for (const l of logs) {
    const content = l.content as Record<string, unknown>;
    const raw = content?.raw as Record<string, unknown> | undefined;
    if (!raw) continue;

    // Claude/mclaude/zai format: {raw: {type: "assistant", message: {content: [{type: "text", text: "..."}]}}}
    if (raw.type === 'assistant' && raw.message) {
      const message = raw.message as Record<string, unknown>;
      const messageContent = message?.content;
      if (!Array.isArray(messageContent)) continue;
      const text = messageContent
        .filter((c: unknown) => (c as Record<string, unknown>)?.type === 'text')
        .map((c: unknown) => (c as Record<string, unknown>)?.text ?? '')
        .join('\n');
      if (text) assistantMsgs.push(text);
      continue;
    }

    // Codex format: {raw: {type: "item.completed", item: {type: "agent_message", text: "..."}}}
    if (raw.type === 'item.completed') {
      const item = raw.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        assistantMsgs.push(item.text);
      }
      continue;
    }

    // NormalizedEvent format: {kind: "assistant", raw: {...}} where outer content has kind field
    if (content?.kind === 'assistant' && raw) {
      // Check for Codex item text
      const item = raw.item as Record<string, unknown> | undefined;
      if (item && typeof item.text === 'string' && item.text) {
        assistantMsgs.push(item.text);
        continue;
      }
      // Check for msg-style text
      const msg = raw.msg as Record<string, unknown> | undefined;
      if (msg && typeof msg.text === 'string' && msg.text) {
        assistantMsgs.push(msg.text);
        continue;
      }
    }
  }

  return assistantMsgs.at(-1);
}

/**
 * Extracts JSON result from a fenced code block tagged `json-result`.
 * Format:
 * ```json-result
 * {"key": "value"}
 * ```
 */
export function extractResultJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;

  // Match ```json-result ... ``` blocks
  const jsonResultRegex = /```json-result\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  let lastJson: Record<string, unknown> | undefined;

  while ((match = jsonResultRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (typeof parsed === 'object' && parsed !== null) {
        lastJson = parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  return lastJson;
}

/**
 * Extracts token usage from logs.
 * Handles multiple formats:
 * - llm.call: {usage: {input_tokens, output_tokens}} (normalized events)
 * - Claude: {raw: {message: {usage: {input_tokens, output_tokens}}}}
 * - Codex: {raw: {usage: {input_tokens, output_tokens}}} (turn.completed events)
 */
export function extractTokenUsage(logs: LogEntry[]): { input: number; output: number } {
  let input = 0;
  let output = 0;

  for (const l of logs) {
    const content = l.content as Record<string, unknown>;
    let usage: Record<string, unknown> | undefined;

    // llm.call events stored at top level
    if (l.type === 'llm.call' && content?.usage) {
      usage = content.usage as Record<string, unknown>;
    } else {
      const raw = content?.raw as Record<string, unknown> | undefined;
      if (!raw) continue;

      // Claude format: raw.message.usage
      const message = raw.message as Record<string, unknown> | undefined;
      if (message?.usage) {
        usage = message.usage as Record<string, unknown>;
      }
      // Codex format: raw.usage (turn.completed events)
      else if (raw.usage) {
        usage = raw.usage as Record<string, unknown>;
      }
    }

    if (usage) {
      input += Number(usage.input_tokens) || 0;
      output += Number(usage.output_tokens) || 0;
    }
  }

  return { input, output };
}

/**
 * Extracts error message from system_error logs or the last error event.
 * Handles system_error, spawn_error, and event-level errors (stderr, result with is_error, assistant error messages).
 */
export function extractErrorMessage(logs: LogEntry[]): string | undefined {
  // Look for system_error logs (stderr output)
  const errorLogs = logs.filter((l) => l.type === 'system_error');
  if (errorLogs.length > 0) {
    const messages = errorLogs
      .map((l) => {
        const content = l.content as Record<string, unknown>;
        return String(content?.content ?? '').trim();
      })
      .filter(Boolean);
    if (messages.length > 0) {
      return messages.join('\n');
    }
  }

  // Look for spawn_error
  const spawnError = logs.find((l) => l.type === 'spawn_error');
  if (spawnError) {
    const content = spawnError.content as Record<string, unknown>;
    return String(content?.error ?? '');
  }

  const eventErrors = logs
    .filter((l) => l.type === 'event')
    .map((l) => l.content as Record<string, unknown>)
    .map((content) => content.raw as Record<string, unknown> | undefined)
    .filter(Boolean)
    .map((raw) => {
      if (raw?.type === 'stderr' && typeof raw?.content === 'string') {
        return raw.content;
      }
      if (raw?.type === 'result' && raw?.is_error && typeof raw?.result === 'string') {
        return raw.result;
      }
      if (raw?.type === 'assistant') {
        const message = raw.message as Record<string, unknown> | undefined;
        const contentItems = message?.content;
        if (Array.isArray(contentItems)) {
          const text = contentItems
            .map((item) => (item as Record<string, unknown>)?.text)
            .filter((value) => typeof value === 'string')
            .join('\n');
          if (text) return text;
        }
      }
      return undefined;
    })
    .filter((value): value is string => Boolean(value));

  if (eventErrors.length > 0) {
    return eventErrors.at(-1);
  }

  return undefined;
}

/**
 * Extracts result data from execution logs.
 * Combines result text, JSON, token usage, and error extraction into a single call.
 */
export function extractResults(logs: LogEntry[]): ExtractedResult {
  const resultText = extractResultText(logs);
  const resultJson = extractResultJson(resultText);
  const tokens = extractTokenUsage(logs);
  const errorMessage = extractErrorMessage(logs);

  return {
    resultText,
    resultJson,
    tokenInput: tokens.input,
    tokenOutput: tokens.output,
    errorMessage,
  };
}
