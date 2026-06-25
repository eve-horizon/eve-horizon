import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface ExpandManifestReferencesOptions {
  repoRoot: string;
  manifestPath?: string;
}

export interface ExpandManifestReferencesResult {
  yaml: string;
  manifest: Record<string, unknown>;
  expanded: boolean;
  sources: string[];
}

interface ExpansionContext {
  repoRoot: string;
  repoRealRoot: string;
  manifestDir: string;
  sources: Set<string>;
}

const WORKFLOW_FILENAMES = ['workflow.yaml', 'workflow.yml'] as const;

export function expandManifestReferences(
  manifestYaml: string,
  options: ExpandManifestReferencesOptions,
): ExpandManifestReferencesResult {
  const parsed = parseYaml(manifestYaml);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Manifest YAML must be a map');
  }

  const manifest = parsed as Record<string, unknown>;
  const repoRoot = realpathSync(path.resolve(options.repoRoot));
  const manifestPath = options.manifestPath
    ? path.resolve(options.manifestPath)
    : path.join(repoRoot, '.eve', 'manifest.yaml');
  const context: ExpansionContext = {
    repoRoot,
    repoRealRoot: repoRoot,
    manifestDir: path.dirname(manifestPath),
    sources: new Set<string>(),
  };

  const workflows = manifest.workflows;
  if (!workflows || typeof workflows !== 'object' || Array.isArray(workflows)) {
    return { yaml: manifestYaml, manifest, expanded: false, sources: [] };
  }

  let changed = false;
  const expandedWorkflows: Record<string, unknown> = {};

  for (const [workflowName, rawDefinition] of Object.entries(workflows as Record<string, unknown>)) {
    if (!rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition)) {
      expandedWorkflows[workflowName] = rawDefinition;
      continue;
    }

    const definition = rawDefinition as Record<string, unknown>;
    const ref = definition.$ref;
    if (ref !== undefined) {
      if (typeof ref !== 'string' || ref.trim().length === 0) {
        throw new Error(`Workflow "${workflowName}" has invalid $ref; expected a non-empty string`);
      }
      const siblingKeys = Object.keys(definition).filter((key) => key !== '$ref');
      if (siblingKeys.length > 0) {
        throw new Error(
          `Workflow "${workflowName}" cannot combine $ref with inline keys: ${siblingKeys.join(', ')}`,
        );
      }

      const { definition: loaded, filePath } = loadWorkflowDefinition(context, ref, workflowName);
      expandedWorkflows[workflowName] = expandWorkflowPromptFiles(
        loaded,
        path.dirname(filePath),
        workflowName,
        context,
      );
      changed = true;
      continue;
    }

    const expandedInline = expandWorkflowPromptFiles(
      definition,
      context.manifestDir,
      workflowName,
      context,
    );
    expandedWorkflows[workflowName] = expandedInline;
    if (expandedInline !== definition) {
      changed = true;
    }
  }

  if (!changed) {
    return { yaml: manifestYaml, manifest, expanded: false, sources: [] };
  }

  manifest.workflows = expandedWorkflows;
  return {
    yaml: stringifyYaml(manifest),
    manifest,
    expanded: true,
    sources: Array.from(context.sources).sort(),
  };
}

export function assertNoUnresolvedManifestReferences(manifest: Record<string, unknown>): void {
  const workflows = manifest.workflows;
  if (!workflows || typeof workflows !== 'object' || Array.isArray(workflows)) {
    return;
  }

  for (const [workflowName, rawDefinition] of Object.entries(workflows as Record<string, unknown>)) {
    if (!rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition)) {
      continue;
    }

    const definition = rawDefinition as Record<string, unknown>;
    if ('$ref' in definition) {
      throw new Error(
        `Workflow "${workflowName}" contains unresolved $ref. Run "eve project sync" or expand workflow references before syncing.`,
      );
    }

    const steps = definition.steps;
    if (!Array.isArray(steps)) {
      continue;
    }

    for (const [index, rawStep] of steps.entries()) {
      if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
        continue;
      }
      const step = rawStep as Record<string, unknown>;
      const stepName = typeof step.name === 'string' && step.name ? step.name : `step-${index + 1}`;
      const agent = step.agent;
      if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
        continue;
      }
      const agentConfig = agent as Record<string, unknown>;
      if ('prompt_file' in agentConfig || 'prompt_ref' in agentConfig) {
        throw new Error(
          `Workflow "${workflowName}" step "${stepName}" contains unresolved agent.prompt_file. Run "eve project sync" or expand prompt files before syncing.`,
        );
      }
    }
  }
}

