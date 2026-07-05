/**
 * Manifest coherence analysis.
 *
 * Structural lint for parsed manifests: build/registry mismatches, pipeline
 * and workflow graph validation (duplicate steps, invalid deps, cycles,
 * conditions), trigger definitions, and domain-signup sanity checks. The zod
 * schemas live in `../schemas/manifest.ts`, which re-exports this module so
 * existing importers are unaffected.
 */
import type { Manifest } from '../schemas/manifest.js';
import { isFreeEmailDomain } from '../schemas/manifest.js';
import {
  getBuildableServicesWithDefaults,
  getManifestAuthConfig,
  getServicesWithBuildButNoImage,
  hasUsableRegistry,
} from './manifest-accessors.js';

export interface ManifestCoherenceWarning {
  code: string;
  message: string;
  severity: 'warning' | 'error';
}

// Valid trigger type keys (top-level keys within a trigger definition)
const VALID_TRIGGER_TYPES = ['github', 'slack', 'system', 'cron', 'app', 'app_link', 'event', 'manual'] as const;

// GitHub event types that the trigger matcher recognizes
const VALID_GITHUB_EVENTS = ['push', 'pull_request'] as const;

// System event types that the platform actually emits (without the "system." prefix).
// This list is advisory — custom system events may exist, so unknown values produce
// warnings, not errors.
const KNOWN_SYSTEM_EVENTS = [
  'job.failed',
  'job.attempt.completed',
  'pipeline.failed',
  'doc.ingest',
  'doc.created',
  'doc.updated',
  'doc.deleted',
  'thread.distilled',
  'resource.hydration.started',
  'resource.hydration.completed',
  'resource.hydration.failed',
] as const;

/**
 * Analyze manifest for structural issues that would cause runtime failures.
 */
