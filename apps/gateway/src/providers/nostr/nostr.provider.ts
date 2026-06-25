import type {
  GatewayProvider,
  GatewayTransport,
  GatewayCapability,
  ProviderConfig,
  NormalizedInbound,
  OutboundTarget,
  MessageContent,
} from '../gateway-provider.interface.js';
import type { GatewayChatService } from '../../chat/gateway-chat.service.js';
import { verifyNostrEvent } from '@eve/shared';
import type { NostrEvent } from '@eve/shared';

// ---------------------------------------------------------------------------
// nostr-tools lazy imports
//
// nostr-tools uses subpath exports (nostr-tools/pure, nostr-tools/pool,
// nostr-tools/nip04) which are not resolvable by TypeScript under
// moduleResolution: "node" (CJS). We use dynamic import() at runtime
// (which works because Node respects package.json exports) and cache
// the result. Typed as `any` to avoid fighting the module resolution.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _nostrPure: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _nostrPool: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _nostrNip04: any = null;

/**
 * Dynamic import wrapper that bypasses TypeScript's module resolution.
 * At runtime, Node.js resolves subpath exports correctly via package.json "exports".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importModule(specifier: string): Promise<any> {
  return import(specifier);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getNostrPure(): Promise<any> {
  if (!_nostrPure) _nostrPure = await importModule('nostr-tools/pure');
  return _nostrPure;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getNostrPool(): Promise<any> {
  if (!_nostrPool) _nostrPool = await importModule('nostr-tools/pool');
  return _nostrPool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getNostrNip04(): Promise<any> {
  if (!_nostrNip04) _nostrNip04 = await importModule('nostr-tools/nip04');
  return _nostrNip04;
}

// ---------------------------------------------------------------------------
// Nostr Gateway Provider
// ---------------------------------------------------------------------------

/**
 * Nostr Gateway Provider
 *
 * Implements the GatewayProvider interface for Nostr's subscription-based transport.
 * Connects to one or more relays via a SimplePool, subscribes to encrypted DMs (kind 4)
 * and public mentions (kind 1) addressed to the platform pubkey, normalizes events,
 * and routes them through GatewayChatService.
 *
 * Outbound messages are published as kind 4 (DM) or kind 1 (public reply) events
 * signed with the platform private key.
 */
export class NostrGatewayProvider implements GatewayProvider {
  readonly name = 'nostr';
  readonly transport: GatewayTransport = 'subscription';
  readonly capabilities: GatewayCapability[] = ['inbound', 'outbound', 'identity'];

  private relayUrls: string[] = [];
  private platformPubkey = '';
  private platformPrivkeyHex = '';
  private platformPrivkeyBytes: Uint8Array | null = null;

  // nostr-tools pool instance (typed as any to avoid ESM type resolution issues)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pool: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private subscription: any = null;

  private chatService: GatewayChatService;

  // Cross-relay event dedup: bounded set with FIFO eviction
  private recentEventIds = new Set<string>();
  private recentEventQueue: string[] = [];
  private readonly MAX_RECENT_EVENTS = 10_000;

