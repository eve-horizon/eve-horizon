/**
 * Single source of truth for resolving a harness profile for a job.
 *
 * Historically this logic was duplicated in two places:
 *   - apps/api/src/chat/chat.service.ts::resolveHarnessProfile (8 call sites)
 *   - apps/api/src/workflows/workflows.service.ts::resolveAgentConfig (inline)
 *
 * Both read a profile name from the agent config's `x-eve.agents.profiles` (with
 * manifest fallback) and project it to `{harness, harness_options: {model,
 * reasoning_effort, temperature?}}`.
 *
 * This module adds the plan's precedence rules on top:
 *   workflowTemplate ?? inlineOverride ?? stringRef ?? agentDefault
 *
 * See docs/plans/per-job-harness-override-plan.md §3.2.
 */

import crypto from 'crypto';
import yaml from 'yaml';
import type {
  HarnessProfileSource,
  InlineProfileBundle,
} from '../schemas/job.js';
import type { JobHarnessOptions } from '../types/harness.js';

/**
 * Minimal readers the resolver needs. Passed in from the API layer so the
 * shared module does not depend on `@eve/db` directly.
 */
export interface AgentConfigReader {
  findLatestByProject(projectId: string): Promise<{ x_eve_yaml?: string | null } | null>;
}

export interface ManifestReader {
  findLatestByProject(projectId: string): Promise<{ manifest_yaml: string } | null>;
}

export interface ResolverDeps {
  agentConfigs: AgentConfigReader;
  manifests: ManifestReader;
  logger?: { warn: (message: string) => void };
}

export interface ResolverParams {
  projectId: string;
  /** Agent's own declared harness_profile (the existing baseline). */
  agentDefault?: string | null;
  /** `harness_profile` string on the request — wins over agent default. */
  stringRef?: string | null;
  /** Inline bundle on the request — wins over stringRef. */
  inlineOverride?: InlineProfileBundle | null;
  /** Inline bundle from a workflow step — wins over everything else (Phase 4). */
  workflowTemplate?: InlineProfileBundle | null;
  /** Env overrides participate in profile_hash so the attribution is stable. */
  envOverrides?: Record<string, string> | null;
}

export interface ResolverWarning {
  code: string;
  message: string;
}

export interface ResolvedProfile {
  /** Effective harness name to run (mapped into `jobs.harness`). */
  harness?: string;
  /** Effective harness options (mapped into `jobs.harness_options`). */
  harness_options?: JobHarnessOptions;
  /** Profile name when derived from a named profile (for attribution). */
  profile_name: string | null;
  /** Stable hash over normalized inputs (never plaintext secrets). */
  profile_hash: string | null;
  /** Provenance of the effective profile. */
  source: HarnessProfileSource;
  /** Non-fatal warnings (e.g. conflicting inputs). */
  warnings: ResolverWarning[];
}

type Profiles = Record<string, unknown[]>;

function readProfilesFromXEve(xEveYaml: string | null | undefined): Profiles | undefined {
  if (!xEveYaml) return undefined;
  try {
    const parsed = yaml.parse(xEveYaml) as Record<string, unknown> | undefined;
    const agentsSection = parsed?.agents as Record<string, unknown> | undefined;
    return agentsSection?.profiles as Profiles | undefined;
  } catch {
    return undefined;
  }
}

function readProfilesFromManifest(manifestYaml: string | null | undefined): Profiles | undefined {
  if (!manifestYaml) return undefined;
  try {
    const parsed = yaml.parse(manifestYaml) as Record<string, unknown> | undefined;
    const xEve = (parsed?.x_eve ?? parsed?.['x-eve']) as Record<string, unknown> | undefined;
    const agentsConfig = xEve?.agents as Record<string, unknown> | undefined;
    return agentsConfig?.profiles as Profiles | undefined;
  } catch {
    return undefined;
  }
}

function projectProfileTarget(target: Record<string, unknown>): {
  harness?: string;
  harness_options?: JobHarnessOptions;
} {
  const out: { harness?: string; harness_options?: JobHarnessOptions } = {};
  if (typeof target.harness === 'string') out.harness = target.harness;
  const opts: JobHarnessOptions = {};
  if (typeof target.model === 'string') opts.model = target.model;
  if (typeof target.reasoning_effort === 'string')
    opts.reasoning_effort = target.reasoning_effort as JobHarnessOptions['reasoning_effort'];
  if (typeof target.temperature === 'number') (opts as Record<string, unknown>).temperature = target.temperature;
  if (typeof target.variant === 'string') opts.variant = target.variant;
  if (Object.keys(opts).length > 0) out.harness_options = opts;
  return out;
}

/**
 * Look a profile name up via x-eve.agents.profiles with manifest fallback.
 * Returns `{}` on miss so callers can fall back to the next source.
 */
