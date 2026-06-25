import { describe, expect, it } from 'vitest';
import {
  getSupportedExtensionDefinition,
  normalizeManagedDbExtensions,
  parseEnabledPreloadExtensions,
  quotePostgresIdentifier,
  sharedPreloadLibrariesContains,
} from '../extensions.js';

describe('managed DB extension registry', () => {
  it('normalizes requested extensions into allowlist order', () => {
    expect(normalizeManagedDbExtensions(['pg_trgm', 'postgis', 'pgvector'])).toEqual([
      'postgis',
      'pgvector',
      'pg_trgm',
    ]);
  });

  it('maps manifest names to canonical Postgres extension names', () => {
    expect(getSupportedExtensionDefinition('pgvector')).toMatchObject({
      extname: 'vector',
    });
    expect(getSupportedExtensionDefinition('pg_cron')).toMatchObject({
      mode: 'preload',
      extname: 'pg_cron',
      preloadName: 'pg_cron',
      installScope: 'instance_admin_db',
    });
    expect(getSupportedExtensionDefinition('postgis')).toMatchObject({
      extname: 'postgis',
    });
  });

  it('requires explicit provider gating for preload extensions', () => {
    expect(() => normalizeManagedDbExtensions(['pg_cron'])).toThrow(/provider preload support/i);
    expect(normalizeManagedDbExtensions(['pg_cron'], {
      enabledPreloadExtensions: ['pg_cron'],
    })).toEqual(['pg_cron']);
  });

  it('parses enabled preload extensions from comma-separated config', () => {
    expect(parseEnabledPreloadExtensions(undefined)).toEqual([]);
    expect(parseEnabledPreloadExtensions('pg_cron,unknown')).toEqual(['pg_cron']);
    expect(parseEnabledPreloadExtensions('*')).toEqual(['pg_cron']);
  });

  it('checks shared_preload_libraries exactly', () => {
    expect(sharedPreloadLibrariesContains('pg_stat_statements, pg_cron', 'pg_cron')).toBe(true);
    expect(sharedPreloadLibrariesContains('pg_cron_extra', 'pg_cron')).toBe(false);
    expect(sharedPreloadLibrariesContains('', 'pg_cron')).toBe(false);
  });

  it('quotes Postgres identifiers safely', () => {
    expect(quotePostgresIdentifier('postgis')).toBe('"postgis"');
    expect(quotePostgresIdentifier('weird"name')).toBe('"weird""name"');
  });
});
