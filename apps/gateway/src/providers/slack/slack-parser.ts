/**
 * Slack event parsing utilities.
 *
 * Extracts agent commands from Slack @mention text and classifies
 * agent management commands (agents list, listen, unlisten, listening).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackEventCallbackPayload {
  type: 'event_callback';
  team_id?: string;
  event_id: string;
  event_time?: number;
  event: {
    type: string;
    user?: string;
    bot_id?: string;
    channel?: string;
    thread_ts?: string;
    ts?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SlackUrlVerificationPayload {
  type: 'url_verification';
  challenge: string;
  token?: string;
}

export type SlackWebhookPayload = SlackUrlVerificationPayload | SlackEventCallbackPayload;

export type AgentsCommand =
  | { type: 'directory' }
  | { type: 'listen'; slug: string }
  | { type: 'unlisten'; slug: string }
  | { type: 'listening' }
  | { type: 'invalid'; message: string };

export interface ParsedAgentCommand {
  /** Full text after the @mention */
  raw: string;
  /** First token (agent slug or "agents") */
  first: string;
  /** Remaining text after the first token */
  rest: string;
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

/** Check if a Slack event was sent by a bot (should be ignored). */
export function isBotEvent(event: SlackEventCallbackPayload['event']): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const record = event as Record<string, unknown>;
  if (record.bot_id) {
    return true;
  }
  if (typeof record.subtype === 'string' && record.subtype === 'bot_message') {
    return true;
  }
  return false;
}

/** Check if a message event is a plain user message (no subtype, has text). */
export function isPlainMessageEvent(event: SlackEventCallbackPayload['event']): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const record = event as Record<string, unknown>;
  if (record.type !== 'message') {
    return false;
  }
  if (typeof record.subtype === 'string') {
    return false;
  }
  if (typeof record.text !== 'string' || record.text.trim().length === 0) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/** Extract the text content from a Slack event payload. */
export function extractText(payload: SlackEventCallbackPayload): string {
  const event = payload.event as Record<string, unknown>;
  if (typeof event.text === 'string' && event.text.trim().length > 0) {
    return event.text;
  }
  return '[slack event]';
}

// ---------------------------------------------------------------------------
// Agent command parsing
// ---------------------------------------------------------------------------

/**
 * Parse an @agent command from Slack text.
 *
 * Slack @mentions look like `<@U12345> some text` or `@bot some text`.
 * Returns the text after the mention, split into the first token (slug)
 * and the rest. Returns null if the text doesn't start with an @mention
 * or has no content after it.
 */
export function parseAgentCommand(text: string): ParsedAgentCommand | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  let remainder: string | null = null;
  if (trimmed.startsWith('<@')) {
    const end = trimmed.indexOf('>');
    if (end === -1) return null;
    remainder = trimmed.slice(end + 1).trim();
  } else if (trimmed.startsWith('@')) {
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) return null;
    remainder = trimmed.slice(firstSpace + 1).trim();
  } else {
    return null;
  }

  if (!remainder) {
    return null;
  }

  const [first, ...restTokens] = remainder.split(/\s+/);
  if (!first) {
    return null;
  }

  return {
    raw: remainder,
    first,
    rest: restTokens.join(' ').trim(),
  };
}

/**
 * Parse an "agents" management command from the raw command text.
 *
 * Recognized commands:
 *   agents             -> directory listing
 *   agents list        -> directory listing
 *   agents listen <s>  -> subscribe agent <s> to channel/thread
 *   agents track <s>   -> alias for listen
 *   agents unlisten <s> -> unsubscribe agent <s>
 *   agents untrack <s> -> alias for unlisten
 *   agents listening   -> list active listeners
 *   agents listeners   -> alias for listening
 *   agents tracking    -> alias for listening
 */
export function parseAgentsCommand(raw: string): AgentsCommand | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  const first = tokens[0].toLowerCase();
  if (first !== 'agents') {
    return null;
  }
  if (tokens.length === 1) {
    return { type: 'directory' };
  }

  const action = tokens[1].toLowerCase();
  if (action === 'list') {
    return { type: 'directory' };
  }
  if (action === 'listen' || action === 'track') {
    const slug = tokens[2];
    if (!slug) {
      return { type: 'invalid', message: 'Usage: @eve agents listen <agent-slug>' };
    }
    return { type: 'listen', slug };
  }
  if (action === 'unlisten' || action === 'untrack') {
    const slug = tokens[2];
    if (!slug) {
      return { type: 'invalid', message: 'Usage: @eve agents unlisten <agent-slug>' };
    }
    return { type: 'unlisten', slug };
  }
  if (action === 'listening' || action === 'listeners' || action === 'tracking') {
    return { type: 'listening' };
  }

  return { type: 'invalid', message: 'Unknown agents command. Try @eve agents list.' };
}
