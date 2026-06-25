import { domainToASCII } from 'node:url';

/**
 * Lowercase + IDN-normalize a domain string. Returns null when the input
 * is not a parseable ASCII host (Node's `domainToASCII` returns `''`).
 */
export function normalizeEmailDomain(value: string): string | null {
  const normalized = domainToASCII(value.trim().toLowerCase());
  return normalized || null;
}

/**
 * Extract the (normalized) domain portion of an email address. Returns null
 * for malformed inputs — empty local part, missing `@`, or empty domain part.
 */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeEmailDomain(email.slice(at + 1));
}

/**
 * True when `email`'s domain matches one of `allowlist`. Supports exact
 * domain entries (`acme.com`) and wildcard subdomain entries (`*.acme.com`).
 *
 * Wildcard semantics: `*.acme.com` matches any host that has `acme.com` as
 * a strict suffix — so `eu.acme.com` and `sub.eu.acme.com` match, but bare
 * `acme.com` does NOT. To cover both, declare both entries.
 *
 * The allowlist entries are assumed already normalized (lowercased + ASCII),
 * which is what the manifest schema produces. We re-normalize the incoming
 * email to be safe.
 */
export function matchesDomainAllowlist(email: string, allowlist: string[]): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  for (const entry of allowlist) {
    if (entry === domain) return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".acme.com"
      if (domain.endsWith(suffix) && domain.length > suffix.length) return true;
    }
  }
  return false;
}
