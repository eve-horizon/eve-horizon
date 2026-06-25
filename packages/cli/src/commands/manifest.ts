import type { FlagValue } from '../lib/args';
import { getStringFlag, toBoolean } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';
import { expandManifestReferences } from '@eve/shared';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface ManifestValidateResponse {
  valid: boolean;
  manifest_hash?: string;
  parsed_defaults?: Record<string, unknown> | null;
  parsed_agents?: Record<string, unknown> | null;
  secret_validation?: {
    missing: Array<{ key: string; hints: string[] }>;
  };
  warnings?: string[];
  errors?: string[];
}

export async function handleManifest(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'validate': {
      const useLatest = toBoolean(flags.latest) ?? false;
      const strict = toBoolean(flags.strict) ?? false;
      const validateSecretsFlag = flags['validate-secrets'] ?? flags.validate_secrets;
      const validateSecrets = toBoolean(validateSecretsFlag) ?? false;
      const dir = typeof flags.dir === 'string' ? flags.dir : process.cwd();
      const manifestPath = getStringFlag(flags, ['path']) ?? join(dir, '.eve', 'manifest.yaml');

      let manifestYaml: string | undefined;
      if (!useLatest) {
        try {
          manifestYaml = readFileSync(manifestPath, 'utf-8');
          const repoRoot = resolve(dir);
          manifestYaml = expandManifestReferences(manifestYaml, {
            repoRoot,
            manifestPath,
          }).yaml;
        } catch (error) {
          throw new Error(`Failed to read manifest at ${manifestPath}: ${(error as Error).message}`);
        }
      }

      let projectId = getStringFlag(flags, ['project']) ?? context.projectId;
      if (!projectId && manifestYaml) {
        const match = manifestYaml.match(/^project:\s*(\S+)/m);
        if (match) {
          projectId = match[1];
        }
      }

      if (!projectId) {
        throw new Error('Missing project id. Provide --project, set a profile default, or add "project: proj_xxx" to manifest.');
      }

      const response = await requestJson<ManifestValidateResponse>(
        context,
        `/projects/${projectId}/manifest/validate`,
        {
          method: 'POST',
          body: {
            manifest_yaml: manifestYaml,
            validate_secrets: validateSecrets || strict,
            strict,
          },
        },
      );

      if (json) {
        outputJson(response, json);
      } else {
        if (response.valid) {
          console.log('✓ Manifest valid');
        } else {
          console.log('✗ Manifest invalid');
        }

        if (response.manifest_hash) {
          console.log(`  Hash: ${response.manifest_hash.substring(0, 12)}...`);
        }

        if (response.errors && response.errors.length > 0) {
          console.log('');
          console.log('Errors:');
          response.errors.forEach((error) => console.log(`  - ${error}`));
        }

        if (response.warnings && response.warnings.length > 0) {
          console.log('');
          console.log('Warnings:');
          response.warnings.forEach((warning) => console.log(`  - ${warning}`));
        }

        if (response.secret_validation?.missing?.length) {
          console.log('');
          console.log('Missing secrets:');
          response.secret_validation.missing.forEach((item) => {
            const hint = item.hints?.[0] ? ` (${item.hints[0]})` : '';
            console.log(`  - ${item.key}${hint}`);
          });
        }
      }

      if (!response.valid) {
        process.exitCode = 1;
      }
      return;
    }
    default:
      throw new Error('Usage: eve manifest <validate>');
  }
}