export function analyzeManifestCoherence(manifest: Manifest): ManifestCoherenceWarning[] {
  const warnings: ManifestCoherenceWarning[] = [];

  // 1. Services with build but no image and no usable registry
  const orphans = getServicesWithBuildButNoImage(manifest);
  if (Object.keys(orphans).length > 0 && !hasUsableRegistry(manifest)) {
    for (const name of Object.keys(orphans)) {
      warnings.push({
        code: 'build_no_image',
        message: `Service "${name}" has \`build\` config but no \`image\` field and no registry configured. Add an \`image\` field or configure a \`registry\`.`,
        severity: 'error',
      });
    }
  }

  // 2. Pipeline has deploy step with no upstream build/release
  const allPipelines = { ...(manifest.pipelines ?? {}), ...(manifest.workflows ?? {}) };
  for (const [pipelineName, pipeline] of Object.entries(allPipelines)) {
    if (!pipeline || typeof pipeline !== 'object') continue;
    const steps = (pipeline as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) continue;

    const stepTypes = new Set<string>();
    for (const step of steps) {
      if (step && typeof step === 'object' && 'action' in step) {
        const action = (step as Record<string, unknown>).action;
        if (action && typeof action === 'object' && 'type' in action) {
          stepTypes.add((action as Record<string, string>).type);
        }
      }
    }

    if (stepTypes.has('deploy') && !stepTypes.has('build') && !stepTypes.has('release')) {
      const buildableCount = Object.keys(getBuildableServicesWithDefaults(manifest)).length;
      if (buildableCount > 0) {
        warnings.push({
          code: 'deploy_without_build',
          message: `Pipeline "${pipelineName}" has a deploy step but no build or release steps. ${buildableCount} service(s) have build config. Add build and release steps, or use --direct for pre-built images.`,
          severity: 'warning',
        });
      }
    }
  }

  // 3. Environment references nonexistent pipeline
  const pipelineNames = new Set(Object.keys(manifest.pipelines ?? {}));
  for (const [envName, envConfig] of Object.entries(manifest.environments ?? {})) {
    if (envConfig && typeof envConfig === 'object' && 'pipeline' in envConfig) {
      const pipelineName = (envConfig as Record<string, unknown>).pipeline as string | undefined;
      if (pipelineName && !pipelineNames.has(pipelineName)) {
        warnings.push({
          code: 'missing_pipeline',
          message: `Environment "${envName}" references pipeline "${pipelineName}" which is not defined in the manifest.`,
          severity: 'error',
        });
      }
    }
  }

  // 4. Workflow dependency graph validation
  const allWorkflowsAndPipelines = { ...(manifest.pipelines ?? {}), ...(manifest.workflows ?? {}) };
  for (const [name, def] of Object.entries(allWorkflowsAndPipelines)) {
    if (!def || typeof def !== 'object') continue;
    const steps = (def as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) continue;

    // 4a. Duplicate step names
    const stepNames = new Set<string>();
    for (const [i, step] of (steps as Array<Record<string, unknown>>).entries()) {
      const stepName = (step.name as string) || `step-${i + 1}`;
      if (stepNames.has(stepName)) {
        warnings.push({
          code: 'workflow_duplicate_step',
          message: `Workflow "${name}" has duplicate step name "${stepName}".`,
          severity: 'error',
        });
      }
      stepNames.add(stepName);
    }

    // 4b. Invalid depends_on references
    for (const [i, step] of (steps as Array<Record<string, unknown>>).entries()) {
      const stepName = (step.name as string) || `step-${i + 1}`;
      const deps = step.depends_on as string[] | undefined;
      if (!Array.isArray(deps)) continue;
      for (const dep of deps) {
        if (!stepNames.has(dep)) {
          warnings.push({
            code: 'workflow_invalid_dep',
            message: `Workflow "${name}" step "${stepName}" depends on nonexistent step "${dep}".`,
            severity: 'error',
          });
        }
      }
    }

    // 4c. Cycle detection
    const depMap = new Map<string, string[]>();
    const allStepNames: string[] = [];
    for (const [i, step] of (steps as Array<Record<string, unknown>>).entries()) {
      const stepName = (step.name as string) || `step-${i + 1}`;
      allStepNames.push(stepName);
      const deps = step.depends_on as string[] | undefined;
      depMap.set(stepName, Array.isArray(deps) ? deps : []);
    }

    const cycle = detectManifestCycle(allStepNames, depMap);
    if (cycle) {
      warnings.push({
        code: 'workflow_cycle',
        message: `Workflow "${name}" has a dependency cycle: ${cycle.join(' -> ')}.`,
        severity: 'error',
      });
    }

    // 4d. Condition validation
    for (const [i, step] of (steps as Array<Record<string, unknown>>).entries()) {
      const stepName = (step.name as string) || `step-${i + 1}`;
      const condition = step.condition;
      if (typeof condition !== 'string') continue;

      // Validate condition format: step_name.status == 'value' or step_name.status != 'value'
      const condMatch = condition.match(
        /^(\w[\w-]*)\s*\.\s*status\s*(==|!=)\s*['"]([^'"]*)['"]\s*$/,
      );
      if (!condMatch) {
        warnings.push({
          code: 'workflow_invalid_condition',
          message: `Workflow "${name}" step "${stepName}" has invalid condition "${condition}". Expected format: step_name.status == 'value' or step_name.status != 'value'.`,
          severity: 'error',
        });
        continue;
      }

      const refStepName = condMatch[1];

      // Referenced step must exist
      if (!stepNames.has(refStepName)) {
        warnings.push({
          code: 'workflow_condition_unknown_step',
          message: `Workflow "${name}" step "${stepName}" condition references nonexistent step "${refStepName}".`,
          severity: 'error',
        });
        continue;
      }

      // Referenced step must be in depends_on
      const deps = step.depends_on as string[] | undefined;
      if (!Array.isArray(deps) || !deps.includes(refStepName)) {
        warnings.push({
          code: 'workflow_condition_not_dependency',
          message: `Workflow "${name}" step "${stepName}" condition references step "${refStepName}" which is not in its depends_on list. The condition step must be a dependency.`,
          severity: 'error',
        });
      }
    }
  }

  // 5. Trigger definition validation
  for (const [name, def] of Object.entries(allPipelines)) {
    if (!def || typeof def !== 'object') continue;
    const trigger = (def as Record<string, unknown>).trigger;
    if (!trigger || typeof trigger !== 'object') continue;

    const triggerObj = trigger as Record<string, unknown>;
    const triggerKeys = Object.keys(triggerObj);

    // 5a. Trigger has at least one recognized trigger type
    const recognizedKeys = triggerKeys.filter(k =>
      (VALID_TRIGGER_TYPES as readonly string[]).includes(k),
    );
    if (recognizedKeys.length === 0) {
      warnings.push({
        code: 'trigger_no_recognized_type',
        message: `Pipeline/workflow "${name}" trigger has no recognized type. Valid types: ${VALID_TRIGGER_TYPES.join(', ')}.`,
        severity: 'warning',
      });
    }

    // 5b. GitHub trigger event type validation
    if (triggerObj.github && typeof triggerObj.github === 'object') {
      const githubEvent = (triggerObj.github as Record<string, unknown>).event;
      if (typeof githubEvent === 'string' && !(VALID_GITHUB_EVENTS as readonly string[]).includes(githubEvent)) {
        warnings.push({
          code: 'trigger_invalid_github_event',
          message: `Pipeline/workflow "${name}" has unknown GitHub event "${githubEvent}". Valid events: ${VALID_GITHUB_EVENTS.join(', ')}.`,
          severity: 'warning',
        });
      }
    }

    // 5c. System trigger event type validation
    if (triggerObj.system && typeof triggerObj.system === 'object') {
      const systemEvent = (triggerObj.system as Record<string, unknown>).event;
      if (typeof systemEvent === 'string' && !(KNOWN_SYSTEM_EVENTS as readonly string[]).includes(systemEvent)) {
        warnings.push({
          code: 'trigger_unknown_system_event',
          message: `Pipeline/workflow "${name}" has unknown system event "${systemEvent}". Known events: ${KNOWN_SYSTEM_EVENTS.join(', ')}. If this is a custom event, you can ignore this warning.`,
          severity: 'warning',
        });
      }
    }

    // 5d. Cron trigger must have a schedule
    if (triggerObj.cron && typeof triggerObj.cron === 'object') {
      const cronSchedule = (triggerObj.cron as Record<string, unknown>).schedule;
      if (!cronSchedule || (typeof cronSchedule === 'string' && cronSchedule.trim() === '')) {
        warnings.push({
          code: 'trigger_cron_no_schedule',
          message: `Pipeline/workflow "${name}" has a cron trigger with no schedule. Add a \`schedule\` field (e.g., "0 */6 * * *").`,
          severity: 'warning',
        });
      }
    }
  }

  // 6. Domain-signup coherence
  const authConfig = getManifestAuthConfig(manifest);
  if (authConfig?.org_access.domain_signup.enabled) {
    const ds = authConfig.org_access.domain_signup;
    for (const rule of ds.domains) {
      if (isFreeEmailDomain(rule.domain)) {
        warnings.push({
          code: 'domain_signup_free_provider',
          message: `domain_signup includes free-email provider "${rule.domain}" (target_org=${rule.target_org}). Anyone with such an address worldwide could sign in. Confirm this is intentional.`,
          severity: 'warning',
        });
      }
    }
    if (ds.domains.length > 25) {
      warnings.push({
        code: 'domain_signup_too_many_domains',
        message: `domain_signup declares ${ds.domains.length} domains. The recommended soft cap is 25; consider splitting into multiple apps.`,
        severity: 'warning',
      });
    }
  }

  return warnings;
}

/**
 * Detect cycles in a directed graph using DFS.
 * Returns the cycle path if found, null otherwise.
 */
function detectManifestCycle(
  nodes: string[],
  depMap: Map<string, string[]>,
): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): string[] | null {
    if (inStack.has(node)) return [...path, node];
    if (visited.has(node)) return null;
    visited.add(node);
    inStack.add(node);
    for (const dep of depMap.get(node) ?? []) {
      const cycle = dfs(dep, [...path, node]);
      if (cycle) return cycle;
    }
    inStack.delete(node);
    return null;
  }

  for (const name of nodes) {
    const cycle = dfs(name, []);
    if (cycle) return cycle;
  }
  return null;
}
