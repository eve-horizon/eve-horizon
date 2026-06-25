import { describe, expect, it } from 'vitest';
import { emailDomain, matchesDomainAllowlist, normalizeEmailDomain } from './email-domain.js';

describe('normalizeEmailDomain', () => {
  it('lowercases and trims input', () => {
    expect(normalizeEmailDomain(' Acme.COM ')).toBe('acme.com');
  });

  it('punycodes IDNs', () => {
    expect(normalizeEmailDomain('bücher.example')).toBe('xn--bcher-kva.example');
  });

  it('returns null for empty strings', () => {
    expect(normalizeEmailDomain('')).toBeNull();
    expect(normalizeEmailDomain('   ')).toBeNull();
  });
});

describe('emailDomain', () => {
  it('extracts and normalizes the domain', () => {
    expect(emailDomain('Foo@Acme.COM')).toBe('acme.com');
  });

  it('respects + aliases (last @ wins)', () => {
    expect(emailDomain('foo+bar@acme.com')).toBe('acme.com');
  });

  it('handles unicode domains', () => {
    expect(emailDomain('user@bücher.example')).toBe('xn--bcher-kva.example');
  });

  it('returns null for missing @ or empty parts', () => {
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('@acme.com')).toBeNull();
    expect(emailDomain('foo@')).toBeNull();
  });
});

describe('matchesDomainAllowlist', () => {
  it('matches exact domains case-insensitively', () => {
    expect(matchesDomainAllowlist('user@acme.com', ['acme.com'])).toBe(true);
    expect(matchesDomainAllowlist('User@Acme.COM', ['acme.com'])).toBe(true);
    expect(matchesDomainAllowlist('user@evil.com', ['acme.com'])).toBe(false);
  });

  it('matches wildcard subdomain entries', () => {
    expect(matchesDomainAllowlist('user@eu.acme.com', ['*.acme.com'])).toBe(true);
    expect(matchesDomainAllowlist('user@sub.eu.acme.com', ['*.acme.com'])).toBe(true);
  });

  it('wildcard does NOT match the bare apex', () => {
    expect(matchesDomainAllowlist('user@acme.com', ['*.acme.com'])).toBe(false);
  });

  it('declaring both apex and wildcard matches both', () => {
    const list = ['acme.com', '*.acme.com'];
    expect(matchesDomainAllowlist('user@acme.com', list)).toBe(true);
    expect(matchesDomainAllowlist('user@eu.acme.com', list)).toBe(true);
  });

  it('matches normalized IDN against ASCII allowlist entries', () => {
    expect(matchesDomainAllowlist('user@bücher.example', ['xn--bcher-kva.example'])).toBe(true);
  });

  it('returns false for malformed emails', () => {
    expect(matchesDomainAllowlist('no-at-sign', ['acme.com'])).toBe(false);
    expect(matchesDomainAllowlist('@acme.com', ['acme.com'])).toBe(false);
  });

  it('returns false when allowlist is empty', () => {
    expect(matchesDomainAllowlist('user@acme.com', [])).toBe(false);
  });
});
