import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, requestRaw } from '../lib/client';
import { outputJson } from '../lib/output';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ReleaseResponse {
  id: string;
  project_id: string;
  git_sha: string;
  manifest_hash: string;
  image_digests: Record<string, string> | null;
  build_id: string | null;
  version: string | null;
  tag: string | null;
  created_by: string | null;
  created_at: string;
}

export async function handleRelease(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'resolve': {
      const tag = positionals[0];
      if (!tag) {
        throw new Error('Usage: eve release resolve <tag> [--project <id>]');
      }

      // Determine project ID
      let projectId = typeof flags.project === 'string' ? flags.project : context.projectId;

      // If no project ID provided, try to detect from local .eve/manifest.yaml
      if (!projectId) {
        const dir = typeof flags.dir === 'string' ? flags.dir : process.cwd();
        const manifestPath = join(dir, '.eve', 'manifest.yaml');

        try {
          const yaml = readFileSync(manifestPath, 'utf-8');
          const projectMatch = yaml.match(/^project:\s*(\S+)/m);
          if (projectMatch) {
            projectId = projectMatch[1];
          }
        } catch (error) {
          // Manifest file not found or not readable, continue without it
        }
      }

      if (!projectId) {
        throw new Error(
          'Missing project id. Provide --project, set a profile default, or add "project: proj_xxx" to .eve/manifest.yaml'
        );
      }

      // Call the API endpoint
      try {
        const release = await requestJson<ReleaseResponse>(
          context,
          `/projects/${projectId}/releases/by-tag/${encodeURIComponent(tag)}`
        );

        if (json) {
          // Output full JSON
          outputJson(release, json);
        } else {
          // Human-readable format
          const displayTag = release.tag || tag;
          const displayVersion = release.version || 'N/A';
          const shortSha = release.git_sha.substring(0, 8);
          const shortHash = release.manifest_hash.substring(0, 12);

          console.log(`Release ${displayTag}`);
          console.log(`  ID:       ${release.id}`);
          console.log(`  SHA:      ${shortSha}...`);
          console.log(`  Manifest: ${shortHash}...`);
          console.log(`  Version:  ${displayVersion}`);
        }
      } catch (error) {
        // Enhance 404 errors with more context
        if (error instanceof Error && error.message.includes('HTTP 404')) {
          throw new Error(
            `Release with tag "${tag}" not found for project ${projectId}\n\n` +
            `Make sure the release exists and the tag is correct.`
          );
        }
        throw error;
      }
      return;
    }
    case 'delete': {
      const tag = positionals[0];
      if (!tag) {
        throw new Error('Usage: eve release delete <tag> [--project <id>]');
      }
      const projectId = typeof flags.project === 'string' ? flags.project : context.projectId;
      if (!projectId) {
        throw new Error('Missing project id. Provide --project or set a profile default.');
      }
      await requestRaw(
        context,
        `/projects/${projectId}/releases/by-tag/${encodeURIComponent(tag)}`,
        { method: 'DELETE' },
      );
      outputJson({ tag, deleted: true }, json, `Release ${tag} deleted`);
      return;
    }
    case 'prune': {
      const projectId = typeof flags.project === 'string' ? flags.project : context.projectId;
      if (!projectId) {
        throw new Error('Usage: eve release prune [--project <id>] [--keep <n>]');
      }
      const keep = getStringFlag(flags, ['keep']) ?? '10';
      const result = await requestJson<{ deleted: number }>(
        context,
        `/projects/${projectId}/releases/prune`,
        { method: 'POST', body: { keep: parseInt(keep, 10) } },
      );
      outputJson(result, json, `Pruned ${result.deleted} release(s)`);
      return;
    }
    default:
      throw new Error('Usage: eve release <resolve|delete|prune>');
  }
}
