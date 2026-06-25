/**
 * Gateway Provider Interface
 *
 * Abstracts inbound/outbound message handling for different chat platforms
 * (Slack, Nostr, Telegram, etc.). Each provider implements its own transport
 * model (webhook push or relay subscription) while normalizing messages into
 * a common NormalizedInbound shape for shared routing logic.
 */

import type { ChatFile, FileResolveContext } from '@eve/shared';

// ---------------------------------------------------------------------------
// Transport & Capability types
// ---------------------------------------------------------------------------

export type GatewayTransport = 'webhook' | 'subscription';

export type GatewayCapability = 'inbound' | 'outbound' | 'identity' | 'presence';

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface GatewayProvider {
  /** Provider name -- matches integrations.provider column */
  readonly name: string;

  /** Transport model: 'webhook' for HTTP push, 'subscription' for persistent connections */
  readonly transport: GatewayTransport;

  /** Supported capabilities */
  readonly capabilities: GatewayCapability[];

  /**
   * Initialize the provider for a specific integration.
   * - Webhook providers: validate config, store signing secrets.
   * - Subscription providers: connect to relays/servers, start subscriptions.
   */
  initialize(config: ProviderConfig): Promise<void>;

  /** Graceful shutdown */
  shutdown(): Promise<void>;

  // --- Webhook transport methods (only for transport === 'webhook') ----------

  /**
   * Validate an inbound webhook signature.
   * Called before parsing -- rejects unsigned/tampered requests early.
   */
  validateWebhook?(req: WebhookRequest): WebhookValidation;

  /**
   * Parse a validated webhook payload into a normalized message.
   * Returns 'handshake' for protocol handshakes (e.g. Slack url_verification),
   * 'ignored' for events we should silently drop (bot messages, subtypes),
   * or 'message' with the normalized inbound for real user messages.
   */
  parseWebhook?(req: WebhookRequest): Promise<WebhookParseResult>;

  // --- Shared methods -------------------------------------------------------

  /**
   * Send a message via this provider (replies, notifications, proactive).
   */
  sendMessage(target: OutboundTarget, content: MessageContent): Promise<void>;

  /**
   * Resolve an external user identity to an Eve identity.
   * Optional -- only for providers that support identity resolution.
   */
  resolveIdentity?(externalUserId: string, accountId: string): Promise<ResolvedIdentity | null>;

  /**
   * Download provider-hosted files and upload to Eve storage.
   * Called in the async phase after webhook acknowledgement.
   * Returns files with provider URLs replaced by eve-storage:// refs.
   *
   * Providers that don't support files can omit this method.
   */
  resolveFiles?(files: ChatFile[], context: FileResolveContext): Promise<ChatFile[]>;
}

// ---------------------------------------------------------------------------
// Webhook types
// ---------------------------------------------------------------------------

/** Minimal request shape for webhook validation/parsing (Fastify-compatible). */
export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string;
}

export type WebhookValidation =
  | { valid: true }
  | { valid: false; status: number; body?: unknown };

export type WebhookParseResult =
  | { type: 'message'; inbound: NormalizedInbound }
  | { type: 'handshake'; response: { status: number; body: unknown } }
  | { type: 'ignored' };

// ---------------------------------------------------------------------------
// Normalized inbound message
// ---------------------------------------------------------------------------

export interface NormalizedInbound {
  /** Raw provider event type for logging (e.g. 'app_mention', 'message') */
  rawType: string;

  /** Provider name */
  provider: string;

  /** Integration account ID (Slack team_id, Nostr destination pubkey, etc.) */
  accountId: string;

  /** External user ID in the provider */
  externalUserId: string;

  /** Channel/room/relay identifier */
  channel: string;

  /** Thread identifier (for threading support) */
  threadId?: string;

  /** Extracted text content */
  text: string;

  /** Extracted agent slug hint (e.g. from @mention or DM context) */
  agentSlugHint?: string;

  /** Command text after stripping the agent slug prefix */
  commandText?: string;

  /** Provider-specific event ID for deduplication */
  dedupeKey?: string;

  /** Emoji reaction name (for reaction_added events) */
  reaction?: string;

  /** File attachments from the message (Slack file uploads, etc.) */
  files?: ChatFile[];

  /** Email hint for Tier 1 auto-match (skips Slack users.info API call in simulate mode) */
  externalEmail?: string;

  /** Raw payload for provider-specific processing */
  raw: unknown;

  // --- Populated by GatewayChatService after identity resolution -----------

  /** External identity row ID */
  externalIdentityId?: string;

  /** Linked Eve user ID (null if unlinked) */
  eveUserId?: string | null;

  /** Membership request ID (null if not applicable) */
  membershipRequestId?: string | null;
}

// ---------------------------------------------------------------------------
// Outbound types
// ---------------------------------------------------------------------------

export interface OutboundTarget {
  provider: string;
  accountId: string;
  channel: string;
  threadId?: string;
}

export interface MessageContent {
  text: string;
  /** Provider-specific formatting hints (Slack blocks, Nostr tags, etc.) */
  blocks?: unknown;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  /** Integration record from DB */
  integration: {
    id: string;
    org_id: string;
    provider: string;
    account_id: string;
    tokens_json: Record<string, unknown> | null;
    status: string;
  };
  /** Provider-specific config from integration.tokens_json or system env */
  settings: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

export interface ResolvedIdentity {
  externalIdentityId: string;
  eveUserId: string | null;
  membershipRequestId?: string | null;
  orgId: string;
}

// ---------------------------------------------------------------------------
// Simulate types
// ---------------------------------------------------------------------------

export interface SimulateRequest {
  provider?: string;        // default: 'slack'
  account_id: string;       // team_id equivalent
  channel_id?: string;
  user_id?: string;
  text: string;
  external_email?: string;  // Tier 1: email hint (skips Slack API)
  event_type?: string;      // default: 'app_mention'
  thread_id?: string;
  dedupe_key?: string;
}

export interface SimulateResponse {
  immediate_reply: MessageContent | null;
  duplicate: boolean;
  route: {
    thread_id: string;
    route_id: string | null;
    target: string | null;
    job_ids: string[];
    event_id: string | null;
    denied?: boolean;
    denial_reason?: string;
  } | null;
}
