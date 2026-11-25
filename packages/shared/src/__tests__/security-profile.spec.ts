import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SECURITY_CURRENT_RULESET,
  SECURITY_RULESETS,
  governingSecurityLevel,
  isSecurityProfile,
  resolveSecurityProfile,
  securityRuleSet,
} from '../security/profile.js';

describe('resolveSecurityProfile', () => {
  it('takes the project profile first, then the org, then the instance', () => {
    expect(resolveSecurityProfile({ project: 'strict', org: 'legacy', instance: 'audit' })).toBe('strict');
    expect(resolveSecurityProfile({ project: null, org: 'legacy', instance: 'audit' })).toBe('legacy');
    expect(resolveSecurityProfile({ project: null, org: null, instance: 'audit' })).toBe('audit');
  });

  it('falls back to legacy when nothing is set', () => {
    expect(resolveSecurityProfile({})).toBe('legacy');
  });

  it('ignores values that are not profiles', () => {
    expect(resolveSecurityProfile({ project: 'STRICT', org: 'audit' })).toBe('audit');
    expect(resolveSecurityProfile({ project: '', org: undefined, instance: 'off' })).toBe('legacy');
  });

  it('recognises exactly the three profiles', () => {
    expect(['legacy', 'audit', 'strict'].every(isSecurityProfile)).toBe(true);
    expect(isSecurityProfile('enforce')).toBe(false);
    expect(isSecurityProfile(null)).toBe(false);
  });
});

describe('profile stamps', () => {
  const p1Rule = 'jobs.run_step_change';
  const p2Rule = 'isolation.runner_mode';

  it('places each rule in the rule set of the release step that brought it', () => {
    expect(securityRuleSet(p1Rule)).toBe(1);
    expect(securityRuleSet('sso.audience_token')).toBe(1);
    expect(securityRuleSet(p2Rule)).toBe(2);
    expect(securityRuleSet('secrets.legacy_ciphertext')).toBe(2);
    expect(securityRuleSet('secrets.value_read')).toBe(2);
    expect(SECURITY_CURRENT_RULESET).toBe(Math.max(...Object.values(SECURITY_RULESETS)));
  });

  it('places the P3 rules in rule set 3, which a rule-set-2 strict runs under audit', () => {
    const p3Rules = [
      'managed_db.owner_url',
      'egress.allow_hosts',
      'network.ingress_isolation',
      'isolation.pod_security_admission',
      'builds.isolated',
      'auth.nip98_public_url',
    ];
    for (const rule of p3Rules) {
      expect(securityRuleSet(rule)).toBe(3);
      expect(resolveSecurityProfile({ project: 'strict', projectRuleset: 2 }, rule)).toBe('audit');
      expect(resolveSecurityProfile({ project: 'strict', projectRuleset: 3 }, rule)).toBe('strict');
    }
  });

  it('places the P4 rule in rule set 4, which a rule-set-3 strict runs under audit', () => {
    const rule = 'manifest.approval_unenforced';
    expect(securityRuleSet(rule)).toBe(4);
    expect(resolveSecurityProfile({ project: 'strict', projectRuleset: 3 }, rule)).toBe('audit');
    expect(resolveSecurityProfile({ project: 'strict', projectRuleset: 4 }, rule)).toBe('strict');
  });

  it('places the P5 rule in rule set 5, which a rule-set-4 strict runs under audit', () => {
    const rule = 'jobs.token_read_scope';
    expect(securityRuleSet(rule)).toBe(5);
    expect(resolveSecurityProfile({ project: 'strict', projectRuleset: 4 }, rule)).toBe('audit');
    expect(resolveSecurityProfile({ project: 'strict', projectRuleset: 5 }, rule)).toBe('strict');
    expect(SECURITY_CURRENT_RULESET).toBe(5);
  });

  it('counts a rule it does not know, or no rule, as rule set 1', () => {
    expect(securityRuleSet('test.rule')).toBe(1);
    expect(securityRuleSet(undefined)).toBe(1);
  });

  it('runs a rule newer than the strict stamp under audit', () => {
    const levels = { project: 'strict', projectRuleset: 1, org: 'audit', instance: 'audit' };
    expect(resolveSecurityProfile(levels, p2Rule)).toBe('audit');
    expect(resolveSecurityProfile(levels, p1Rule)).toBe('strict');
    expect(resolveSecurityProfile(levels)).toBe('strict');
  });

  it('runs every rule up to the stamp under strict', () => {
    const levels = { project: 'strict', projectRuleset: 2 };
    expect(resolveSecurityProfile(levels, p2Rule)).toBe('strict');
    expect(resolveSecurityProfile(levels, p1Rule)).toBe('strict');
  });

  it('reads an absent stamp on strict as rule set 1', () => {
    expect(resolveSecurityProfile({ project: 'strict' }, p2Rule)).toBe('audit');
    expect(resolveSecurityProfile({ project: 'strict', projectRuleset: null }, p1Rule)).toBe('strict');
    expect(resolveSecurityProfile({ instance: 'strict', instanceRuleset: 'x' }, p2Rule)).toBe('audit');
  });

  it('takes the stamp of the level that supplied the profile', () => {
    expect(resolveSecurityProfile({ org: 'strict', orgRuleset: 1, instance: 'strict', instanceRuleset: 2 }, p2Rule))
      .toBe('audit');
    expect(resolveSecurityProfile({ org: 'strict', orgRuleset: 2, instance: 'strict', instanceRuleset: 1 }, p2Rule))
      .toBe('strict');
    expect(resolveSecurityProfile({ instance: 'strict', instanceRuleset: '2' }, p2Rule)).toBe('strict');
  });

  it('never changes legacy or audit', () => {
    expect(resolveSecurityProfile({ project: 'legacy', projectRuleset: 1 }, p2Rule)).toBe('legacy');
    expect(resolveSecurityProfile({ project: 'audit', projectRuleset: 1 }, p2Rule)).toBe('audit');
  });

  it('reports the governing profile with the rule set its strict covers', () => {
    expect(governingSecurityLevel({ project: 'strict', projectRuleset: 1, instance: 'audit' }))
      .toEqual({ profile: 'strict', ruleset: 1 });
    expect(governingSecurityLevel({ org: 'strict', orgRuleset: 2 })).toEqual({ profile: 'strict', ruleset: 2 });
    expect(governingSecurityLevel({ org: 'strict' })).toEqual({ profile: 'strict', ruleset: 1 });
    expect(governingSecurityLevel({ instance: 'audit', instanceRuleset: 2 })).toEqual({ profile: 'audit', ruleset: null });
  });

  it('lists every rule of the documented rules table', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(join(here, '../../../../docs/system/security-profiles.md'), 'utf8');
    const documented = [...doc.matchAll(/^\| `([a-z_]+\.[a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(documented.length).toBeGreaterThan(20);
    expect(documented.filter((rule) => !(rule in SECURITY_RULESETS))).toEqual([]);
  });
});
