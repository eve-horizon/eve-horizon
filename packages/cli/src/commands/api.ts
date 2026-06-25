import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

type ApiSource = {
  name: string;
  type: 'openapi' | 'postgrest' | 'supabase-graphql' | string;
  base_url: string;
  spec_url?: string | null;
  auth_mode?: string | null;
  cached_schema_json?: unknown;
  last_synced_at?: string | null;
};

type ApiListResponse = {
  data: ApiSource[];
  pagination?: {
    total: number;
    limit: number;
    offset: number;
  };
};

export async function handleApi(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const jsonOutput = Boolean(flags.json);

  switch (subcommand) {
    case 'list':
      return handleList(positionals, flags, context, jsonOutput);
    case 'show':
      return handleShow(positionals, flags, context, jsonOutput);
    case 'spec':
      return handleSpec(positionals, flags, context, jsonOutput);
    case 'refresh':
      return handleRefresh(positionals, flags, context, jsonOutput);
    case 'examples':
      return handleExamples(positionals, flags, context, jsonOutput);
    case 'call':
      return handleCall(positionals, flags, context);
    case 'generate':
      return handleGenerate(positionals, flags, jsonOutput);
    case 'diff':
      return handleDiff(positionals, flags, jsonOutput);
    default:
      throw new Error(
        'Usage: eve api <list|show|spec|refresh|examples|call|generate|diff>\n' +
        '  list [project]                          - list API sources\n' +
        '  show <name> [project]                   - show a single API source\n' +
        '  spec <name> [project]                   - show cached API spec\n' +
        '  refresh <name> [project]                - refresh cached API spec\n' +
        '  examples <name> [project]               - print curl examples from spec\n' +
        '  call <name> <method> <path> [options]   - call an API with Eve auth\n' +
        '  generate [--out <dir>]                  - export API OpenAPI spec\n' +
        '  diff [--exit-code] [--out <dir>]        - diff generated OpenAPI spec',
      );
  }
}

async function handleList(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Usage: eve api list [project] [--project=<id>] [--env=<name>]');
  }

  const query = buildQuery({
    env: resolveEnv(flags),
  });

  const response = await requestJson<ApiListResponse>(
    context,
    `/projects/${projectId}/apis${query}`,
  );

  if (jsonOutput) {
    outputJson(response, jsonOutput);
    return;
  }

  if (!response.data || response.data.length === 0) {
    console.log('No API sources found.');
    return;
  }

  formatApiSourcesTable(response.data);
}

async function handleShow(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const name = positionals[0] ?? getStringFlag(flags, ['name']);
  const projectId = positionals[1] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const env = resolveEnv(flags);

  if (!name || !projectId) {
    throw new Error('Usage: eve api show <name> [project] [--project=<id>] [--env=<name>]');
  }

  const query = buildQuery({ env });
  const response = await requestJson<ApiSource>(context, `/projects/${projectId}/apis/${name}${query}`);
  outputJson(response, jsonOutput);
}

export async function handleSpec(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const name = positionals[0] ?? getStringFlag(flags, ['name']);
  const projectId = positionals[1] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const env = resolveEnv(flags);

  if (!name || !projectId) {
    throw new Error('Usage: eve api spec <name> [project] [--project=<id>] [--env=<name>]');
  }

  const spec = await fetchApiSpec(context, projectId, name, env);
  if (typeof spec.data === 'string') {
    outputJson(spec.data, jsonOutput, spec.raw);
    return;
  }
  outputJson(spec.data, jsonOutput);
}

async function handleRefresh(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const name = positionals[0] ?? getStringFlag(flags, ['name']);
  const projectId = positionals[1] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const env = resolveEnv(flags);

  if (!name || !projectId) {
    throw new Error('Usage: eve api refresh <name> [project] [--project=<id>] [--env=<name>]');
  }

  const query = buildQuery({ env });
  const response = await requestJson(context, `/projects/${projectId}/apis/${name}/refresh${query}`, {
    method: 'POST',
  });
  outputJson(response, jsonOutput);
}

