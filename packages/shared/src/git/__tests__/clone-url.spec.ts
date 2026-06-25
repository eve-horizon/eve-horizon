import { describe, expect, it } from 'vitest';
import { buildAuthenticatedHttpsUrl } from '../clone-url.js';

describe('buildAuthenticatedHttpsUrl', () => {
  const REPO = 'https://github.com/org/repo.git';

  it('uses the x-access-token:<token> form so every token kind authenticates', () => {
    // Classic PAT, fine-grained PAT, GitHub App install token, OAuth token —
    // all must land as the PASSWORD with username x-access-token. The historical
    // username-only form only worked for classic PATs.
    for (const token of ['ghp_classic', 'github_pat_finegrained', 'ghs_appinstall', 'gho_oauth']) {
      expect(buildAuthenticatedHttpsUrl(REPO, token)).toBe(
        `https://x-access-token:${token}@github.com/org/repo.git`,
      );
    }
  });

  it('never emits the broken username-only shape', () => {
    const url = buildAuthenticatedHttpsUrl(REPO, 'ghp_token');
    expect(url).not.toBe('https://ghp_token@github.com/org/repo.git');
    expect(url.startsWith('https://x-access-token:')).toBe(true);
  });

  it('trims surrounding whitespace so a secret with a trailing newline still works', () => {
    expect(buildAuthenticatedHttpsUrl(REPO, '  ghp_token\n')).toBe(
      'https://x-access-token:ghp_token@github.com/org/repo.git',
    );
  });

  it('preserves a non-default path and host casing', () => {
    expect(buildAuthenticatedHttpsUrl('https://github.com/My-Org/My-Repo', 'tok')).toBe(
      'https://x-access-token:tok@github.com/My-Org/My-Repo',
    );
  });

  it('returns the URL unchanged for non-github hosts', () => {
    const url = 'https://gitlab.com/org/repo.git';
    expect(buildAuthenticatedHttpsUrl(url, 'tok')).toBe(url);
  });

  it('returns the URL unchanged for non-http(s) URLs (ssh)', () => {
    const url = 'git@github.com:org/repo.git';
    expect(buildAuthenticatedHttpsUrl(url, 'tok')).toBe(url);
  });

  it('returns the URL unchanged when the token is empty after trimming', () => {
    expect(buildAuthenticatedHttpsUrl(REPO, '   ')).toBe(REPO);
  });

  it('returns the URL unchanged when it cannot be parsed', () => {
    const url = 'https://';
    expect(buildAuthenticatedHttpsUrl(url, 'tok')).toBe(url);
  });

  it('produces a URL whose redaction regex masks the credentials in logs', () => {
    const url = buildAuthenticatedHttpsUrl(REPO, 'ghp_secret');
    expect(url.replace(/\/\/[^@]+@/, '//***@')).toBe('https://***@github.com/org/repo.git');
  });
});
