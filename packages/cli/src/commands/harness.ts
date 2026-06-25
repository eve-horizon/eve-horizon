import * as fs from 'fs';
import type { FlagValue } from '../lib/args';
import { getBooleanFlag, getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';
import {
  mergeEnvOverrides,
  parseEnvOverrideFlags,
  parseEnvOverridesObject,
} from '../lib/env-overrides';
import type { EnvOverrides } from '@eve/shared';

type HarnessVariantResponse = {
  name: string;
  description: string;
  source?: string;
};

type HarnessAuthStatusResponse = {
  available: boolean;
  reason: string;
  instructions: string[];
};

type HarnessCapabilityResponse = {
  supports_model: boolean;
  model_notes?: string;
  model_examples?: string[];
  reasoning?: {
    supported: boolean;
    levels?: string[];
    mode?: string;
    notes?: string;
  };
};

type HarnessInfoResponse = {
  name: string;
  aliases?: string[];
  description: string;
  variants: HarnessVariantResponse[];
  auth: HarnessAuthStatusResponse;
  capabilities?: HarnessCapabilityResponse;
};

type HarnessListResponse = {
  data: HarnessInfoResponse[];
};

type HarnessValidateRequest = {
  harness_profile_override?: Record<string, unknown>;
  env_overrides?: Record<string, string>;
};

type SecretRefReport = {
  key: string;
  status: 'resolved' | 'missing';
  resolved_at?: 'system' | 'org' | 'user' | 'project';
  hint?: string;
};

type HarnessProfileValidateResponse = {
  ok: boolean;
  harness: {
    requested: string;
    canonical: string | null;
    auth: HarnessAuthStatusResponse | null;
  };
  env_overrides: SecretRefReport[];
  warnings: Array<{ code: string; message: string }>;
};

type WorkflowDefinition = {
  steps?: unknown[];
  env_overrides?: unknown;
  [key: string]: unknown;
};

type WorkflowResponse = {
  project_id: string;
  name: string;
  definition: WorkflowDefinition;
};

type WorkflowStepValidationResult = {
  step: string;
  response: HarnessProfileValidateResponse;
};

type WorkflowHarnessValidateResponse = {
  ok: boolean;
  project_id: string;
  workflow: string;
  steps: WorkflowStepValidationResult[];
};

export async function handleHarness(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const includeCapabilities = getBooleanFlag(flags, ['capabilities']) ?? false;
  const orgId = getStringFlag(flags, ['org']);
  const projectId = getStringFlag(flags, ['project']);

  // Build query params for scope-aware auth checks
  const scopeParams = buildScopeParams(orgId, projectId);

  switch (subcommand) {
    case 'list': {
      const url = scopeParams ? `/harnesses?${scopeParams}` : '/harnesses';
      const response = await requestJson<HarnessListResponse>(context, url);
      if (json) {
        outputJson(response, json);
        return;
      }
      renderHarnessList(response.data, includeCapabilities);
      return;
    }
    case 'get': {
      const name = positionals[0];
      if (!name) throw new Error('Usage: eve harness get <name>');
      const url = scopeParams ? `/harnesses/${name}?${scopeParams}` : `/harnesses/${name}`;
      const response = await requestJson<HarnessInfoResponse>(context, url);
      if (json) {
        outputJson(response, json);
        return;
      }
      renderHarnessDetail(response);
      return;
    }
    case 'validate': {
      if (!projectId) {
        throw new Error('eve harness validate requires --project <proj_xxx|slug>');
      }
      const profileFile = getStringFlag(flags, ['profile-file', 'harness-override-file']);
      const workflowName = getStringFlag(flags, ['workflow']);
      const invocationEnvOverrides = parseEnvOverrideFlags(flags);

      if (workflowName) {
        if (profileFile) {
          throw new Error('eve harness validate --workflow cannot be combined with --profile-file');
        }
        const response = await validateWorkflowHarness(
          context,
          projectId,
          workflowName,
          invocationEnvOverrides,
        );
        if (json) {
          outputJson(response, json);
          return;
        }
        renderWorkflowValidateResponse(response);
        if (!response.ok) {
          process.exitCode = 2;
        }
        return;
      }

      const body: HarnessValidateRequest = {};

      if (profileFile) {
        const raw = fs.readFileSync(profileFile, 'utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          throw new Error(`Failed to parse --profile-file ${profileFile}: ${(err as Error).message}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('--profile-file must contain a JSON object {harness, model?, reasoning_effort?, variant?, temperature?}');
        }
        body.harness_profile_override = parsed as Record<string, unknown>;
      }

      if (invocationEnvOverrides) {
        body.env_overrides = invocationEnvOverrides;
      }

      if (!body.harness_profile_override && !body.env_overrides) {
        throw new Error(
          'eve harness validate requires --profile-file and/or at least one --env-override KEY=VALUE',
        );
      }

      const response = await requestJson<HarnessProfileValidateResponse>(
        context,
        `/projects/${projectId}/harness-profile/validate`,
        { method: 'POST', body },
      );

      if (json) {
        outputJson(response, json);
        return;
      }
      renderValidateResponse(response);
      if (!response.ok) {
        process.exitCode = 2;
      }
      return;
    }
    default:
      throw new Error('Usage: eve harness <list|get|validate>');
  }
}

async function validateWorkflowHarness(
  context: ResolvedContext,
  projectId: string,
  workflowName: string,
  invocationEnvOverrides: EnvOverrides | undefined,
): Promise<WorkflowHarnessValidateResponse> {
  const workflow = await requestJson<WorkflowResponse>(
    context,
    `/projects/${projectId}/workflows/${workflowName}`,
  );

  const steps = Array.isArray(workflow.definition?.steps) ? workflow.definition.steps : [];
  if (steps.length === 0) {
    throw new Error(`Workflow ${workflowName} has no steps to validate`);
  }

  const workflowEnv = parseEnvOverridesObject(
    workflow.definition?.env_overrides,
    `workflow ${workflowName} env_overrides`,
  );
  const results: WorkflowStepValidationResult[] = [];

  for (const [index, rawStep] of steps.entries()) {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      throw new Error(`Workflow ${workflowName} step #${index + 1} must be an object`);
    }
    const step = rawStep as Record<string, unknown>;
    const stepName = typeof step.name === 'string' && step.name ? step.name : `step-${index + 1}`;
    const stepEnv = parseEnvOverridesObject(
      step.env_overrides,
      `workflow ${workflowName} step ${stepName} env_overrides`,
    );
    const mergedEnv = mergeEnvOverrides(workflowEnv, stepEnv, invocationEnvOverrides);
    const body: HarnessValidateRequest = {
      env_overrides: mergedEnv ?? {},
    };
    const harnessOverride = getStepHarnessProfileOverride(step);
    if (harnessOverride) {
      body.harness_profile_override = harnessOverride;
    }

    const response = await requestJson<HarnessProfileValidateResponse>(
      context,
      `/projects/${projectId}/harness-profile/validate`,
      { method: 'POST', body },
    );
    results.push({ step: stepName, response });
  }

  return {
    ok: results.every((result) => result.response.ok),
    project_id: projectId,
    workflow: workflowName,
    steps: results,
  };
}

