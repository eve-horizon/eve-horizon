import { z } from 'zod';
import { PaginationSchema } from './common.js';

export const ApiSourceTypeSchema = z.enum(['openapi', 'postgrest', 'supabase-graphql']);

export type ApiSourceType = z.infer<typeof ApiSourceTypeSchema>;

export const ApiSourceSchema = z.object({
  project_id: z.string(),
  env_name: z.string().nullable(),
  name: z.string(),
  type: ApiSourceTypeSchema,
  base_url: z.string(),
  spec_url: z.string().nullable(),
  auth_mode: z.string().nullable(),
  cached_schema_json: z.record(z.unknown()).nullable(),
  last_synced_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ApiSource = z.infer<typeof ApiSourceSchema>;

export const ApiSourceListResponseSchema = z.object({
  data: z.array(ApiSourceSchema),
  pagination: PaginationSchema.optional(),
});

export type ApiSourceListResponse = z.infer<typeof ApiSourceListResponseSchema>;

export const ApiSourceSpecResponseSchema = z.object({
  schema: z.unknown(),
});

export type ApiSourceSpecResponse = z.infer<typeof ApiSourceSpecResponseSchema>;

// ---------------------------------------------------------------------------
// Instruction block generation for app API awareness
// ---------------------------------------------------------------------------

export interface AppApiCliInfo {
  name: string;
  bin: string;
  image?: string;
}

export interface AppApiInfo {
  name: string;
  type: string;
  base_url: string;
  origin?: 'project' | 'app_link';
  alias?: string;
  subscription_id?: string;
  token?: string;
  scopes?: string[];
  producer_project_id?: string;
  producer_env?: string;
  cli?: AppApiCliInfo;
}

/**
 * Generate the instruction block that tells an agent how to call project APIs.
 * Used by both the jobs service and the workflow service when `app_apis` are
 * requested in job hints.
 *
 * The platform also injects env vars: EVE_APP_API_URL_{NAME} for each API.
 * Auth is via EVE_JOB_TOKEN (already injected by the runtime).
 */
export function buildAppApiInstructionBlock(apis: AppApiInfo[]): string {
  if (apis.length === 0) return '';

  const apiLines = apis.map((api) => {
    const { name, type, base_url, cli } = api;
    const envName = (api.origin === 'app_link' ? api.alias ?? name : name).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const baseUrl = base_url || '<base_url>';
    const urlEnv = api.origin === 'app_link'
      ? `EVE_APP_LINK_${envName}_API_URL`
      : `EVE_APP_API_URL_${envName}`;
    const authEnv = api.origin === 'app_link'
      ? `EVE_APP_LINK_${envName}_TOKEN`
      : 'EVE_JOB_TOKEN';
    const headingName = api.origin === 'app_link' ? api.alias ?? name : name;
    const headingDetail = api.origin === 'app_link'
      ? `cross-project app link to ${api.producer_project_id ?? 'producer'}`
      : type;

    if (cli) {
      // CLI-first instruction: prefer CLI, show curl as fallback
      return (
        `- **${headingName}** (${headingDetail}): \`${baseUrl}\`\n` +
        `  - CLI: \`${cli.name}\` (on PATH — run \`${cli.name} --help\` to see all commands)\n` +
        `  - Fallback env var: \`$${urlEnv}\`\n` +
        `  - Fallback auth: \`Authorization: Bearer $${authEnv}\`\n` +
        '  - Example:\n' +
        '    ```bash\n' +
        `    ${cli.name} --help\n` +
        '    ```'
      );
    }

    return (
      `- **${headingName}** (${headingDetail}): \`${baseUrl}\`\n` +
      `  - Env var: \`$${urlEnv}\`\n` +
      `  - Auth: \`Authorization: Bearer $${authEnv}\`\n` +
      '  - Example:\n' +
      '    ```bash\n' +
      `    curl -s "$${urlEnv}/health" \\\n` +
      `      -H "Authorization: Bearer $${authEnv}"\n` +
      '    ```\n' +
      '  - Or with fetch:\n' +
      '    ```javascript\n' +
      `    const res = await fetch(process.env.${urlEnv} + '/health', {\n` +
      `      headers: { Authorization: \`Bearer \${process.env.${authEnv}}\` },\n` +
      '    });\n' +
      '    ```'
    );
  });

  return `\n\n---\n**Available App APIs** (env vars injected by platform):\n${apiLines.join('\n')}`;
}

/**
 * Build env vars for resolved app APIs. Injected into the harness process
 * by the agent runtime so agents can discover APIs without parsing descriptions.
 */
export function buildAppApiEnvVars(apis: AppApiInfo[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const api of apis) {
    if (!api.base_url) continue;
    const envName = (api.origin === 'app_link' ? api.alias ?? api.name : api.name).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (api.origin === 'app_link') {
      env[`EVE_APP_LINK_${envName}_API_URL`] = api.base_url;
      if (api.token) env[`EVE_APP_LINK_${envName}_TOKEN`] = api.token;
      if (api.cli?.name) env[`EVE_APP_LINK_${envName}_CLI`] = api.cli.name;
      if (api.scopes?.length) env[`EVE_APP_LINK_${envName}_SCOPES`] = api.scopes.join(',');
      if (api.producer_project_id) env[`EVE_APP_LINK_${envName}_PROJECT`] = api.producer_project_id;
      if (api.producer_env) env[`EVE_APP_LINK_${envName}_ENV`] = api.producer_env;
      continue;
    }
    env[`EVE_APP_API_URL_${envName}`] = api.base_url;
  }
  return env;
}
