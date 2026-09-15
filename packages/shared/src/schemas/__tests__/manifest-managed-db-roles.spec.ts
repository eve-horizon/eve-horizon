import { describe, expect, it } from 'vitest';
import { ManifestSchema } from '../manifest.js';

function parseManifest(roles?: unknown) {
  return ManifestSchema.safeParse({
    schema: 'eve/compose/v2',
    services: {
      db: {
        'x-eve': {
          role: 'managed_db',
          managed: {
            class: 'db.p1',
            engine: 'postgres',
            ...(roles === undefined ? {} : { roles }),
          },
        },
      },
    },
  });
}

describe('managed DB roles manifest schema', () => {
  it('defaults to no roles when the block is absent', () => {
    const parsed = parseManifest();

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.services?.db?.['x-eve']?.managed?.roles).toEqual([]);
  });

  it('accepts readwrite and readonly roles', () => {
    const parsed = parseManifest([
      { name: 'app', grants: 'readwrite' },
      { name: 'reporting_ro', grants: 'readonly' },
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.services?.db?.['x-eve']?.managed?.roles).toEqual([
      { name: 'app', grants: 'readwrite' },
      { name: 'reporting_ro', grants: 'readonly' },
    ]);
  });

  it.each([
    ['uppercase', 'App'],
    ['leading digit', '1app'],
    ['hyphen', 'app-ro'],
    ['too long', 'a'.repeat(17)],
    ['empty', ''],
  ])('rejects role names with %s', (_label, name) => {
    const parsed = parseManifest([{ name, grants: 'readonly' }]);

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.includes('roles'))).toBe(true);
  });

  it('accepts a 16-character role name', () => {
    const parsed = parseManifest([{ name: 'a'.repeat(16), grants: 'readonly' }]);

    expect(parsed.success).toBe(true);
  });

  it('rejects unknown grants', () => {
    const parsed = parseManifest([{ name: 'app', grants: 'admin' }]);

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.includes('grants'))).toBe(true);
  });

  it('rejects duplicate role names', () => {
    const parsed = parseManifest([
      { name: 'app', grants: 'readwrite' },
      { name: 'app', grants: 'readonly' },
    ]);

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes('Duplicate managed DB role'))).toBe(true);
  });
});
