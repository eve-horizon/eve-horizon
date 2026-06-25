import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { Db, Identity } from '@eve/db';
import { replayStoreQueries } from '@eve/db';
import {
  verifyNostrEvent,
  canonicalRequestUrl,
  urlMatches,
  sha256Hex,
  type NostrEvent,
} from '@eve/shared';
import type {
  IdentityProvider,
  ChallengeData,
  ChallengeProof,
  VerifiedIdentity,
  ExtractedCredential,
} from './identity-provider.interface.js';

/**
 * Nostr identity provider — two authentication paths:
 *
 * 1. **Challenge/verify** (login flow):
 *    Server issues a nonce. Client signs a kind-22242 event with
 *    `["challenge", "<nonce>"]` tag and returns the JSON event as `signature`.
 *
 * 2. **NIP-98 request auth** (per-request):
 *    Client sets `Authorization: Nostr <base64(kind-27235-event)>`.
 *    Server verifies signature, URL, method, body hash, timestamp, and
 *    replay protection.
 */
@Injectable()
export class NostrIdentityProvider implements IdentityProvider {
  readonly name = 'nostr';
  private readonly logger = new Logger(NostrIdentityProvider.name);
  private readonly replayStore: ReturnType<typeof replayStoreQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.replayStore = replayStoreQueries(db);
  }

  // ------------------------------------------------------------------
  // Challenge / Verify (login flow)
  // ------------------------------------------------------------------

  async createChallenge(_params: { userId?: string; pubkey?: string }): Promise<ChallengeData> {
    const nonce = randomBytes(32).toString('hex');
    return {
      nonce,
      instructions: 'Sign a kind-22242 Nostr event with tag ["challenge", "<nonce>"]',
    };
  }

  async verifyChallenge(
    challenge: string,
    proof: ChallengeProof,
    identities: Identity[],
  ): Promise<VerifiedIdentity | null> {
    // Parse the signed Nostr event from proof.signature
    let event: NostrEvent;
    try {
      event = JSON.parse(proof.signature);
    } catch {
      return null;
    }

    // Verify event ID + Schnorr signature
    if (!verifyNostrEvent(event)) return null;

    // Challenge nonce must appear in event tags
    const hasChallenge = event.tags.some(
      (t: string[]) => t[0] === 'challenge' && t[1] === challenge,
    );
    if (!hasChallenge) return null;

    // Match pubkey to a registered identity
    const pubkeyHex = event.pubkey;
    const match = identities.find(
      (id) => id.provider === 'nostr' && id.fingerprint === pubkeyHex,
    );

    if (match) {
      return {
        provider: this.name,
        externalId: pubkeyHex,
        identity: match,
        userId: match.user_id,
      };
    }

    // No registered identity — return without userId for invite provisioning
    return {
      provider: this.name,
      externalId: pubkeyHex,
      identity: null,
    };
  }

  async fingerprint(publicKey: string): Promise<string> {
    // Nostr pubkeys are already hex — normalize to lowercase
    return publicKey.toLowerCase();
  }

  // ------------------------------------------------------------------
  // NIP-98 Request Auth
  // ------------------------------------------------------------------

  extractFromRequest(
    req: { headers: Record<string, string | string[] | undefined> },
  ): ExtractedCredential | null {
    const raw = req.headers.authorization;
    const header = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
    if (!header?.startsWith('Nostr ')) return null;

    const base64Event = header.slice(6);
    try {
      const event: NostrEvent = JSON.parse(
        Buffer.from(base64Event, 'base64').toString(),
      );

      // Build canonical URL from request properties
      const reqAny = req as Record<string, unknown> & {
        headers: Record<string, string | string[] | undefined>;
      };
      const url = canonicalRequestUrl({
        headers: req.headers,
        protocol: reqAny.protocol as string | undefined,
        hostname: reqAny.hostname as string | undefined,
        url: (reqAny.url as string) ?? '/',
      });

      return {
        providerName: this.name,
        value: base64Event,
        event,
        url,
        method: ((reqAny.method as string) ?? 'GET').toUpperCase(),
        rawBody: reqAny.rawBody as string | undefined,
      };
    } catch {
      return null;
    }
  }

  async verifyRequestCredential(
    credential: ExtractedCredential,
  ): Promise<VerifiedIdentity | null> {
    const { event, url, method, rawBody } = credential as ExtractedCredential & {
      event: NostrEvent;
      url: string;
      method: string;
      rawBody?: string;
    };

    // 1. Verify event ID + Schnorr signature
    if (!verifyNostrEvent(event)) return null;

    // 2. Must be kind 27235 (NIP-98)
    if (event.kind !== 27235) return null;

    // 3. URL tag must match canonical request URL
    const urlTag = event.tags.find((t: string[]) => t[0] === 'u');
    if (!urlTag || !urlMatches(urlTag[1], url)) return null;

    // 4. Method tag must match request method
    const methodTag = event.tags.find((t: string[]) => t[0] === 'method');
    if (!methodTag || methodTag[1].toUpperCase() !== method) return null;

    // 5. Body hash for non-GET requests
    if (method !== 'GET') {
      const payloadTag = event.tags.find((t: string[]) => t[0] === 'payload');
      if (!payloadTag || !rawBody) return null;
      if (payloadTag[1] !== sha256Hex(rawBody)) return null;
    }

    // 6. Timestamp within +-60 seconds
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(event.created_at - now) > 60) return null;

    // 7. Replay protection (TTL = 120s, double the +-60s window)
    try {
      await this.replayStore.assertNotReplayed('nostr', event.id, 120);
    } catch {
      // assertNotReplayed throws a plain Error on replay — convert to auth failure
      this.logger.warn(`NIP-98 replay detected for event ${event.id}`);
      return null;
    }

    return {
      provider: this.name,
      externalId: event.pubkey,
      identity: null, // Resolved by auth guard → resolveVerifiedIdentity
    };
  }
}
