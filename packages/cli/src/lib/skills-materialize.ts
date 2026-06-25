import {
  materializeResolvedSkillSources,
  prepareSkillSourcesForWorkspace,
  resolveManifestSkillSources,
  resolveSkillsTxtSkillSources,
  type ResolvedSkillSource,
  type SkillInstallMode,
} from '@eve/shared';
import type { FlagValue } from './args';

export async function runSkillsMaterialize(
  projectRoot: string,
  positionals: string[],
  flags: Record<string, FlagValue>,
): Promise<void> {
  const selector = positionals[0] ?? 'manifest';
  const installMode = parseInstallMode(flags.mode);
  const overrideAgents = parseAgents(flags.agents);
  const runtime = Boolean(flags.runtime);

  if (selector === 'manifest') {
    const skillMode = typeof flags['skill-mode'] === 'string' ? flags['skill-mode'] : 'runtime';
    const { sources, mode } = await resolveManifestSkillSources(projectRoot, {
      modeName: skillMode,
      runtimeOnly: runtime,
    });
    const prepared = await prepareSkillSourcesForWorkspace(projectRoot, sources, {
      runtimeOnly: runtime,
      vendorExternalSources: !runtime,
    });
    const finalSources = applyInstallAgentOverride(prepared, overrideAgents);
    const result = await materializeResolvedSkillSources(projectRoot, finalSources, {
      mode: installMode,
    });
    printSummary(
      result,
      `Materialized ${result.materialized.length} skill(s) from manifest mode "${mode?.name ?? skillMode}"`,
    );
    return;
  }

  if (selector === 'skills.txt') {
    const sources = resolveSkillsTxtSkillSources(projectRoot, {
      installAgents: overrideAgents,
      localOnly: true,
    });
    const result = await materializeResolvedSkillSources(projectRoot, sources, {
      mode: installMode,
    });
    printSummary(result, `Materialized ${result.materialized.length} local skill(s) from skills.txt`);
    return;
  }

  throw new Error(
    'Usage: eve skills materialize <manifest|skills.txt>\n' +
      '  eve skills materialize manifest [--skill-mode <name>] [--mode symlink|copy] [--agents a,b]\n' +
      '  eve skills materialize skills.txt [--mode symlink|copy] [--agents a,b]',
  );
}

function parseInstallMode(value: FlagValue | undefined): SkillInstallMode {
  if (value === undefined || value === false || value === null) {
    return 'symlink';
  }
  if (value === 'symlink' || value === 'copy') {
    return value;
  }
  throw new Error(`Invalid --mode value "${String(value)}"; expected "symlink" or "copy"`);
}

function parseAgents(value: FlagValue | undefined): string[] | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function applyInstallAgentOverride(
  sources: ResolvedSkillSource[],
  overrideAgents?: string[],
): ResolvedSkillSource[] {
  if (!overrideAgents || overrideAgents.length === 0) {
    return sources;
  }
  return sources.map((source) => ({
    ...source,
    installAgents: overrideAgents,
  }));
}

function printSummary(
  result: { materialized: Array<{ installName: string }>; warnings: string[] },
  headline: string,
): void {
  console.log(headline);
  if (result.materialized.length === 0) {
    console.log('No skills materialized');
    return;
  }

  for (const entry of result.materialized) {
    console.log(`  - ${entry.installName}`);
  }
  if (result.warnings.length > 0) {
    console.log(`Warnings: ${result.warnings.length}`);
  }
}
