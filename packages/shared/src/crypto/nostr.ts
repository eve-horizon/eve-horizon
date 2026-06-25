/**
 * Nostr cryptographic utilities for NIP-98 request auth and event verification.
 *
 * Uses @noble/secp256k1 (pure JS, no native deps) for Schnorr signature verification
 * and @noble/hashes for SHA-256 computation.
 */
import { schnorr } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Nostr Event Types
// ---------------------------------------------------------------------------

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// ---------------------------------------------------------------------------
// Event ID + Signature Verification
// ---------------------------------------------------------------------------

/** Compute the canonical event ID (SHA-256 of serialized event). */
export function computeEventId(event: Omit<NostrEvent, 'id' | 'sig'>): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

/** Verify a Nostr event: check ID computation + Schnorr signature (BIP-340). */
export function verifyNostrEvent(event: NostrEvent): boolean {
  // 1. Recompute and verify event ID
  const expectedId = computeEventId({
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
  });
  if (event.id !== expectedId) return false;

  // 2. Verify Schnorr signature — noble v3 expects Uint8Array, not hex strings
  try {
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// URL Canonicalization (NIP-98)
// ---------------------------------------------------------------------------

/**
 * Build canonical URL from request properties.
 * Scheme from x-forwarded-proto or protocol, host from x-forwarded-host or hostname.
 * Query params sorted alphabetically for deterministic comparison.
 */
export function canonicalRequestUrl(req: {
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
  hostname?: string;
  url: string;
}): string {
  const proto = req.headers['x-forwarded-proto'];
  const scheme = (typeof proto === 'string' ? proto : undefined) || req.protocol || 'https';
  const fwdHost = req.headers['x-forwarded-host'];
  const host = (typeof fwdHost === 'string' ? fwdHost : undefined) || req.hostname || 'localhost';
  const url = new URL(req.url, `${scheme}://${host}`);
  url.searchParams.sort();
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const query = url.search;
  return `${url.protocol}//${url.host}${path}${query}`;
}

/**
 * Compare two URLs for NIP-98 matching.
 * Both are parsed and canonicalized before comparison.
 */
export function urlMatches(tagUrl: string, canonicalUrl: string): boolean {
  try {
    const a = new URL(tagUrl);
    const b = new URL(canonicalUrl);
    a.searchParams.sort();
    b.searchParams.sort();
    return (
      a.protocol === b.protocol &&
      a.host === b.host &&
      a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex of a string (for NIP-98 body hash). */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}