async function handleExamples(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const name = positionals[0] ?? getStringFlag(flags, ['name']);
  const projectId = positionals[1] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const env = resolveEnv(flags);

  if (!name || !projectId) {
    throw new Error('Usage: eve api examples <name> [project] [--project=<id>] [--env=<name>]');
  }

  const query = buildQuery({ env });
  const api = await requestJson<ApiSource>(context, `/projects/${projectId}/apis/${name}${query}`);
  const spec = await fetchApiSpec(context, projectId, name, env);

  if (jsonOutput) {
    outputJson({ api, spec: spec.data }, jsonOutput);
    return;
  }

  if (!spec.data || typeof spec.data !== 'object') {
    throw new Error('API spec is not JSON; examples require a JSON OpenAPI spec.');
  }

  const examples = buildCurlExamples(api, spec.data as OpenApiSpec);
  if (examples.length === 0) {
    console.log('No endpoints found in spec.');
    return;
  }

  console.log(`API examples for ${api.name} (${api.type})`);
  console.log('');
  examples.forEach((example) => {
    console.log(example);
  });
}

async function handleGenerate(
  positionals: string[],
  flags: Record<string, FlagValue>,
  jsonOutput: boolean,
): Promise<void> {
  const outDir = getStringFlag(flags, ['out']) ?? positionals[0];
  const repoRoot = resolveRepoRoot();
  const outputDir = outDir
    ? resolvePath(repoRoot, outDir)
    : resolvePath(repoRoot, 'docs/system');

  runOpenApiExport(repoRoot, outputDir);
  outputJson({ ok: true, output_dir: outputDir }, jsonOutput, `OpenAPI exported to ${outputDir}`);
}

