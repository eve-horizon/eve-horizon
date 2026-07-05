import { describe, expect, it } from 'vitest';
import { buildQuery, capitalize, formatDate, parseSinceValue, renderTable } from '../src/lib/format';

describe('buildQuery', () => {
  it('skips undefined and empty values and prefixes ?', () => {
    expect(buildQuery({ a: 'x', b: undefined, c: '', d: 5, e: false })).toBe('?a=x&d=5&e=false');
  });

  it('returns empty string when nothing set', () => {
    expect(buildQuery({ a: undefined, b: '' })).toBe('');
  });

  it('encodes like URLSearchParams (spaces as +)', () => {
    expect(buildQuery({ q: 'a b' })).toBe('?q=a+b');
  });
});

describe('parseSinceValue', () => {
  it('passes ISO-ish values through', () => {
    expect(parseSinceValue('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z');
  });

  it('rejects invalid formats with legacy message', () => {
    expect(() => parseSinceValue('10x')).toThrow('Invalid time format: "10x". Use formats like "10m", "2h", "7d", or ISO timestamp.');
  });

  it('converts relative durations to ISO', () => {
    const before = Date.now();
    const parsed = new Date(parseSinceValue('10m')).getTime();
    expect(before - parsed).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
    expect(before - parsed).toBeLessThanOrEqual(10 * 60_000 + 1000);
  });
});

describe('capitalize / formatDate', () => {
  it('capitalizes first letter only', () => {
    expect(capitalize('ready')).toBe('Ready');
  });

  it('formatDate matches legacy toLocaleString rendering', () => {
    const iso = '2026-01-02T03:04:05Z';
    expect(formatDate(iso)).toBe(new Date(iso).toLocaleString());
  });
});

describe('renderTable', () => {
  it('matches legacy build-list rendering (padEnd concat, last column raw)', () => {
    const builds = [
      { id: 'build_abc', git_sha: '0123456789abcdef', created_by: null, created_at: '2026-01-01T00:00:00Z' },
      { id: 'build_with_a_much_longer_identifier_x', git_sha: 'deadbeefcafe', created_by: 'user@example.com', created_at: '2026-02-02T12:30:00Z' },
    ];
    const legacy = [
      'Build ID'.padEnd(30) + 'SHA'.padEnd(12) + 'Created By'.padEnd(20) + 'Created',
      ...builds.map((build) => {
        const id = build.id.padEnd(30);
        const sha = build.git_sha.substring(0, 8).padEnd(12);
        const creator = (build.created_by ?? '-').padEnd(20);
        const created = new Date(build.created_at).toLocaleString();
        return `${id}${sha}${creator}${created}`;
      }),
    ];
    const rendered = renderTable(
      [
        { header: 'Build ID', width: 30 },
        { header: 'SHA', width: 12 },
        { header: 'Created By', width: 20 },
        { header: 'Created' },
      ],
      builds.map((build) => [
        build.id,
        build.git_sha.substring(0, 8),
        build.created_by ?? '-',
        new Date(build.created_at).toLocaleString(),
      ]),
    );
    expect(rendered).toEqual(legacy);
  });

  it('matches legacy hard-coded header strings', () => {
    const domainHeader = renderTable(
      [
        { header: 'HOSTNAME', width: 33 },
        { header: 'SERVICE', width: 11 },
        { header: 'ENV', width: 12 },
        { header: 'STATUS', width: 19 },
        { header: 'VERIFIED' },
      ],
      [],
    )[0];
    expect(domainHeader).toBe('HOSTNAME                         SERVICE    ENV         STATUS             VERIFIED');

    const dbHeader = renderTable(
      [
        { header: 'ID', width: 20 },
        { header: 'Trigger', width: 12 },
        { header: 'Status', width: 12 },
        { header: 'Size', width: 11 },
        { header: 'DB Size', width: 11 },
        { header: 'Created' },
      ],
      [],
    )[0];
    expect(dbHeader).toBe('ID                  Trigger     Status      Size       DB Size    Created');
  });

  it('matches legacy two-space separated dynamic-width tables (api sources)', () => {
    const apis = [
      { name: 'internal', type: 'rest', base_url: 'http://api.internal' },
      { name: 'gh', type: 'graphql', base_url: 'https://api.github.com/graphql' },
    ];
    const nameWidth = Math.max(4, ...apis.map((api) => api.name.length));
    const typeWidth = Math.max(4, ...apis.map((api) => api.type.length));
    const legacy = [
      `${'NAME'.padEnd(nameWidth)}  ${'TYPE'.padEnd(typeWidth)}  BASE URL`,
      `${'-'.repeat(nameWidth)}  ${'-'.repeat(typeWidth)}  --------`,
      ...apis.map((api) => `${api.name.padEnd(nameWidth)}  ${api.type.padEnd(typeWidth)}  ${api.base_url}`),
    ];
    const rendered = renderTable(
      [
        { header: 'NAME', width: nameWidth + 2 },
        { header: 'TYPE', width: typeWidth + 2 },
        { header: 'BASE URL' },
      ],
      [
        ['-'.repeat(nameWidth), '-'.repeat(typeWidth), '--------'],
        ...apis.map((api) => [api.name, api.type, api.base_url]),
      ],
    );
    expect(rendered).toEqual(legacy);
  });

  it('does not truncate cells wider than their column', () => {
    const lines = renderTable([{ header: 'A', width: 4 }, { header: 'B' }], [['longer-than-four', 'x']]);
    expect(lines[1]).toBe('longer-than-fourx');
  });
});
