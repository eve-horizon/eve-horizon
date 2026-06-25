/**
 * Slack formatting utilities.
 *
 * Converts Markdown to Slack mrkdwn and builds Block Kit payloads.
 */

// ---------------------------------------------------------------------------
// Markdown → Slack mrkdwn conversion
// ---------------------------------------------------------------------------

/**
 * Convert standard Markdown to Slack mrkdwn syntax.
 *
 * Handles: bold, links, and code blocks. Italic and inline code are
 * identical between Markdown and mrkdwn so they pass through unchanged.
 */
export function markdownToMrkdwn(md: string): string {
  let result = md;

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Bold: **text** → *text* (careful not to touch single * for italic)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  return result;
}

// ---------------------------------------------------------------------------
// Block Kit builders
// ---------------------------------------------------------------------------

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
  [key: string]: unknown;
}

/** Build a section block with mrkdwn text. */
export function sectionBlock(text: string): SlackBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
  };
}

/** Build a context block with mrkdwn elements. */
export function contextBlock(...elements: string[]): SlackBlock {
  return {
    type: 'context',
    elements: elements.map((text) => ({ type: 'mrkdwn', text })),
  };
}

// ---------------------------------------------------------------------------
// Pre-built message formats
// ---------------------------------------------------------------------------

/** Format a job-routed reply as Block Kit blocks with fallback text. */
export function formatJobRouted(
  jobIds: string[],
  routeId: string | null,
  agentSlug?: string,
): { text: string; blocks: SlackBlock[] } {
  const count = jobIds.length;
  const agentPart = agentSlug ? ` for \`${agentSlug}\`` : '';
  const headerText = `Queued *${count}* job${count !== 1 ? 's' : ''}${agentPart}`;

  const contextParts: string[] = [];
  if (jobIds.length > 0) {
    const jobList = jobIds.slice(0, 3).map((id) => `\`${id}\``).join(', ');
    const suffix = jobIds.length > 3 ? ` +${jobIds.length - 3} more` : '';
    contextParts.push(`Job${count !== 1 ? 's' : ''}: ${jobList}${suffix}`);
  }
  if (routeId) {
    contextParts.push(`Route: \`${routeId}\``);
  }

  const blocks: SlackBlock[] = [sectionBlock(headerText)];
  if (contextParts.length > 0) {
    blocks.push(contextBlock(contextParts.join(' | ')));
  }

  // Fallback text for notifications / non-rich clients
  const text = `Queued ${count} job(s)${agentPart ? ` for ${agentSlug}` : ''}. Route: ${routeId ?? 'none'}.`;

  return { text, blocks };
}

/** Format an error reply as a Block Kit section. */
export function formatError(text: string): { text: string; blocks: SlackBlock[] } {
  return {
    text,
    blocks: [sectionBlock(text)],
  };
}

/**
 * Wrap agent reply text with mrkdwn conversion and chunked Block Kit sections.
 *
 * Slack section blocks have a 3000-char limit. For long replies we split on
 * paragraph boundaries into multiple sections (max 50 blocks per message).
 */
export function formatAgentReply(text: string): { text: string; blocks: SlackBlock[] } {
  const converted = markdownToMrkdwn(text);
  const blocks = chunkIntoSectionBlocks(converted);
  return { text: converted, blocks };
}

// ---------------------------------------------------------------------------
// Chunking helpers
// ---------------------------------------------------------------------------

/** Max chars per Slack section block text field. */
const SECTION_BLOCK_LIMIT = 3000;

/** Max blocks Slack allows per message. */
const MAX_BLOCKS = 50;

/**
 * Split long mrkdwn text into multiple section blocks, breaking at paragraph
 * boundaries when possible. Falls back to hard splits if a single paragraph
 * exceeds the limit.
 */
function chunkIntoSectionBlocks(text: string): SlackBlock[] {
  if (text.length <= SECTION_BLOCK_LIMIT) {
    return [sectionBlock(text)];
  }

  const paragraphs = text.split(/\n\n+/);
  const blocks: SlackBlock[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (blocks.length >= MAX_BLOCKS - 1) break;

    // If adding this paragraph would exceed the limit, flush current chunk
    if (current.length > 0 && current.length + 2 + para.length > SECTION_BLOCK_LIMIT) {
      blocks.push(sectionBlock(current));
      current = '';
      if (blocks.length >= MAX_BLOCKS - 1) break;
    }

    // Single paragraph exceeds limit — hard-split it
    if (para.length > SECTION_BLOCK_LIMIT) {
      if (current.length > 0) {
        blocks.push(sectionBlock(current));
        current = '';
        if (blocks.length >= MAX_BLOCKS - 1) break;
      }
      let remaining = para;
      while (remaining.length > 0 && blocks.length < MAX_BLOCKS - 1) {
        blocks.push(sectionBlock(remaining.slice(0, SECTION_BLOCK_LIMIT)));
        remaining = remaining.slice(SECTION_BLOCK_LIMIT);
      }
      continue;
    }

    current = current.length > 0 ? current + '\n\n' + para : para;
  }

  // Flush remaining text
  if (current.length > 0 && blocks.length < MAX_BLOCKS) {
    blocks.push(sectionBlock(current));
  }

  return blocks;
}