function getStepHarnessProfileOverride(step: Record<string, unknown>): Record<string, unknown> | undefined {
  if (
    step.harness_profile_override &&
    typeof step.harness_profile_override === 'object' &&
    !Array.isArray(step.harness_profile_override)
  ) {
    return step.harness_profile_override as Record<string, unknown>;
  }
  if (typeof step.harness !== 'string' || !step.harness) {
    return undefined;
  }
  const override: Record<string, unknown> = { harness: step.harness };
  if (step.harness_options && typeof step.harness_options === 'object' && !Array.isArray(step.harness_options)) {
    const options = step.harness_options as Record<string, unknown>;
    for (const key of ['model', 'reasoning_effort', 'variant', 'temperature']) {
      if (options[key] !== undefined) {
        override[key] = options[key];
      }
    }
  }
  return override;
}

function renderWorkflowValidateResponse(response: WorkflowHarnessValidateResponse): void {
  console.log(`Workflow: ${response.workflow}`);
  console.log(`Status: ${response.ok ? 'OK' : 'FAIL'}`);

  for (const result of response.steps) {
    console.log('');
    console.log(`Step: ${result.step}`);
    renderValidateResponse(result.response, '  ');
  }
}

function renderValidateResponse(response: HarnessProfileValidateResponse, prefix = ''): void {
  const status = response.ok ? 'OK' : 'FAIL';
  console.log(`${prefix}Status: ${status}`);

  if (response.harness.requested) {
    console.log(`${prefix}Harness: ${response.harness.requested}` +
      (response.harness.canonical && response.harness.canonical !== response.harness.requested
        ? ` (canonical: ${response.harness.canonical})`
        : ''));
    if (response.harness.auth) {
      const avail = response.harness.auth.available ? 'ready' : 'missing';
      console.log(`${prefix}  Auth: ${avail} — ${response.harness.auth.reason}`);
      if (!response.harness.auth.available) {
        for (const hint of response.harness.auth.instructions) {
          console.log(`${prefix}    - ${hint}`);
        }
      }
    } else if (!response.harness.canonical) {
      console.log(`${prefix}  Auth: n/a (unknown harness)`);
    }
  }

  if (response.env_overrides.length > 0) {
    console.log(`${prefix}Env overrides:`);
    for (const ref of response.env_overrides) {
      const scope = ref.resolved_at ? ` @ ${ref.resolved_at}` : '';
      const hint = ref.hint ? ` — ${ref.hint}` : '';
      console.log(`${prefix}  - ${ref.key}: ${ref.status}${scope}${hint}`);
    }
  }

  if (response.warnings.length > 0) {
    console.log(`${prefix}Warnings:`);
    for (const w of response.warnings) {
      console.log(`${prefix}  - [${w.code}] ${w.message}`);
    }
  }
}

