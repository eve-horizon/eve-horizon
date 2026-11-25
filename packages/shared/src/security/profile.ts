/**
 * Security profiles decide what a hardening rule does:
 *
 * - `legacy`: today's behaviour; the rule is not checked. Deprecated in
 *   0.1.330 and removed in 0.1.331 (stored `legacy` becomes `audit`).
 * - `audit`: today's behaviour, plus a finding recording what `strict`
 *   would refuse.
 * - `strict`: the rule is enforced (403), and the refusal is recorded.
 *
 * A profile is set on the instance, an org or a project. A project overrides
 * its org and an org overrides the instance. Each rule names whose profile
 * governs it: the side the rule protects (the instance for identity, the
 * project for its own resources, the org for org-wide data).
 *
 * A `strict` profile is stamped with the rule set current when it was set.
 * A rule from a later rule set runs under `audit` there until `strict` is set
 * again, so a release never starts enforcing new rules on its own.
 */
export const SECURITY_PROFILES = ['legacy', 'audit', 'strict'] as const;

export type SecurityProfile = (typeof SECURITY_PROFILES)[number];

/** Given wherever a level is set to, or resolves to, `legacy` (0.1.330). */
export const SECURITY_LEGACY_DEPRECATION = 'legacy is deprecated and is removed in 0.1.331; use audit';

export type SecurityGoverningScope = 'instance' | 'org' | 'project';

/** Instance setting holding the instance profile. */
export const SECURITY_PROFILE_SETTING = 'security.profile';

/** Instance setting holding the rule set the instance's `strict` covers. */
export const SECURITY_PROFILE_RULESET_SETTING = 'security.profile_ruleset';

/** Instance setting holding the profile written onto each new project. */
export const SECURITY_NEW_PROJECT_PROFILE_SETTING = 'security.new_project_profile';

/**
 * The rule set of each rule: the release step that brought it (P1 is 1, P2
 * is 2, P3 is 3, P4 is 4). New behaviour gets a new rule id, never a wider
 * meaning for an old one, so a stamp keeps what it covered. A rule not
 * listed counts as 1.
 */
export const SECURITY_RULESETS: Readonly<Record<string, number>> = {
  // P1
  'jobs.run_step_change': 1,
  'jobs.dependency_change': 1,
  'jobs.approve_token': 1,
  'pipelines.approve_token': 1,
  'harness.no_preference': 1,
  'harness.missing_credential': 1,
  'harness.missing_profile': 1,
  'harness.missing_agent': 1,
  'harness.reserved_env': 1,
  'harness.user_secret_routing': 1,
  'ports.implicit_public': 1,
  'access.implicit_project': 1,
  'access.unresolved_project': 1,
  'access.org_route_project': 1,
  'chat.sender_rights': 1,
  'access.org_data_unscoped': 1,
  'access.org_data_no_user': 1,
  'access.org_data_scope_wide': 1,
  'access.org_data_scope_unjudged': 1,
  'access.org_data_role_wildcard': 1,
  'access.org_data_route_scope': 1,
  'sso.session_origin': 1,
  'sso.app_access': 1,
  'sso.audience_token': 1,
  // P2
  'isolation.runner_mode': 2,
  'isolation.pod_security': 2,
  'egress.default_deny': 2,
  'secrets.unbound_job': 2,
  'secrets.system_scope': 2,
  'secrets.value_read': 2,
  'secrets.use': 2,
  'secrets.job_org_write': 2,
  'access.operator_rights': 2,
  'envdb.export': 2,
  'webhooks.global_secret': 2,
  'harness.checkout_settings': 2,
  'internal.service_key': 2,
  'registry.internal_key': 2,
  'secrets.legacy_ciphertext': 2,
  // P3
  'managed_db.owner_url': 3,
  'egress.allow_hosts': 3,
  'network.ingress_isolation': 3,
  'isolation.pod_security_admission': 3,
  'builds.isolated': 3,
  'auth.nip98_public_url': 3,
  // P4
  'manifest.approval_unenforced': 4,
  // P5
  'jobs.token_read_scope': 5,
};

/** The rule set a `strict` profile set now is stamped with. */
export const SECURITY_CURRENT_RULESET = Math.max(...Object.values(SECURITY_RULESETS));

export function isSecurityProfile(value: unknown): value is SecurityProfile {
  return typeof value === 'string' && (SECURITY_PROFILES as readonly string[]).includes(value);
}

/** The rule set of a rule; an unlisted rule, or none, is rule set 1. */
export function securityRuleSet(rule: string | undefined): number {
  return (rule && SECURITY_RULESETS[rule]) || 1;
}

/** A stored stamp as a rule set; anything else (absent, or not a positive integer) is 1. */
export function parseSecurityRuleset(value: unknown): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : 1;
}

/** The profile at each level, and the stamp each level's `strict` carries. */
export interface SecurityProfileLevels {
  project?: unknown;
  org?: unknown;
  instance?: unknown;
  projectRuleset?: unknown;
  orgRuleset?: unknown;
  instanceRuleset?: unknown;
}

/**
 * The first valid profile of project, org and instance, else `legacy`, and,
 * when it is `strict`, the rule set that level's stamp covers.
 */
export function governingSecurityLevel(levels: SecurityProfileLevels): {
  profile: SecurityProfile;
  ruleset: number | null;
} {
  const order: Array<[unknown, unknown]> = [
    [levels.project, levels.projectRuleset],
    [levels.org, levels.orgRuleset],
    [levels.instance, levels.instanceRuleset],
  ];
  for (const [value, stamp] of order) {
    if (!isSecurityProfile(value)) continue;
    return { profile: value, ruleset: value === 'strict' ? parseSecurityRuleset(stamp) : null };
  }
  return { profile: 'legacy', ruleset: null };
}

/**
 * The profile a rule runs under: the first valid profile of project, org and
 * instance, else `legacy`; a `strict` whose stamp predates the rule's rule
 * set runs it under `audit`. With no rule, the rule set is 1.
 */
export function resolveSecurityProfile(levels: SecurityProfileLevels, rule?: string): SecurityProfile {
  const { profile, ruleset } = governingSecurityLevel(levels);
  if (profile === 'strict' && securityRuleSet(rule) > (ruleset ?? 1)) return 'audit';
  return profile;
}
