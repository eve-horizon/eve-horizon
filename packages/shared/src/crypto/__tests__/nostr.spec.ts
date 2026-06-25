import { describe, it, expect } from 'vitest';
import { computeEventId, verifyNostrEvent, canonicalRequestUrl, urlMatches, sha256Hex } from '../nostr.ts';

describe('nostr crypto utilities', () => {
  describe('computeEventId', () => {
    it('computes deterministic event IDs', () => {
      const event = {
        pubkey: 'a'.repeat(64),
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'hello world',
      };
      const id = computeEventId(event);
      expect(id).toHaveLength(64);
      // Same input should produce same output
      expect(computeEventId(event)).toBe(id);
    });

    it('produces different IDs for different content', () => {
      const base = {
        pubkey: 'a'.repeat(64),
        created_at: 1700000000,
        kind: 1,
        tags: [],
      };
      const id1 = computeEventId({ ...base, content: 'hello' });
      const id2 = computeEventId({ ...base, content: 'world' });
      expect(id1).not.toBe(id2);
    });
  });

  describe('verifyNostrEvent', () => {
    it('rejects event with wrong ID', () => {
      const event = {
        id: 'deadbeef'.repeat(8),
        pubkey: 'a'.repeat(64),
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'hello',
        sig: 'b'.repeat(128),
      };
      expect(verifyNostrEvent(event)).toBe(false);
    });
  });

  describe('canonicalRequestUrl', () => {
    it('builds canonical URL from request properties', () => {
      const url = canonicalRequestUrl({
        headers: {},
        protocol: 'https',
        hostname: 'api.example.com',
        url: '/v1/test?b=2&a=1',
      });
      expect(url).toBe('https://api.example.com/v1/test?a=1&b=2');
    });

    it('uses x-forwarded-proto and x-forwarded-host when present', () => {
      const url = canonicalRequestUrl({
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'external.example.com',
        },
        protocol: 'http',
        hostname: 'internal.svc',
        url: '/api/v1/resource',
      });
      expect(url).toBe('https://external.example.com/api/v1/resource');
    });

    it('strips trailing slash except for root', () => {
      const url = canonicalRequestUrl({
        headers: {},
        protocol: 'https',
        hostname: 'api.example.com',
        url: '/v1/test/',
      });
      expect(url).toBe('https://api.example.com/v1/test');
    });

    it('preserves root path', () => {
      const url = canonicalRequestUrl({
        headers: {},
        protocol: 'https',
        hostname: 'api.example.com',
        url: '/',
      });
      expect(url).toBe('https://api.example.com/');
    });

    it('sorts query parameters', () => {
      const url = canonicalRequestUrl({
        headers: {},
        protocol: 'https',
        hostname: 'api.example.com',
        url: '/test?z=1&a=2&m=3',
      });
      expect(url).toBe('https://api.example.com/test?a=2&m=3&z=1');
    });
  });

  describe('urlMatches', () => {
    it('matches identical URLs', () => {
      expect(urlMatches(
        'https://api.example.com/v1/test',
        'https://api.example.com/v1/test',
      )).toBe(true);
    });

    it('matches URLs with different query param order', () => {
      expect(urlMatches(
        'https://api.example.com/v1/test?b=2&a=1',
        'https://api.example.com/v1/test?a=1&b=2',
      )).toBe(true);
    });

    it('rejects different hosts', () => {
      expect(urlMatches(
        'https://api.example.com/v1/test',
        'https://other.example.com/v1/test',
      )).toBe(false);
    });

    it('rejects different paths', () => {
      expect(urlMatches(
        'https://api.example.com/v1/test',
        'https://api.example.com/v2/test',
      )).toBe(false);
    });

    it('rejects different schemes', () => {
      expect(urlMatches(
        'http://api.example.com/v1/test',
        'https://api.example.com/v1/test',
      )).toBe(false);
    });

    it('handles trailing slash differences', () => {
      expect(urlMatches(
        'https://api.example.com/v1/test/',
        'https://api.example.com/v1/test',
      )).toBe(true);
    });

    it('returns false for invalid URLs', () => {
      expect(urlMatches('not-a-url', 'https://api.example.com/v1/test')).toBe(false);
    });
  });

  describe('sha256Hex', () => {
    it('computes SHA-256 of a string', () => {
      const hash = sha256Hex('hello world');
      expect(hash).toHaveLength(64);
      // Known SHA-256 of "hello world"
      expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });

    it('produces different hashes for different inputs', () => {
      expect(sha256Hex('hello')).not.toBe(sha256Hex('world'));
    });
  });
});
