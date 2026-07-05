import { describe, expect, it } from 'vitest';
import {
  intersectScopes,
  intersectPrefixScope,
  intersectStringSets,
  intersectPathPatterns,
  intersectPathPattern,
  pathPatternBase,
} from './scope-algebra.js';

describe('pathPatternBase', () => {
  it('maps wildcard and empty patterns to root', () => {
    expect(pathPatternBase('*')).toBe('/');
    expect(pathPatternBase('')).toBe('/');
    expect(pathPatternBase('  ')).toBe('/');
    expect(pathPatternBase('/')).toBe('/');
  });

  it('strips glob suffixes and trailing slashes', () => {
    expect(pathPatternBase('/data/**')).toBe('/data');
    expect(pathPatternBase('/data/*')).toBe('/data');
    expect(pathPatternBase('/data/')).toBe('/data');
    expect(pathPatternBase('/data///')).toBe('/data');
    expect(pathPatternBase(' /docs/reports/** ')).toBe('/docs/reports');
  });
});

describe('intersectPathPattern', () => {
  it('treats "*" as identity', () => {
    expect(intersectPathPattern('*', '/data/**')).toBe('/data/**');
    expect(intersectPathPattern('/data/**', '*')).toBe('/data/**');
    expect(intersectPathPattern('*', '*')).toBe('*');
  });

  it('picks the longer pattern when bases are equal', () => {
    expect(intersectPathPattern('/data/**', '/data/*')).toBe('/data/**');
    expect(intersectPathPattern('/data/*', '/data/**')).toBe('/data/**');
    expect(intersectPathPattern('/data/**', '/data/**')).toBe('/data/**');
  });

  it('picks the deeper pattern when one base nests inside the other', () => {
    expect(intersectPathPattern('/data/sub/**', '/data/**')).toBe('/data/sub/**');
    expect(intersectPathPattern('/data/**', '/data/sub/**')).toBe('/data/sub/**');
  });

  it('returns null for disjoint bases', () => {
    expect(intersectPathPattern('/alpha/**', '/beta/**')).toBeNull();
    // Prefix without a path separator boundary is NOT a nesting relationship
    expect(intersectPathPattern('/data', '/database/**')).toBeNull();
  });
});

describe('intersectPathPatterns', () => {
  it('treats undefined as unrestricted, returning the other side sorted and deduped', () => {
    expect(intersectPathPatterns(undefined, ['/b/**', '/a/**', '/a/**'])).toEqual(['/a/**', '/b/**']);
    expect(intersectPathPatterns(['/b/**', '/a/**'], undefined)).toEqual(['/a/**', '/b/**']);
    expect(intersectPathPatterns(undefined, undefined)).toEqual([]);
  });

  it('returns the sorted cartesian intersection of both sides', () => {
    expect(intersectPathPatterns(['/data/**', '/docs/**'], ['/data/sub/**', '/docs/**'])).toEqual([
      '/data/sub/**',
      '/docs/**',
    ]);
  });

  it('returns empty for fully disjoint pattern sets', () => {
    expect(intersectPathPatterns(['/a/**'], ['/b/**'])).toEqual([]);
    expect(intersectPathPatterns([], ['/b/**'])).toEqual([]);
  });
});

describe('intersectStringSets', () => {
  it('treats undefined as unrestricted, returning the other side sorted and deduped', () => {
    expect(intersectStringSets(undefined, ['b', 'a', 'a'])).toEqual(['a', 'b']);
    expect(intersectStringSets(['b', 'a'], undefined)).toEqual(['a', 'b']);
    expect(intersectStringSets(undefined, undefined)).toEqual([]);
  });

  it('treats "*" membership as unrestricted on that side', () => {
    expect(intersectStringSets(['*'], ['public', 'audit'])).toEqual(['audit', 'public']);
    expect(intersectStringSets(['public', 'audit'], ['*'])).toEqual(['audit', 'public']);
  });

  it('intersects plain sets, sorted and deduped, and empties on disjoint', () => {
    expect(intersectStringSets(['a', 'b', 'c'], ['c', 'b', 'z'])).toEqual(['b', 'c']);
    expect(intersectStringSets(['a'], ['z'])).toEqual([]);
  });
});

describe('intersectPrefixScope', () => {
  it('intersects allow and read-only prefixes independently', () => {
    expect(
      intersectPrefixScope(
        { allow_prefixes: ['/data/**'], read_only_prefixes: ['/docs/**'] },
        { allow_prefixes: ['/data/sub/**'], read_only_prefixes: undefined },
      ),
    ).toEqual({
      allow_prefixes: ['/data/sub/**'],
      read_only_prefixes: ['/docs/**'],
    });
  });
});

describe('intersectScopes', () => {
  it('returns an empty scope when neither side declares anything', () => {
    expect(intersectScopes({}, {})).toEqual({});
  });

  it('keeps a facet when only one side declares it (other side unrestricted)', () => {
    expect(
      intersectScopes({ orgfs: { allow_prefixes: ['/data/**'] } }, {}),
    ).toEqual({
      orgfs: { allow_prefixes: ['/data/**'], read_only_prefixes: [] },
    });
  });

  it('intersects envdb schemas/tables with wildcard support', () => {
    expect(
      intersectScopes(
        { envdb: { schemas: ['*'], tables: ['orders', 'users'] } },
        { envdb: { schemas: ['public'], tables: ['users', 'events'] } },
      ),
    ).toEqual({
      envdb: { schemas: ['public'], tables: ['users'] },
    });
  });

  it('intersects cloud_fs mount ids and narrows orgfs/orgdocs prefixes', () => {
    expect(
      intersectScopes(
        {
          orgfs: { allow_prefixes: ['/data/**'] },
          orgdocs: { read_only_prefixes: ['/docs/**'] },
          cloud_fs: { allow_mount_ids: ['m1', 'm2'] },
        },
        {
          orgfs: { allow_prefixes: ['/data/sub/**'] },
          orgdocs: { read_only_prefixes: ['/other/**'] },
          cloud_fs: { allow_mount_ids: ['m2', 'm3'] },
        },
      ),
    ).toEqual({
      orgfs: { allow_prefixes: ['/data/sub/**'], read_only_prefixes: [] },
      orgdocs: { allow_prefixes: [], read_only_prefixes: [] },
      cloud_fs: { allow_mount_ids: ['m2'] },
    });
  });
});