  constructor(chatService: GatewayChatService) {
    this.chatService = chatService;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(config: ProviderConfig): Promise<void> {
    this.platformPubkey = config.integration.account_id;
    this.platformPrivkeyHex = config.settings['privkey'] as string;
    this.relayUrls = (config.settings['relays'] as string[]) ?? [];

    if (!this.platformPubkey) {
      throw new Error(`Nostr integration ${config.integration.id}: missing account_id (platform pubkey)`);
    }
    if (!this.platformPrivkeyHex) {
      throw new Error(`Nostr integration ${config.integration.id}: missing privkey in settings`);
    }
    if (!this.relayUrls.length) {
      throw new Error(`Nostr integration ${config.integration.id}: no relay URLs configured`);
    }

    // Convert hex private key to bytes for event signing
    this.platformPrivkeyBytes = hexToBytes(this.platformPrivkeyHex);

    const { SimplePool } = await getNostrPool();
    this.pool = new SimplePool();

    // Subscribe to:
    //   - Kind 4 (NIP-04 encrypted DM) addressed to our platform pubkey
    //   - Kind 1 (text note) mentioning our platform pubkey via #p tag
    this.subscription = this.pool.subscribe(
      this.relayUrls,
      [
        { kinds: [4], '#p': [this.platformPubkey] },
        { kinds: [1], '#p': [this.platformPubkey] },
      ],
      {
        onevent: (event: NostrEvent) => {
          this.handleRelayEvent(event).catch((err: unknown) => {
            console.error(`[nostr] Event handling error:`, err);
          });
        },
      },
    );

    console.log(`[nostr] Connected to ${this.relayUrls.length} relay(s), listening as ${this.platformPubkey.slice(0, 12)}...`);
  }

  async shutdown(): Promise<void> {
    if (this.subscription?.close) {
      this.subscription.close();
    }
    this.subscription = null;

    if (this.pool) {
      this.pool.close(this.relayUrls);
      this.pool = null;
    }

    this.recentEventIds.clear();
    this.recentEventQueue = [];
  }

  // -------------------------------------------------------------------------
  // Outbound messaging
  // -------------------------------------------------------------------------

  async sendMessage(target: OutboundTarget, content: MessageContent): Promise<void> {
    if (!this.pool || !this.platformPrivkeyBytes) return;

    const { finalizeEvent } = await getNostrPure();
    const isDM = target.channel.startsWith('dm:');
    const recipientPubkey = isDM ? target.channel.slice(3) : undefined;

    if (isDM && recipientPubkey) {
      // NIP-04 encrypted DM (kind 4)
      const nip04 = await getNostrNip04();
      const encrypted = nip04.encrypt(this.platformPrivkeyHex, recipientPubkey, content.text);

      const signed = finalizeEvent(
        {
          kind: 4,
          content: encrypted,
          tags: [['p', recipientPubkey]],
          created_at: Math.floor(Date.now() / 1000),
        },
        this.platformPrivkeyBytes,
      );

      await Promise.any(this.pool.publish(this.relayUrls, signed)).catch(() => {
        console.error(`[nostr] Failed to publish DM to ${recipientPubkey.slice(0, 12)}...`);
      });
    } else {
      // Public reply (kind 1) with NIP-10 threading tags
      const tags = this.buildReplyTags(target);
      const signed = finalizeEvent(
        {
          kind: 1,
          content: content.text,
          tags,
          created_at: Math.floor(Date.now() / 1000),
        },
        this.platformPrivkeyBytes,
      );

      await Promise.any(this.pool.publish(this.relayUrls, signed)).catch(() => {
        console.error(`[nostr] Failed to publish reply`);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Inbound event handling
  // -------------------------------------------------------------------------

  private async handleRelayEvent(event: NostrEvent): Promise<void> {
    // 1. Verify event signature + ID integrity
    if (!verifyNostrEvent(event)) return;

    // 2. Ignore our own events (echo suppression)
    if (event.pubkey === this.platformPubkey) return;

    // 3. Cross-relay dedup -- same event may arrive from multiple relays
    if (this.recentEventIds.has(event.id)) return;
    this.trackRecentEvent(event.id);

    // 4. Extract message text (decrypt DMs, pass through public notes)
    let text = event.content;
    if (event.kind === 4) {
      text = await this.decryptDM(event);
    }

    // 5. Normalize into the common inbound shape
    const inbound: NormalizedInbound = {
      rawType: `kind:${event.kind}`,
      provider: 'nostr',
      accountId: this.platformPubkey,
      externalUserId: event.pubkey,
      channel: event.kind === 4 ? `dm:${event.pubkey}` : this.extractChannel(event),
      threadId: this.extractThreadId(event),
      text,
      agentSlugHint: this.extractAgentSlug(event, text),
      dedupeKey: `nostr:${event.id}`,
      raw: event,
    };

    // 6. Route through the shared chat service
    const result = await this.chatService.resolveAndRoute(inbound);

    // 7. Send immediate reply if the service produced one
    if (result.immediateReply) {
      await this.sendMessage(
        {
          provider: 'nostr',
          accountId: inbound.accountId,
          channel: inbound.channel,
          threadId: inbound.threadId,
        },
        result.immediateReply,
      );
    }
  }

  // -------------------------------------------------------------------------
  // NIP-10 thread extraction
  // -------------------------------------------------------------------------

  /**
   * Extract channel identifier from a public event.
   *
   * NIP-10 defines 'e' tags with positional markers: 'root' for the thread root.
   * If a root tag exists, the channel is the thread. Otherwise, events addressed
   * to our pubkey are grouped under a synthetic channel.
   */
  private extractChannel(event: NostrEvent): string {
    const rootTag = event.tags.find(
      (t: string[]) => t[0] === 'e' && t[3] === 'root',
    );
    if (rootTag) return `thread:${rootTag[1]}`;
    return `public:${this.platformPubkey}`;
  }

  /**
   * Extract thread ID for reply threading.
   *
   * NIP-10 preferred: 'e' tag with 'root' marker.
   * Fallback: first 'e' tag (positional convention).
   */
  private extractThreadId(event: NostrEvent): string | undefined {
    const rootTag = event.tags.find(
      (t: string[]) => t[0] === 'e' && t[3] === 'root',
    );
    if (rootTag) return rootTag[1];
    const firstE = event.tags.find((t: string[]) => t[0] === 'e');
    return firstE?.[1];
  }

  // -------------------------------------------------------------------------
  // Agent slug extraction
  // -------------------------------------------------------------------------

  /**
   * Extract an agent slug hint from the message text.
   *
   * DM patterns:
   *   "/slug ..."        -> slug
   *   "slug: ..."        -> slug
   *
   * Public mention patterns:
   *   Strip nostr: URIs (npub/nprofile/note/nevent), then take the first
   *   word if it looks like a valid slug (lowercase alphanumeric + hyphens).
   */
  private extractAgentSlug(event: NostrEvent, text: string): string | undefined {
    const trimmed = text.trim();

    if (event.kind === 4) {
      // DM: explicit slug prefix
      const slashMatch = trimmed.match(/^\/(\S+)/);
      if (slashMatch) return slashMatch[1];
      const colonMatch = trimmed.match(/^(\S+):\s/);
      if (colonMatch) return colonMatch[1];
      return undefined;
    }

    // Public mention: strip nostr: URIs and check first word
    const stripped = trimmed
      .replace(/nostr:(npub|nprofile|note|nevent)\w+/g, '')
      .trim();
    const firstWord = stripped.match(/^(\S+)/);
    if (
      firstWord &&
      firstWord[1].length <= 64 &&
      /^[a-z0-9-]+$/.test(firstWord[1])
    ) {
      return firstWord[1];
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // DM decryption
  // -------------------------------------------------------------------------

  private async decryptDM(event: NostrEvent): Promise<string> {
    try {
      const nip04 = await getNostrNip04();
      return nip04.decrypt(this.platformPrivkeyHex, event.pubkey, event.content);
    } catch {
      return '[encrypted message - decryption failed]';
    }
  }

  // -------------------------------------------------------------------------
  // Reply tag construction
  // -------------------------------------------------------------------------

  /**
   * Build NIP-10 reply tags for outbound events.
   *
   * If the target has a threadId (the root event), include an 'e' tag with
   * the 'root' marker so clients can thread the conversation.
   */
  private buildReplyTags(target: OutboundTarget): string[][] {
    const tags: string[][] = [];
    if (target.threadId) {
      tags.push(['e', target.threadId, '', 'root']);
    }
    // Tag the channel's pubkey context if it's a public channel
    if (!target.channel.startsWith('dm:')) {
      // Extract recipient pubkey from target context if available
      const channelParts = target.channel.split(':');
      if (channelParts.length === 2 && channelParts[0] === 'public') {
        // No additional p-tag needed for public channel replies
      }
    }
    return tags;
  }

  // -------------------------------------------------------------------------
  // Event dedup
  // -------------------------------------------------------------------------

  private trackRecentEvent(eventId: string): void {
    this.recentEventIds.add(eventId);
    this.recentEventQueue.push(eventId);
    if (this.recentEventQueue.length > this.MAX_RECENT_EVENTS) {
      const oldest = this.recentEventQueue.shift();
      if (oldest) this.recentEventIds.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