async function handleDiff(
  positionals: string[],
  flags: Record<string, FlagValue>,
  jsonOutput: boolean,
): Promise<void> {
  const exitCode = Boolean(flags['exit-code']);
  const repoRoot = resolveRepoRoot();
  const expectedDir = getStringFlag(flags, ['out']) ?? positionals[0];
  const targetDir = expectedDir
    ? resolvePath(repoRoot, expectedDir)
    : resolvePath(repoRoot, 'docs/system');

  const tempDir = mkdtempSync(join(tmpdir(), 'eve-openapi-'));
  try {
    runOpenApiExport(repoRoot, tempDir);
    const actualPath = resolvePath(tempDir, 'openapi.yaml');
    const expectedPath = resolvePath(targetDir, 'openapi.yaml');
    if (!existsSync(expectedPath)) {
      throw new Error(`Missing expected OpenAPI spec at ${expectedPath}`);
    }

    const diff = spawnSync('diff', ['-u', expectedPath, actualPath], { stdio: 'inherit' });
    const hasDiff = diff.status !== 0;
    if (hasDiff && exitCode) {
      throw new Error('OpenAPI spec drift detected');
    }

    outputJson({ ok: !hasDiff }, jsonOutput, hasDiff ? 'OpenAPI spec drift detected' : 'OpenAPI spec matches');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function handleCall(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const name = positionals[0];
  const methodInput = positionals[1];
  const pathInput = positionals[2];

  if (!name || !methodInput || !pathInput) {
    throw new Error('Usage: eve api call <name> <method> <path> [--json <payload>] [--jq <expr>]');
  }

  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const env = resolveEnv(flags);
  if (!projectId) {
    throw new Error('Missing project id. Provide --project or set a profile default.');
  }

  const query = buildQuery({ env });
  const api = await requestJson<ApiSource>(context, `/projects/${projectId}/apis/${name}${query}`);

  const jqExpr = getStringFlag(flags, ['jq']);
  const printCurl = Boolean(flags['print-curl']);
  const extraPositionals = positionals.slice(3);

  const jsonPayloadFlag = resolveJsonPayloadFlag(flags, extraPositionals);
  if (jsonPayloadFlag === true) {
    throw new Error('Usage: --json <payload|@file> (or --data/-d)');
  }

  const graphqlFlag = flags.graphql;
  const graphqlQuery = graphqlFlag === true ? undefined : getStringFlag(flags, ['graphql']);

  if (graphqlFlag === true && !graphqlQuery) {
    throw new Error('Usage: --graphql <query|@file>');
  }

  if (graphqlQuery && jsonPayloadFlag) {
    throw new Error('Use --variables for GraphQL variables; --json/--data/-d is for JSON bodies.');
  }

  const variablesFlag = getStringFlag(flags, ['variables']);
  const variables = variablesFlag ? resolveJsonInput(variablesFlag) : undefined;

  const jsonBody = typeof jsonPayloadFlag === 'string' ? resolveJsonInput(jsonPayloadFlag) : undefined;
  const graphqlBody = graphqlQuery
    ? {
        query: resolveTextInput(graphqlQuery),
        ...(variables ? { variables } : {}),
      }
    : undefined;

  const body = graphqlBody ?? jsonBody;
  const method = methodInput.toUpperCase();
  const resolvedBaseUrl = resolveApiBaseUrlForRuntime(api.base_url, context.apiUrl);
  const path = resolveApiPath(resolvedBaseUrl, pathInput);

  const tokenOverride = getStringFlag(flags, ['token']);
  const authToken = tokenOverride ?? process.env.EVE_JOB_TOKEN ?? context.token;

  if (printCurl) {
    const curl = buildCurlCommand({
      method,
      url: path,
      authToken,
      jsonBody: body,
      authHint: tokenOverride ? 'override' : (process.env.EVE_JOB_TOKEN ? 'job' : 'user'),
    });
    console.log(curl);
    return;
  }

  const response = await fetch(path, {
    method,
    headers: buildApiHeaders(authToken, body),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const { data, jsonText } = parseResponse(text);

  if (jqExpr) {
    if (!jsonText) {
      throw new Error('Cannot apply --jq to a non-JSON response.');
    }
    const output = runJq(jqExpr, jsonText);
    process.stdout.write(output);
    return;
  }

  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  process.stdout.write(text);
}

function resolveJsonPayloadFlag(
  flags: Record<string, FlagValue>,
  extraPositionals: string[],
): FlagValue | undefined {
  const jsonFlag = flags.json;
  const dataFlag = flags.data;
  const shorthandDataFlag = resolveShorthandDataFlag(extraPositionals);

  const candidates = [jsonFlag, dataFlag, shorthandDataFlag].filter(
    (value): value is FlagValue => value !== undefined,
  );

  if (candidates.length <= 1) {
    return candidates[0];
  }

  const [first, ...rest] = candidates;
  const conflicts = rest.some((value) => value !== first);
  if (conflicts) {
    throw new Error('Use only one JSON body flag: --json, --data, or -d.');
  }

  return first;
}

function resolveShorthandDataFlag(extraPositionals: string[]): FlagValue | undefined {
  for (let i = 0; i < extraPositionals.length; i += 1) {
    const arg = extraPositionals[i];
    if (arg.startsWith('--data=')) {
      return arg.slice('--data='.length);
    }
    if (arg.startsWith('-d=')) {
      return arg.slice('-d='.length);
    }
    if (arg === '--data' || arg === '-d') {
      const next = extraPositionals[i + 1];
      if (!next || next.startsWith('-')) {
        return true;
      }
      return next;
    }
  }
  return undefined;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

  return query ? `?${query}` : '';
}

function resolveEnv(flags: Record<string, FlagValue>): string | undefined {
  return getStringFlag(flags, ['env']) ?? process.env.EVE_ENV_NAME;
}

function formatApiSourcesTable(apis: ApiSource[]): void {
  const nameWidth = Math.max(4, ...apis.map((api) => api.name.length));
  const typeWidth = Math.max(4, ...apis.map((api) => api.type.length));

  console.log(`${'NAME'.padEnd(nameWidth)}  ${'TYPE'.padEnd(typeWidth)}  BASE URL`);
  console.log(`${'-'.repeat(nameWidth)}  ${'-'.repeat(typeWidth)}  --------`);
  apis.forEach((api) => {
    console.log(
      `${api.name.padEnd(nameWidth)}  ${api.type.padEnd(typeWidth)}  ${api.base_url}`,
    );
  });
}

export async function fetchApiSpec(
  context: ResolvedContext,
  projectId: string,
  name: string,
  env?: string,
): Promise<{ data: unknown; raw: string }>
{
  const query = buildQuery({ env });
  const response = await requestJson<{ schema?: unknown } | string>(context, `/projects/${projectId}/apis/${name}/spec${query}`);

  if (response && typeof response === 'object' && 'schema' in response) {
    const schema = response.schema;
    if (typeof schema === 'string') {
      return { data: schema.trim(), raw: schema };
    }
    return { data: schema, raw: JSON.stringify(schema) };
  }

  if (typeof response === 'string') {
    return { data: response.trim(), raw: response };
  }

  return { data: response, raw: JSON.stringify(response) };
}

type OpenApiSpec = {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

type OpenApiOperation = {
  summary?: string;
  description?: string;
  requestBody?: {
    content?: Record<string, { example?: unknown; examples?: Record<string, { value?: unknown }> }>;
  };
};

function buildCurlExamples(api: ApiSource, spec: OpenApiSpec): string[] {
  const paths = spec.paths ?? {};
  const examples: string[] = [];

  Object.entries(paths).forEach(([path, methods]) => {
    Object.entries(methods).forEach(([method, operation]) => {
      const lower = method.toLowerCase();
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(lower)) {
        return;
      }

      const requestBody = operation.requestBody?.content?.['application/json'];
      const examplePayload = extractExamplePayload(requestBody);
      const needsBody = ['post', 'put', 'patch'].includes(lower);

      const curl = buildCurlCommand({
        method: lower.toUpperCase(),
        url: resolveApiPath(api.base_url, path),
        authToken: api.auth_mode === 'eve' ? '$EVE_JOB_TOKEN' : undefined,
        jsonBody: needsBody ? (examplePayload ?? {}) : undefined,
        authHint: 'job',
      });

      const summary = operation.summary ?? operation.description;
      if (summary) {
        examples.push(`# ${summary}`);
      }
      examples.push(curl);
      examples.push('');
    });
  });

  return examples;
}

function extractExamplePayload(
  requestBody: { example?: unknown; examples?: Record<string, { value?: unknown }> } | undefined,
): unknown | undefined {
  if (!requestBody) return undefined;
  if (requestBody.example !== undefined) return requestBody.example;
  const examples = requestBody.examples ? Object.values(requestBody.examples) : [];
  if (examples.length === 0) return undefined;
  return examples[0]?.value;
}

function resolveApiPath(baseUrl: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  if (!baseUrl) {
    return path;
  }
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/**
 * Resolve an API base URL that is reachable from the current runtime.
 *
 * Local user CLI should prefer Ingress URLs.
 * In-cluster jobs (runner/agent-runtime pods) should prefer service DNS URLs.
 */
function resolveApiBaseUrlForRuntime(baseUrl: string, eveApiUrl: string): string {
  if (!baseUrl) return baseUrl;

  const inK8s = Boolean(process.env.KUBERNETES_SERVICE_HOST);

  // In-cluster contexts should stay on service DNS.
  if (inK8s) {
    return rewriteIngressToServiceDns(baseUrl) ?? baseUrl;
  }

  // User/local shells should prefer ingress URLs.
  return rewriteServiceDnsToIngress(baseUrl, eveApiUrl) ?? baseUrl;
}

function rewriteIngressToServiceDns(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.hostname.endsWith('.svc.cluster.local')) {
      return baseUrl;
    }

    // Expected public host pattern: {component}.{org-project-env}.{domain}
    const labels = url.hostname.split('.');
    if (labels.length < 3) {
      return null;
    }

    const component = labels[0];
    const slug = labels[1];
    const slugParts = slug.split('-');
    if (slugParts.length < 3) {
      return null;
    }

    const envName = slugParts[slugParts.length - 1];
    const namespace = `eve-${slug}`;
    const internalHost = `${envName}-${component}.${namespace}.svc.cluster.local`;

    url.hostname = internalHost;
    return stripTrailingSlash(url.toString());
  } catch {
    return null;
  }
}

function rewriteServiceDnsToIngress(baseUrl: string, eveApiUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (!url.hostname.endsWith('.svc.cluster.local')) {
      return null;
    }

    // Expected internal host pattern:
    // {env}-{component}.eve-{org-project-env}.svc.cluster.local
    const labels = url.hostname.split('.');
    if (labels.length < 5) {
      return null;
    }

    const serviceLabel = labels[0]; // e.g. sandbox-api
    const namespace = labels[1]; // e.g. eve-org-project-sandbox
    if (!namespace.startsWith('eve-')) {
      return null;
    }

    const slug = namespace.slice(4); // org-project-env
    const slugParts = slug.split('-');
    if (slugParts.length < 3) {
      return null;
    }

    const envName = slugParts[slugParts.length - 1];
    const envPrefix = `${envName}-`;
    if (!serviceLabel.startsWith(envPrefix)) {
      return null;
    }

    const component = serviceLabel.slice(envPrefix.length);
    if (!component) {
      return null;
    }

    const ingressDomain = inferIngressDomain(eveApiUrl);
    if (!ingressDomain) {
      return null;
    }

    url.hostname = `${component}.${slug}.${ingressDomain}`;
    url.port = '';
    return stripTrailingSlash(url.toString());
  } catch {
    return null;
  }
}

function inferIngressDomain(eveApiUrl: string): string | null {
  try {
    const apiHost = new URL(eveApiUrl).hostname;
    if (apiHost.startsWith('api.eve.')) {
      return apiHost.slice('api.eve.'.length);
    }
    if (apiHost.startsWith('api.')) {
      return apiHost.slice('api.'.length);
    }
    return process.env.EVE_DEFAULT_DOMAIN ?? null;
  } catch {
    return process.env.EVE_DEFAULT_DOMAIN ?? null;
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function resolveRepoRoot(): string {
  let current = process.cwd();
  while (true) {
    if (existsSync(resolvePath(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('Unable to locate repo root (pnpm-workspace.yaml not found).');
}

function runOpenApiExport(repoRoot: string, outputDir: string): void {
  const scriptPath = resolvePath(repoRoot, 'apps/api/dist/scripts/export-openapi.js');
  if (!existsSync(scriptPath)) {
    const build = spawnSync('pnpm', ['-C', resolvePath(repoRoot, 'apps/api'), 'build'], { stdio: 'inherit' });
    if (build.status !== 0) {
      throw new Error('Failed to build API before exporting OpenAPI spec');
    }
  }

  const env = {
    ...process.env,
    OPENAPI_OUT_DIR: outputDir,
    EVE_OPENAPI_EXPORT: '1',
    EVE_AUTH_ENABLED: 'false',
  };

  const result = spawnSync('node', [scriptPath], { stdio: 'inherit', cwd: repoRoot, env });
  if (result.status !== 0) {
    throw new Error('OpenAPI export failed');
  }
}

function buildApiHeaders(authToken: string | undefined, body: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function resolveJsonInput(value: string): unknown {
  const text = resolveTextInput(value);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${(error as Error).message}`);
  }
}

function resolveTextInput(value: string): string {
  if (value.startsWith('@')) {
    const filePath = resolvePath(value.slice(1));
    return readFileSync(filePath, 'utf-8');
  }

  if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
    return value;
  }

  if (existsSync(value)) {
    return readFileSync(resolvePath(value), 'utf-8');
  }

  return value;
}

function parseResponse(text: string): { data: unknown | undefined; jsonText: string | undefined } {
  if (!text) return { data: undefined, jsonText: undefined };
  try {
    const data = JSON.parse(text);
    return { data, jsonText: JSON.stringify(data) };
  } catch {
    return { data: undefined, jsonText: undefined };
  }
}

function runJq(expression: string, jsonText: string): string {
  const result = spawnSync('jq', [expression], {
    input: jsonText,
    encoding: 'utf-8',
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('jq is not installed. Install jq to use --jq output filtering.');
    }
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || 'jq failed to process the response.');
  }

  return result.stdout ?? '';
}

function buildCurlCommand(options: {
  method: string;
  url: string;
  authToken?: string;
  jsonBody?: unknown;
  authHint?: 'job' | 'user' | 'override';
}): string {
  const parts = ['curl', '-sS', '-X', options.method, `'${options.url}'`];
  if (options.authToken) {
    const tokenValue = options.authHint === 'job' ? '$EVE_JOB_TOKEN' : options.authToken;
    parts.push(`-H 'Authorization: Bearer ${tokenValue}'`);
  }
  if (options.jsonBody !== undefined) {
    parts.push("-H 'Content-Type: application/json'");
    parts.push(`-d '${JSON.stringify(options.jsonBody)}'`);
  }
  return parts.join(' ');
}
