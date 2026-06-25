import type { environmentQueries } from '@eve/db';
import { generateEnvironmentId, type Manifest } from '@eve/shared';

type EnvironmentQueries = ReturnType<typeof environmentQueries>;
export type EnvironmentRow = Awaited<ReturnType<EnvironmentQueries['findByProjectAndName']>>;

export async function ensureManifestEnvironment(
  environments: EnvironmentQueries,
  projectId: string,
  envName: string,
  manifest: Manifest,
): Promise<NonNullable<EnvironmentRow> | null> {
  const existing = await environments.findByProjectAndName(projectId, envName);
  if (existing) {
    return existing;
  }

  const envManifestConfig = manifest.environments?.[envName];
  if (!envManifestConfig) {
    return null;
  }

  return environments.create({
    id: generateEnvironmentId(),
    project_id: projectId,
    name: envName,
    type: 'persistent',
    kind: 'standard',
    namespace: null,
    db_ref: null,
    overrides_json: (envManifestConfig as Record<string, unknown>).overrides as Record<string, unknown> ?? null,
    labels_json: null,
    current_release_id: null,
    last_failed_release_id: null,
    last_applied_release_id: null,
    last_deploy_failure_json: null,
  });
}