function buildScopeParams(orgId?: string, projectId?: string): string | null {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', projectId);
  else if (orgId) params.set('org_id', orgId);
  return params.toString() || null;
}

function renderHarnessList(harnesses: HarnessInfoResponse[], includeCapabilities: boolean): void {
  if (includeCapabilities) {
    renderHarnessCapabilities(harnesses);
    return;
  }

  const rows = harnesses.map((harness) => {
    const variants = harness.variants
      .map((variant: HarnessVariantResponse) => variant.name)
      .join(', ') || 'default';
    const auth = harness.auth.available ? 'ready' : 'missing';
    const name = formatHarnessLabel(harness);
    const description = truncate(harness.description, 64);
    return { name, variants, auth, description };
  });

  const headers = ['Harness', 'Variants', 'Auth', 'Description'];
  const widths = [
    Math.max(headers[0].length, ...rows.map((row) => row.name.length)),
    Math.max(headers[1].length, ...rows.map((row) => row.variants.length)),
    Math.max(headers[2].length, ...rows.map((row) => row.auth.length)),
    Math.max(headers[3].length, ...rows.map((row) => row.description.length)),
  ];

  const line = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const mid = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const end = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;

  console.log(line);
  console.log(formatRow(headers, widths));
  console.log(mid);
  for (const row of rows) {
    console.log(formatRow([row.name, row.variants, row.auth, row.description], widths));
  }
  console.log(end);
}

function renderHarnessDetail(harness: HarnessInfoResponse): void {
  const variants = harness.variants.length
    ? harness.variants
    : [{ name: 'default', description: 'Default harness configuration' }];

  console.log(`Harness: ${harness.name}`);
  if (harness.aliases?.length) {
    console.log(`Aliases: ${harness.aliases.join(', ')}`);
  }
  console.log(`Description: ${harness.description}`);
  console.log('Variants:');
  for (const variant of variants) {
    console.log(`  - ${variant.name}: ${variant.description}`);
  }
  console.log('Auth:');
  console.log(`  - Status: ${harness.auth.available ? 'ready' : 'missing'}`);
  console.log(`  - Details: ${harness.auth.reason}`);
  console.log('  - To enable:');
  for (const instruction of harness.auth.instructions) {
    console.log(`    - ${instruction}`);
  }

  if (harness.capabilities) {
    renderCapabilitiesBlock(harness.capabilities);
  }
}

function renderHarnessCapabilities(harnesses: HarnessInfoResponse[]): void {
  for (const harness of harnesses) {
    console.log(`Harness: ${formatHarnessLabel(harness)}`);
    console.log(`  Auth: ${harness.auth.available ? 'ready' : 'missing'} (${harness.auth.reason})`);
    const variants = harness.variants.length
      ? harness.variants.map((variant: HarnessVariantResponse) => variant.name).join(', ')
      : 'default';
    console.log(`  Variants: ${variants}`);
    if (harness.capabilities) {
      renderCapabilitiesBlock(harness.capabilities, '  ');
    } else {
      console.log('  Capabilities: (not reported)');
    }
    console.log('');
  }
}

function renderCapabilitiesBlock(
  capabilities: NonNullable<HarnessInfoResponse['capabilities']>,
  prefix = '',
): void {
  const modelSupport = capabilities.supports_model ? 'supported' : 'not supported';
  const examples = capabilities.model_examples?.length
    ? ` (examples: ${capabilities.model_examples.join(', ')})`
    : '';
  const modelNotes = capabilities.model_notes ? ` — ${capabilities.model_notes}` : '';
  console.log(`${prefix}Model: ${modelSupport}${examples}${modelNotes}`);

  const reasoning = capabilities.reasoning;
  if (!reasoning) {
    console.log(`${prefix}Reasoning: (unknown)`);
    return;
  }

  if (!reasoning.supported) {
    const notes = reasoning.notes ? ` — ${reasoning.notes}` : '';
    console.log(`${prefix}Reasoning: not supported${notes}`);
    return;
  }

  const levels = reasoning.levels?.length ? reasoning.levels.join(', ') : 'unspecified';
  const mode = reasoning.mode ? ` (${reasoning.mode})` : '';
  const notes = reasoning.notes ? ` — ${reasoning.notes}` : '';
  console.log(`${prefix}Reasoning: ${levels}${mode}${notes}`);
}

function formatHarnessLabel(harness: HarnessInfoResponse): string {
  if (!harness.aliases?.length) return harness.name;
  return `${harness.name} (aliases: ${harness.aliases.join(', ')})`;
}

function formatRow(columns: string[], widths: number[]): string {
  const cells = columns.map((value, idx) => ` ${value.padEnd(widths[idx])} `);
  return `|${cells.join('|')}|`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