export async function lookupProfile(
  deps: ResolverDeps,
  projectId: string,
  profileName: string,
): Promise<{ harness?: string; harness_options?: JobHarnessOptions }> {
  try {
    const agentConfig = await deps.agentConfigs.findLatestByProject(projectId);
    let profiles = readProfilesFromXEve(agentConfig?.x_eve_yaml);
    if (!profiles) {
      const manifest = await deps.manifests.findLatestByProject(projectId);
      profiles = readProfilesFromManifest(manifest?.manifest_yaml);
    }
    if (!profiles) return {};
    const targets = profiles[profileName];
    const target = Array.isArray(targets) ? (targets[0] as Record<string, unknown>) : null;
    if (!target) return {};
    return projectProfileTarget(target);
  } catch {
    deps.logger?.warn(`Failed to resolve harness profile "${profileName}" for project ${projectId}`);
    return {};
  }
}

function normalizeBundleForHash(bundle: InlineProfileBundle): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(bundle).sort()) {
    const v = (bundle as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) sorted[k] = v;
  }
  return JSON.stringify(sorted);
}

function hashProfile(
  bundle: InlineProfileBundle | null,
  profileName: string | null,
  envOverrides: Record<string, string> | null | undefined,
): string | null {
  if (!bundle && !profileName && (!envOverrides || Object.keys(envOverrides).length === 0)) {
    return null;
  }
  const parts: string[] = [];
  parts.push(profileName ? `profile:${profileName}` : 'profile:');
  parts.push(bundle ? `bundle:${normalizeBundleForHash(bundle)}` : 'bundle:');
  if (envOverrides && Object.keys(envOverrides).length > 0) {
    const sortedKeys = Object.keys(envOverrides).sort();
    // Hash keys + the raw placeholder strings (never resolved values).
    const envPart = sortedKeys.map((k) => `${k}=${envOverrides[k]}`).join('\x00');
    parts.push(`env:${envPart}`);
  } else {
    parts.push('env:');
  }
  const input = parts.join('\x01');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Resolve an effective harness profile for a job.
 *
 * Precedence, highest → lowest:
 *   1. `workflowTemplate` (workflow step inline bundle — Phase 4)
 *   2. `inlineOverride`   (job request `harness_profile_override`)
 *   3. `stringRef`        (job request `harness_profile` string)
 *   4. `agentDefault`     (agent's declared harness_profile)
 *
 * When both `stringRef` and `inlineOverride` are present, the inline bundle
 * wins and a single `harness.profile.conflict` warning is emitted — this is
 * intentional so consumers can fall back to the string ref via per-message
 * inline overrides without breaking existing agent defaults.
 */
export async function resolveHarnessProfile(
  deps: ResolverDeps,
  params: ResolverParams,
): Promise<ResolvedProfile> {
  const warnings: ResolverWarning[] = [];

  if (params.stringRef && params.inlineOverride) {
    warnings.push({
      code: 'harness.profile.conflict',
      message: `inline harness_profile_override shadows harness_profile="${params.stringRef}"`,
    });
  }

  // Highest priority first.
  if (params.workflowTemplate) {
    const bundle = params.workflowTemplate;
    const harness_options: JobHarnessOptions = {};
    if (bundle.model) harness_options.model = bundle.model;
    if (bundle.reasoning_effort) harness_options.reasoning_effort = bundle.reasoning_effort;
    if (bundle.variant) harness_options.variant = bundle.variant;
    if (bundle.temperature !== undefined) (harness_options as Record<string, unknown>).temperature = bundle.temperature;
    return {
      harness: bundle.harness,
      harness_options: Object.keys(harness_options).length > 0 ? harness_options : undefined,
      profile_name: null,
      profile_hash: hashProfile(bundle, null, params.envOverrides),
      source: 'workflow_template',
      warnings,
    };
  }

  if (params.inlineOverride) {
    const bundle = params.inlineOverride;
    const harness_options: JobHarnessOptions = {};
    if (bundle.model) harness_options.model = bundle.model;
    if (bundle.reasoning_effort) harness_options.reasoning_effort = bundle.reasoning_effort;
    if (bundle.variant) harness_options.variant = bundle.variant;
    if (bundle.temperature !== undefined) (harness_options as Record<string, unknown>).temperature = bundle.temperature;
    return {
      harness: bundle.harness,
      harness_options: Object.keys(harness_options).length > 0 ? harness_options : undefined,
      profile_name: null,
      profile_hash: hashProfile(bundle, null, params.envOverrides),
      source: 'inline_override',
      warnings,
    };
  }

  if (params.stringRef) {
    const resolved = await lookupProfile(deps, params.projectId, params.stringRef);
    return {
      ...resolved,
      profile_name: params.stringRef,
      profile_hash: hashProfile(null, params.stringRef, params.envOverrides),
      source: 'string_ref',
      warnings,
    };
  }

  if (params.agentDefault) {
    const resolved = await lookupProfile(deps, params.projectId, params.agentDefault);
    return {
      ...resolved,
      profile_name: params.agentDefault,
      profile_hash: hashProfile(null, params.agentDefault, params.envOverrides),
      source: 'agent_default',
      warnings,
    };
  }

  return {
    profile_name: null,
    profile_hash: hashProfile(null, null, params.envOverrides),
    source: 'agent_default',
    warnings,
  };
}
