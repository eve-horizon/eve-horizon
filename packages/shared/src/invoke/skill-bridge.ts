import {
  materializeResolvedSkillSources,
  prepareSkillSourcesForWorkspace,
  resolveManifestSkillSources,
  type MaterializeSkillSourcesResult,
  type SkillInstallMode,
} from '../skills/index.js';

export async function materializeWorkspaceSkills(
  projectRoot: string,
  opts: { skillMode?: string; mode?: SkillInstallMode } = {},
): Promise<MaterializeSkillSourcesResult> {
  const { sources } = await resolveManifestSkillSources(projectRoot, {
    modeName: opts.skillMode ?? 'runtime',
    runtimeOnly: true,
  });

  if (sources.length === 0) {
    return { materialized: [], warnings: [] };
  }

  const prepared = await prepareSkillSourcesForWorkspace(projectRoot, sources, {
    runtimeOnly: true,
  });

  return materializeResolvedSkillSources(projectRoot, prepared, {
    mode: opts.mode ?? 'symlink',
  });
}