function loadWorkflowDefinition(
  context: ExpansionContext,
  ref: string,
  workflowName: string,
): { definition: Record<string, unknown>; filePath: string } {
  const refPath = resolveRepoLocalPath(context, ref, `workflow "${workflowName}" $ref`);
  if (!existsSync(refPath)) {
    throw new Error(`Workflow "${workflowName}" $ref not found: ${ref}`);
  }

  const stat = statSync(refPath);
  let filePath: string;
  if (stat.isDirectory()) {
    const candidates = WORKFLOW_FILENAMES
      .map((filename) => path.join(refPath, filename))
      .filter((candidate) => existsSync(candidate));
    if (candidates.length === 0) {
      throw new Error(
        `Workflow "${workflowName}" directory must contain workflow.yaml or workflow.yml: ${ref}`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `Workflow "${workflowName}" directory contains both workflow.yaml and workflow.yml: ${ref}`,
      );
    }
    filePath = candidates[0]!;
  } else if (stat.isFile()) {
    const ext = path.extname(refPath).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') {
      throw new Error(`Workflow "${workflowName}" $ref must point to a YAML file or workflow directory`);
    }
    filePath = refPath;
  } else {
    throw new Error(`Workflow "${workflowName}" $ref must point to a YAML file or workflow directory`);
  }

  const realFilePath = assertWithinRepo(context, filePath, `workflow "${workflowName}" $ref`);
  const raw = readFileSync(realFilePath, 'utf-8');
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Workflow "${workflowName}" file must be a YAML map: ${path.relative(context.repoRoot, realFilePath)}`);
  }

  context.sources.add(path.relative(context.repoRoot, realFilePath));
  return { definition: parsed as Record<string, unknown>, filePath: realFilePath };
}

function expandWorkflowPromptFiles(
  definition: Record<string, unknown>,
  baseDir: string,
  workflowName: string,
  context: ExpansionContext,
): Record<string, unknown> {
  const steps = definition.steps;
  if (!Array.isArray(steps)) {
    return definition;
  }

  let changed = false;
  const expandedSteps = steps.map((rawStep, index) => {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      return rawStep;
    }
    const step = rawStep as Record<string, unknown>;
    const agent = step.agent;
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
      return step;
    }

    const agentConfig = agent as Record<string, unknown>;
    if (!('prompt_file' in agentConfig)) {
      return step;
    }

    const promptFile = agentConfig.prompt_file;
    const stepName = typeof step.name === 'string' && step.name ? step.name : `step-${index + 1}`;
    if (typeof promptFile !== 'string' || promptFile.trim().length === 0) {
      throw new Error(
        `Workflow "${workflowName}" step "${stepName}" agent.prompt_file must be a non-empty string`,
      );
    }
    if ('prompt' in agentConfig) {
      throw new Error(
        `Workflow "${workflowName}" step "${stepName}" cannot define both agent.prompt and agent.prompt_file`,
      );
    }

    const promptPath = resolvePromptPath(context, baseDir, promptFile, workflowName, stepName);
    const prompt = readFileSync(promptPath, 'utf-8');
    context.sources.add(path.relative(context.repoRoot, promptPath));
    changed = true;

    const { prompt_file: _promptFile, prompt_ref: _promptRef, ...restAgent } = agentConfig;
    return {
      ...step,
      agent: {
        ...restAgent,
        prompt,
      },
    };
  });

  if (!changed) {
    return definition;
  }

  return {
    ...definition,
    steps: expandedSteps,
  };
}

function resolvePromptPath(
  context: ExpansionContext,
  baseDir: string,
  promptFile: string,
  workflowName: string,
  stepName: string,
): string {
  if (isDisallowedRef(promptFile)) {
    throw new Error(
      `Workflow "${workflowName}" step "${stepName}" agent.prompt_file must be a repo-local relative path`,
    );
  }
  const resolved = path.resolve(baseDir, promptFile);
  if (!existsSync(resolved)) {
    throw new Error(
      `Workflow "${workflowName}" step "${stepName}" agent.prompt_file not found: ${promptFile}`,
    );
  }
  const stat = statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(
      `Workflow "${workflowName}" step "${stepName}" agent.prompt_file must point to a file`,
    );
  }
  return assertWithinRepo(context, resolved, `workflow "${workflowName}" step "${stepName}" agent.prompt_file`);
}

function resolveRepoLocalPath(context: ExpansionContext, ref: string, label: string): string {
  if (isDisallowedRef(ref)) {
    throw new Error(`${label} must be a repo-local relative path`);
  }
  const resolved = path.resolve(context.repoRoot, ref);
  return assertPathStringWithinRepo(context, resolved, label);
}

function assertWithinRepo(context: ExpansionContext, filePath: string, label: string): string {
  const realPath = realpathSync(filePath);
  return assertPathStringWithinRepo(context, realPath, label);
}

function assertPathStringWithinRepo(context: ExpansionContext, filePath: string, label: string): string {
  const relative = path.relative(context.repoRealRoot, filePath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return filePath;
  }
  throw new Error(`${label} must stay inside the repository`);
}

function isDisallowedRef(ref: string): boolean {
  return (
    path.isAbsolute(ref) ||
    ref.startsWith('~') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)
  );
}
