/**
 * Structural validation for workflow template expressions.
 *
 * Used by the manifest-sync path to reject obvious mistakes (unknown template
 * heads, undeclared `${inputs.<key>}` references, malformed paths) before
 * persisting the manifest. Runtime shape mismatches (e.g. `event.payload`
 * missing a field) are reported at workflow invoke time — this module only
 * validates what can be checked without an event in hand.
 *
 * Phase 4 of docs/plans/per-job-harness-override-plan.md §3.
 */

import { validateTemplate } from './expr.js';

export interface WorkflowValidationError {
  workflow: string;
  stepName?: string;
  field: string;
  message: string;
}

const TEMPLATE_FIELDS = [
  'harness_profile',
  // nested: harness_profile_override.*
] as const;

const OVERRIDE_FIELDS = [
  'harness',
  'model',
  'reasoning_effort',
  'variant',
  'temperature',
] as const;

const GIT_TEMPLATE_FIELDS = [
  'ref',
  'branch',
  'commit_message',
  'remote',
] as const;

/**
 * Validate every workflow in a parsed manifest (the raw `workflows:` dict).
 * Does not throw — returns a flat list so callers can format errors as they see fit.
 */
export function validateWorkflowTemplates(
  workflows: Record<string, unknown> | undefined | null,
): WorkflowValidationError[] {
  if (!workflows || typeof workflows !== 'object') return [];
  const errors: WorkflowValidationError[] = [];

  for (const [workflowName, rawDef] of Object.entries(workflows)) {
    if (!rawDef || typeof rawDef !== 'object') continue;
    const def = rawDef as Record<string, unknown>;

    const declaredInputs = extractDeclaredInputs(def.inputs);
    const steps = Array.isArray(def.steps) ? (def.steps as unknown[]) : [];

    validateGitTemplates(errors, workflowName, undefined, def.git, declaredInputs);

    for (const [index, rawStep] of steps.entries()) {
      if (!rawStep || typeof rawStep !== 'object') continue;
      const step = rawStep as Record<string, unknown>;
      const stepName = (typeof step.name === 'string' && step.name) || `step-${index + 1}`;

      for (const field of TEMPLATE_FIELDS) {
        const value = step[field];
        if (typeof value !== 'string') continue;
        const parseErrors = validateTemplate(value, { declaredInputs });
        for (const err of parseErrors) {
          errors.push({
            workflow: workflowName,
            stepName,
            field,
            message: err.message,
          });
        }
      }

      const override = step.harness_profile_override;
      if (override && typeof override === 'object') {
        for (const field of OVERRIDE_FIELDS) {
          const value = (override as Record<string, unknown>)[field];
          if (typeof value !== 'string') continue;
          const parseErrors = validateTemplate(value, { declaredInputs });
          for (const err of parseErrors) {
            errors.push({
              workflow: workflowName,
              stepName,
              field: `harness_profile_override.${field}`,
              message: err.message,
            });
          }
        }
      }

      validateGitTemplates(errors, workflowName, stepName, step.git, declaredInputs);
    }
  }

  return errors;
}

function validateGitTemplates(
  errors: WorkflowValidationError[],
  workflowName: string,
  stepName: string | undefined,
  git: unknown,
  declaredInputs: ReadonlySet<string>,
): void {
  if (!git || typeof git !== 'object') return;
  const gitConfig = git as Record<string, unknown>;

  for (const field of GIT_TEMPLATE_FIELDS) {
    const value = gitConfig[field];
    if (typeof value !== 'string') continue;
    const parseErrors = validateTemplate(value, { declaredInputs });
    for (const err of parseErrors) {
      errors.push({
        workflow: workflowName,
        stepName,
        field: `git.${field}`,
        message: err.message,
      });
    }
  }
}

function extractDeclaredInputs(inputs: unknown): Set<string> {
  if (!inputs || typeof inputs !== 'object') return new Set<string>();
  return new Set(Object.keys(inputs as Record<string, unknown>));
}

/**
 * Build the `{inputs}` scope for evaluating templates at workflow invoke time.
 * Resolution order per input:
 *   1. explicit value in `providedInputs` (caller's `WorkflowInvokeRequest.input`)
 *   2. `from: event.payload.<path>` lookup in `eventPayload`
 *   3. `default: <any>` from the declaration
 *
 * Missing inputs are left unset — downstream template evaluation surfaces them
 * via the resolver's `missing` list so the workflows service can fall back to
 * agent defaults with a warning.
 */
export function buildWorkflowInputsScope(
  declaredInputs: Record<string, unknown> | undefined | null,
  providedInputs: Record<string, unknown> | undefined | null,
  eventPayload: unknown,
): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  const declared = declaredInputs && typeof declaredInputs === 'object'
    ? (declaredInputs as Record<string, unknown>)
    : {};
  const provided = providedInputs && typeof providedInputs === 'object'
    ? (providedInputs as Record<string, unknown>)
    : {};

  // Union the declared inputs with any extra caller-supplied inputs — Phase 4
  // only requires declared-inputs validation at sync time; at runtime we let
  // callers pass ad-hoc inputs too (they already could via WorkflowInvokeRequest).
  const keys = new Set<string>([...Object.keys(declared), ...Object.keys(provided)]);

  for (const key of keys) {
    if (key in provided) {
      scope[key] = provided[key];
      continue;
    }
    const decl = declared[key];
    if (decl && typeof decl === 'object') {
      const { from, default: defaultValue } = decl as { from?: unknown; default?: unknown };
      if (typeof from === 'string') {
        const resolved = lookupFromPath(from, eventPayload);
        if (resolved !== undefined) {
          scope[key] = resolved;
          continue;
        }
      }
      if (defaultValue !== undefined) {
        scope[key] = defaultValue;
      }
    }
  }

  return scope;
}

function lookupFromPath(from: string, eventPayload: unknown): unknown {
  // Only `event.payload.<dotted.path>` is supported, matching the expression grammar.
  const prefix = 'event.payload';
  if (from !== prefix && !from.startsWith(`${prefix}.`)) {
    return undefined;
  }
  const rest = from.slice(prefix.length);
  if (rest.length === 0) return eventPayload;
  if (!rest.startsWith('.')) return undefined;
  const segments = rest.slice(1).split('.');
  let current: unknown = eventPayload;
  for (const segment of segments) {
    if (current === undefined || current === null) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
