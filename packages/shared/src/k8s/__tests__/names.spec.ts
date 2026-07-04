import { describe, expect, it } from 'vitest';
import {
  appendK8sSuffix,
  combineK8sName,
  deriveNamespace,
  toK8sLabelValue,
  toK8sName,
} from '../names.js';

// Golden tests: these vectors pin the deployer's historical behavior
// (apps/worker deployer.service.ts private helpers, pre-extraction). The
// deployer created every existing cluster object with these exact rules, so
// changing any expectation here means orphaning live resources. See
// docs/plans/codebase-refactor-simplification-plan.md (XSV-1).
describe('toK8sName', () => {
  it('passes through already-valid names', () => {
    expect(toK8sName('test', 'x')).toBe('test');
    expect(toK8sName('eve-mto-dtest-test', 'x')).toBe('eve-mto-dtest-test');
  });

  it('lowercases and collapses invalid runs to single dashes', () => {
    expect(toK8sName('Test_Env', 'x')).toBe('test-env');
    expect(toK8sName('My Org!!Name', 'x')).toBe('my-org-name');
    expect(toK8sName('a__b', 'x')).toBe('a-b');
  });

  it('trims leading/trailing dashes and collapses repeats', () => {
    expect(toK8sName('-lead-trail-', 'x')).toBe('lead-trail');
    expect(toK8sName('my--env', 'x')).toBe('my-env');
  });

  it('truncates to 63 chars and strips trailing dashes after the cut', () => {
    expect(toK8sName('a'.repeat(70), 'x')).toBe('a'.repeat(63));
    // 62 a's + '-b' = 64 chars; slice(0,63) ends on the dash, which is trimmed
    expect(toK8sName(`${'a'.repeat(62)}-b`, 'x')).toBe('a'.repeat(62));
  });

  it('throws when nothing valid remains', () => {
    expect(() => toK8sName('***', 'widget')).toThrow('Invalid widget name');
    expect(() => toK8sName('', 'widget')).toThrow('Invalid widget name');
  });
});

describe('toK8sLabelValue', () => {
  it('keeps dots and underscores, lowercases', () => {
    expect(toK8sLabelValue('My.App_v2', 'x')).toBe('my.app_v2');
  });

  it('strips leading/trailing non-alphanumerics', () => {
    expect(toK8sLabelValue('.foo', 'x')).toBe('foo');
    expect(toK8sLabelValue('foo.', 'x')).toBe('foo');
    expect(toK8sLabelValue('-foo_', 'x')).toBe('foo');
  });

  it('throws when nothing valid remains', () => {
    expect(() => toK8sLabelValue('...', 'widget')).toThrow('Invalid widget label value');
  });
});

describe('combineK8sName', () => {
  it('joins short slugs directly', () => {
    expect(combineK8sName('test', 'api', 'x')).toBe('test-api');
  });

  it('trims both sides to 31 chars when combined exceeds 63', () => {
    const env = 'e'.repeat(40);
    const comp = 'c'.repeat(40);
    expect(combineK8sName(env, comp, 'x')).toBe(`${'e'.repeat(31)}-${'c'.repeat(31)}`);
  });
});

describe('appendK8sSuffix', () => {
  it('appends a normalized suffix', () => {
    expect(appendK8sSuffix('base', 'Sfx', 'x')).toBe('base-sfx');
  });

  it('trims the base to keep the result within 63 chars', () => {
    const base = 'b'.repeat(70);
    expect(appendK8sSuffix(base, 'tls', 'x')).toBe(`${'b'.repeat(59)}-tls`);
  });
});

describe('deriveNamespace', () => {
  it('derives eve-{org}-{project}-{env} for clean slugs', () => {
    expect(deriveNamespace('mto', 'dtest', 'test')).toBe('eve-mto-dtest-test');
  });

  it('sanitizes edge slugs the same way the deployer always has', () => {
    expect(deriveNamespace('My_Org', 'proj', 'test')).toBe('eve-my-org-proj-test');
  });

  it('prefers a stored namespace, sanitized', () => {
    expect(deriveNamespace('x', 'y', 'z', 'Custom-NS')).toBe('custom-ns');
    expect(deriveNamespace('x', 'y', 'z', null)).toBe('eve-x-y-z');
  });
});
