import { describe, test, expect } from 'vitest';
import {
  deepMerge,
  mergeMapConfig,
  mergeRoutes,
  mergeChatConfig,
  mergeXEve,
} from '../../src/lib/overlay-merge.js';

// --- deepMerge ---

describe('deepMerge', () => {
  test('null in overlay removes the key (returns undefined)', () => {
    expect(deepMerge({ a: 1 }, null)).toBeUndefined();
  });

  test('null value in overlay object removes that key from base', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: null });
    expect(result).toEqual({ a: 1 });
  });

  test('objects recurse -- nested keys are merged', () => {
    const base = { outer: { a: 1, b: 2 } };
    const overlay = { outer: { b: 3, c: 4 } };
    expect(deepMerge(base, overlay)).toEqual({ outer: { a: 1, b: 3, c: 4 } });
  });

  test('primitives replace -- overlay wins', () => {
    expect(deepMerge(42, 99)).toBe(99);
    expect(deepMerge('hello', 'world')).toBe('world');
    expect(deepMerge(true, false)).toBe(false);
  });

  test('nested null removes a nested key', () => {
    const base = { top: { keep: 1, remove: 2 }, stay: true };
    const overlay = { top: { remove: null } };
    expect(deepMerge(base, overlay)).toEqual({ top: { keep: 1 }, stay: true });
  });

  test('arrays in overlay replace base arrays (no merge)', () => {
    const result = deepMerge({ tags: [1, 2] }, { tags: [3] });
    expect(result).toEqual({ tags: [3] });
  });

  test('new keys in overlay are added to base', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });
});

// --- mergeMapConfig ---

describe('mergeMapConfig', () => {
  test('preserves version from overlay when present', () => {
    const base = { version: 1, agent_a: { name: 'Alice' } };
    const overlay = { version: 2 };
    const result = mergeMapConfig(base, overlay);
    expect(result.version).toBe(2);
  });

  test('falls back to base version when overlay omits it', () => {
    const base = { version: 1, agent_a: { name: 'Alice' } };
    const overlay = { agent_b: { name: 'Bob' } };
    const result = mergeMapConfig(base, overlay);
    expect(result.version).toBe(1);
    expect(result).toHaveProperty('agent_a');
    expect(result).toHaveProperty('agent_b');
  });

  test('merging two empty agents with version produces valid output', () => {
    const base = { version: 1, agents: {} };
    const overlay = { version: 1, agents: {} };
    const result = mergeMapConfig(base, overlay);
    expect(result.version).toBe(1);
    expect(result).toHaveProperty('agents');
    expect(result.agents).toEqual({});
  });

  test('merging empty base with agents overlay preserves agents', () => {
    const base = { version: 1, agents: {} };
    const overlay = { version: 1, agents: { my_agent: { slug: 'my-agent' } } };
    const result = mergeMapConfig(base, overlay);
    expect(result.version).toBe(1);
    expect(result.agents).toEqual({ my_agent: { slug: 'my-agent' } });
  });

  test('merging agents base with empty overlay preserves agents', () => {
    const base = { version: 1, agents: { my_agent: { slug: 'my-agent' } } };
    const overlay = { version: 1, agents: {} };
    const result = mergeMapConfig(base, overlay);
    expect(result.version).toBe(1);
    expect(result.agents).toEqual({ my_agent: { slug: 'my-agent' } });
  });

  test('merges entries and null removes an entry', () => {
    const base = { version: 1, agent_a: { name: 'Alice' }, agent_b: { name: 'Bob' } };
    const overlay = { version: 1, agent_b: null, agent_c: { name: 'Carol' } };
    const result = mergeMapConfig(base, overlay);
    expect(result).toEqual({
      version: 1,
      agent_a: { name: 'Alice' },
      agent_c: { name: 'Carol' },
    });
  });
});

// --- mergeRoutes ---

describe('mergeRoutes', () => {
  test('upserts by id -- existing route is deep-merged', () => {
    const base = [{ id: 'r1', match: '/foo', target: 'agent_a' }];
    const overlay = [{ id: 'r1', target: 'agent_b' }];
    const result = mergeRoutes(base, overlay);
    expect(result).toEqual([{ id: 'r1', match: '/foo', target: 'agent_b' }]);
  });

  test('new id appends to the list', () => {
    const base = [{ id: 'r1', match: '/foo', target: 'a' }];
    const overlay = [{ id: 'r2', match: '/bar', target: 'b' }];
    const result = mergeRoutes(base, overlay);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ id: 'r2', match: '/bar', target: 'b' });
  });

  test('_remove: true deletes the route', () => {
    const base = [
      { id: 'r1', match: '/foo', target: 'a' },
      { id: 'r2', match: '/bar', target: 'b' },
    ];
    const overlay = [{ id: 'r1', _remove: true }];
    const result = mergeRoutes(base, overlay);
    expect(result).toEqual([{ id: 'r2', match: '/bar', target: 'b' }]);
  });
});

// --- mergeChatConfig ---

describe('mergeChatConfig', () => {
  test('routes use id-based upsert while other fields deep-merge', () => {
    const base = {
      default_route: 'r1',
      greeting: 'hello',
      routes: [{ id: 'r1', match: '/ask', target: 'a' }],
    };
    const overlay = {
      greeting: 'hi',
      routes: [
        { id: 'r1', target: 'b' },
        { id: 'r2', match: '/new', target: 'c' },
      ],
    };
    const result = mergeChatConfig(base, overlay);
    expect(result.default_route).toBe('r1');
    expect(result.greeting).toBe('hi');
    expect(result.routes).toEqual([
      { id: 'r1', match: '/ask', target: 'b' },
      { id: 'r2', match: '/new', target: 'c' },
    ]);
  });

  test('empty overlay routes preserves base routes', () => {
    const base = { routes: [{ id: 'r1', match: '/x', target: 'a' }] };
    const overlay = {};
    const result = mergeChatConfig(base, overlay);
    expect(result.routes).toEqual([{ id: 'r1', match: '/x', target: 'a' }]);
  });
});

// --- mergeXEve ---

describe('mergeXEve', () => {
  test('folds pack fragments in order then applies project overlay', () => {
    const fragment1 = { feature_a: true, shared: { x: 1 } };
    const fragment2 = { feature_b: true, shared: { y: 2 } };
    const project = { shared: { z: 3 } };

    const result = mergeXEve([fragment1, fragment2], project);
    expect(result).toEqual({
      feature_a: true,
      feature_b: true,
      shared: { x: 1, y: 2, z: 3 },
    });
  });

  test('project overlay wins over pack fragments', () => {
    const fragment = { mode: 'pack', debug: true };
    const project = { mode: 'project' };
    const result = mergeXEve([fragment], project);
    expect(result).toEqual({ mode: 'project', debug: true });
  });

  test('empty fragments list returns project overlay', () => {
    const project = { key: 'value' };
    expect(mergeXEve([], project)).toEqual({ key: 'value' });
  });

  test('null in later fragment removes key from earlier fragment', () => {
    const f1 = { keep: 1, remove: 2 };
    const f2 = { remove: null };
    const project = {};
    const result = mergeXEve([f1, f2], project);
    expect(result).toEqual({ keep: 1 });
  });
});
