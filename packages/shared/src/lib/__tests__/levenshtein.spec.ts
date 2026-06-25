import { describe, it, expect } from 'vitest';
import { levenshteinDistance, findClosestMatches } from '../levenshtein.js';

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('returns length for empty string comparison', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshteinDistance('', '')).toBe(0);
  });

  it('computes single insertion', () => {
    expect(levenshteinDistance('abc', 'abcd')).toBe(1);
  });

  it('computes single deletion', () => {
    expect(levenshteinDistance('abcd', 'abc')).toBe(1);
  });

  it('computes single substitution', () => {
    expect(levenshteinDistance('abc', 'axc')).toBe(1);
  });

  it('computes single insertion for missing character', () => {
    // GIHUB_TOKEN vs GITHUB_TOKEN: one insertion (T) aligns the rest
    expect(levenshteinDistance('GIHUB_TOKEN', 'GITHUB_TOKEN')).toBe(1);
  });

  it('computes distance for transposition', () => {
    // AB vs BA requires 2 edits in Levenshtein (not Damerau-Levenshtein)
    expect(levenshteinDistance('AB', 'BA')).toBe(2);
  });

  it('handles completely different strings', () => {
    expect(levenshteinDistance('abc', 'xyz')).toBe(3);
  });
});

describe('findClosestMatches', () => {
  const candidates = ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'GHCR_TOKEN'];

  it('finds GITHUB_TOKEN for GIHUB_TOKEN typo', () => {
    const matches = findClosestMatches('GIHUB_TOKEN', candidates);
    expect(matches).toContain('GITHUB_TOKEN');
  });

  it('finds ANTHROPIC_API_KEY for ANTHROPIC_AP_KEY typo', () => {
    const matches = findClosestMatches('ANTHROPIC_AP_KEY', candidates);
    expect(matches).toContain('ANTHROPIC_API_KEY');
  });

  it('returns empty for completely different string', () => {
    const matches = findClosestMatches('TOTALLY_DIFFERENT', candidates);
    expect(matches).toEqual([]);
  });

  it('is case-insensitive', () => {
    const matches = findClosestMatches('github_token', ['GITHUB_TOKN']);
    expect(matches).toContain('GITHUB_TOKN');
  });

  it('excludes exact matches (distance 0)', () => {
    const matches = findClosestMatches('GITHUB_TOKEN', candidates);
    expect(matches).not.toContain('GITHUB_TOKEN');
  });

  it('respects maxDistance parameter', () => {
    // DATABASE_XRL vs DATABASE_URL: distance is 2 (X->U substitution + transposition-like)
    // Use a string with distance 2 from DATABASE_URL
    const matches = findClosestMatches('DATABSE_UL', candidates, 1);
    // distance is 2, so should not match with maxDistance=1
    expect(matches).not.toContain('DATABASE_URL');
  });

  it('sorts by distance (closest first)', () => {
    const matches = findClosestMatches('GHCR_TOKN', ['GHCR_TOKEN', 'GHCR_TOKE', 'OTHER']);
    expect(matches[0]).toBe('GHCR_TOKEN');
  });

  it('handles empty candidates', () => {
    const matches = findClosestMatches('GITHUB_TOKEN', []);
    expect(matches).toEqual([]);
  });
});
