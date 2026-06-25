import type { FlagValue } from '../lib/args';
import { toBoolean, getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { loadRepoProfiles, resolveContextForProfile } from '../lib/context';
import { loadCredentials } from '../lib/config';
import { requestJson, requestRaw } from '../lib/client';
import { outputJson } from '../lib/output';
import { runUnifiedSync } from '../lib/sync-project';
import { buildCliImage } from '../lib/cli-image-builder';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export async function handleProject(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'ensure': {
      const name = typeof flags.name === 'string' ? flags.name : '';
      const repoUrl = typeof flags['repo-url'] === 'string' ? flags['repo-url']
        : typeof flags.repo === 'string' ? flags.repo : undefined;
      const branch = typeof flags.branch === 'string' ? flags.branch : 'main';
      const slug = typeof flags.slug === 'string' ? flags.slug : undefined;
      const orgIdRaw = typeof flags.org === 'string' ? flags.org : context.orgId;
      const force = toBoolean(flags.force) ?? false;

      if (!name) {
        throw new Error('Usage: eve project ensure --name <name> [--repo-url <url>] [--branch <branch>] [--slug <slug>]');
      }
      if (!orgIdRaw) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const body: Record<string, unknown> = { org_id: orgIdRaw, name, branch, force };
      if (repoUrl) body.repo_url = repoUrl;
      if (slug) body.slug = slug;
      const project = await requestJson<{ id: string }>(context, '/projects/ensure', {
        method: 'POST',
        body,
      });
      outputJson(project, json, `✓ Project ready: ${project.id} (${name})`);
      return;
    }
    case 'list': {
      const all = Boolean(flags.all);
      const includeDeletedFlag = flags.include_deleted ?? flags['include-deleted'];

      // When --all is set, don't require org context
      const orgId = all
        ? (typeof flags.org === 'string' ? flags.org : undefined)
        : (typeof flags.org === 'string' ? flags.org : context.orgId);

      const query = buildQuery({
        limit: typeof flags.limit === 'string' ? flags.limit : (all ? '50' : undefined),
        offset: typeof flags.offset === 'string' ? flags.offset : undefined,
        include_deleted: toBoolean(includeDeletedFlag) ? 'true' : undefined,
        org_id: orgId,
        name: typeof flags.name === 'string' ? flags.name : undefined,
      });
      const response = await requestJson(context, `/projects${query}`);

      if (json) {
        outputJson(response, json);
      } else if (all) {
        console.log('All projects (admin view):');
        console.log('');
        outputJson(response, json);
      } else {
        outputJson(response, json);
      }
      return;
    }
    case 'get': {
      const projectId = positionals[0];
      if (!projectId) throw new Error('Usage: eve project get <project_id>');
      const includeDeletedFlag = flags.include_deleted ?? flags['include-deleted'];
      const query = buildQuery({
        include_deleted: toBoolean(includeDeletedFlag) ? 'true' : undefined,
      });
      const response = await requestJson(context, `/projects/${projectId}${query}`);
      outputJson(response, json);
      return;
    }
    case 'spend': {
      const projectId = positionals[0] ?? (typeof flags.project === 'string' ? flags.project : context.projectId);
      if (!projectId) {
        throw new Error('Usage: eve project spend <project_id> [--since 7d] [--until <iso>] [--currency usd] [--limit 10] [--json]');
      }

      const sinceRaw = typeof flags.since === 'string' ? flags.since : '7d';
      const untilRaw = typeof flags.until === 'string' ? flags.until : undefined;
      const currency = typeof flags.currency === 'string' ? flags.currency : undefined;
      const limitRaw = typeof flags.limit === 'string' ? flags.limit : undefined;
      const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

      const query = buildQuery({
        since: sinceRaw ? parseSinceValue(sinceRaw) : undefined,
        until: untilRaw ? parseSinceValue(untilRaw) : undefined,
        currency,
        limit,
      });

      const response = await requestJson<any>(context, `/projects/${projectId}/spend${query}`);
      if (json) {
        outputJson(response, json);
        return;
      }

      console.log(`Project spend: ${response.project_id ?? projectId}`);
      const summary = response.summary ?? {};
      console.log(`  Window: ${summary.since ?? 'all-time'} → ${summary.until ?? 'now'}`);
      console.log(`  Attempts: ${summary.attempts ?? 0}`);
      console.log(`  Base total (usd): ${summary.base_total_usd ?? '0'}`);
      console.log(`  Billed total (${summary.billed_currency ?? currency ?? 'usd'}): ${summary.billed_total ?? '0'}`);

      const top = Array.isArray(response.top_jobs) ? response.top_jobs : [];
      if (top.length > 0) {
        console.log('\nTop jobs:');
        for (const job of top) {
          console.log(`  ${job.job_id}  base_usd=${job.base_total_usd}  billed_${job.billed_currency}=${job.billed_total}  attempts=${job.attempts}  ${job.title}`);
        }
      }
      return;
    }
    case 'update': {
      const projectId = positionals[0];
      if (!projectId) {
        throw new Error('Usage: eve project update <project_id> [--name <name>] [--repo-url <url>]');
      }
      const body: Record<string, unknown> = {};
      if (typeof flags.name === 'string') body.name = flags.name;
      if (typeof flags['repo-url'] === 'string') body.repo_url = flags['repo-url'];
      else if (typeof flags.repo === 'string') body.repo_url = flags.repo;
      if (typeof flags.branch === 'string') body.branch = flags.branch;
      const deleted = toBoolean(flags.deleted);
      if (deleted !== undefined) body.deleted = deleted;
      const response = await requestJson(context, `/projects/${projectId}`, { method: 'PATCH', body });
      outputJson(response, json);
      return;
    }
    case 'sync': {
      await runUnifiedSync(flags, context);
      return;
    }
    case 'image': {
      await handleImage(positionals, flags, context, json);
      return;
    }
    case 'members': {
      const action = positionals[0]; // list | add | remove
      const projectId = typeof flags.project === 'string' ? flags.project : context.projectId;
      if (!projectId) {
        throw new Error('Missing project id. Provide --project or set a profile default.');
      }

      switch (action) {
        case 'add': {
          const email = getStringFlag(flags, ['email']) ?? positionals[1];
          const role = getStringFlag(flags, ['role']) ?? 'member';
          if (!email) {
            throw new Error('Usage: eve project members add <email> [--role member|admin|owner]');
          }
          const response = await requestJson(context, `/projects/${projectId}/members`, {
            method: 'POST',
            body: { email, role },
          });
          outputJson(response, json, `✓ Member added to project ${projectId}`);
          return;
        }
        case 'remove': {
          const userId = positionals[1];
          if (!userId) {
            throw new Error('Usage: eve project members remove <user_id>');
          }
          await requestRaw(context, `/projects/${projectId}/members/${userId}`, { method: 'DELETE' });
          outputJson({ project_id: projectId, user_id: userId, removed: true }, json, `✓ Member ${userId} removed from project ${projectId}`);
          return;
        }
        case 'list':
        default: {
          const response = await requestJson(context, `/projects/${projectId}/members`);
          outputJson(response, json);
          return;
        }
      }
    }
    case 'bootstrap': {
      const name = typeof flags.name === 'string' ? flags.name : '';
      const repoUrl = typeof flags['repo-url'] === 'string' ? flags['repo-url'] : '';
      const branch = typeof flags.branch === 'string' ? flags.branch : 'main';
      const slug = typeof flags.slug === 'string' ? flags.slug : undefined;
      const orgIdRaw = typeof flags.org === 'string' ? flags.org : context.orgId;
      const description = typeof flags.description === 'string' ? flags.description : undefined;
      const template = typeof flags.template === 'string' ? flags.template : undefined;
      const packsRaw = typeof flags.packs === 'string' ? flags.packs : undefined;
      const envsRaw = typeof flags.environments === 'string' ? flags.environments : undefined;

      if (!name || !repoUrl) {
        throw new Error(
          'Usage: eve project bootstrap --name <name> --repo-url <url> [--branch main] [--slug <slug>] [--environments staging,production] [--packs pack1,pack2] [--template eve-starter]',
        );
      }
      if (!orgIdRaw) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const body: Record<string, unknown> = {
        org_id: orgIdRaw,
        name,
        repo_url: repoUrl,
        branch,
      };
      if (slug) body.slug = slug;
      if (description) body.description = description;
      if (template) body.template = template;
      if (packsRaw) body.packs = packsRaw.split(',').map((p) => p.trim());
      if (envsRaw) body.environments = envsRaw.split(',').map((e) => e.trim());

      const result = await requestJson<{
        project: { id: string; name: string };
        environments: Array<{ id: string; name: string }>;
        status: string;
        next_steps: string[];
      }>(context, '/projects/bootstrap', { method: 'POST', body });

      if (json) {
        outputJson(result, json);
      } else {
        const verb = result.status === 'created' ? 'Created' : 'Found existing';
        console.log(`✓ ${verb} project: ${result.project.id} (${result.project.name})`);
        if (result.environments.length > 0) {
          console.log(`  Environments: ${result.environments.map((e) => e.name).join(', ')}`);
        }
        console.log('\nNext steps:');
        result.next_steps.forEach((step) => console.log(`  → ${step}`));
      }
      return;
    }
    case 'delete': {
      const projectId = positionals[0] ?? (typeof flags.project === 'string' ? flags.project : context.projectId);
      if (!projectId) {
        throw new Error('Usage: eve project delete <project_id> [--hard] [--force]');
      }
      const hard = toBoolean(flags.hard) ?? false;
      const force = toBoolean(flags.force) ?? false;
      const query = buildQuery({ hard: hard ? 'true' : undefined, force: force ? 'true' : undefined });
      await requestRaw(context, `/projects/${projectId}${query}`, { method: 'DELETE' });
      const mode = hard ? 'hard-deleted' : 'soft-deleted';
      outputJson({ project_id: projectId, deleted: true, mode }, json, `✓ Project ${projectId} ${mode}`);
      return;
    }

    case 'status':
      return handleStatus(flags, context, json);

    case 'auth-context': {
      const projectId = positionals[0]
        ?? (typeof flags.project === 'string' ? flags.project : context.projectId);
      if (!projectId) {
        throw new Error('Usage: eve project auth-context <project_id>');
      }
      const query = `?project_id=${encodeURIComponent(projectId)}`;

      type AdminOrgAccess = {
        mode: string;
        multi_org: boolean;
        invite_enabled: boolean;
        domain_signup_enabled?: boolean;
        allowed_orgs?: string[];
        domain_signup?: {
          enabled: boolean;
          domains: Array<{ domain: string; target_org: string; role: 'member' }>;
        };
      };

      type AdminResponse = {
        project_id: string;
        org_id: string;
        branding: Record<string, unknown> | null;
        auth: {
          login_method?: string;
          self_signup?: boolean;
          invite_requires_password?: boolean;
          org_access?: AdminOrgAccess;
          allowed_redirect_origins?: string[];
        } | null;
      };

      // Try the authenticated admin endpoint first — surfaces the resolved
      // domain_signup block. Fall back to the public endpoint if the caller
      // isn't a project admin.
      let response: AdminResponse;
      let isAdminPayload = false;
      try {
        response = await requestJson<AdminResponse>(context, `/auth/app-context/admin${query}`);
        isAdminPayload = true;
      } catch {
        response = await requestJson<AdminResponse>(context, `/auth/app-context${query}`);
      }

      if (json) {
        outputJson(response, json);
        return;
      }

      console.log(`Project:           ${response.project_id}`);
      console.log(`Org:               ${response.org_id}`);
      if (response.auth) {
        console.log(`Login method:      ${response.auth.login_method ?? 'password_or_magic_link'}`);
        console.log(`Self signup:       ${response.auth.self_signup ? 'yes' : 'no'}`);
        console.log(`Invite needs pw:   ${response.auth.invite_requires_password ? 'yes' : 'no'}`);
        const orgAccess = response.auth.org_access;
        if (orgAccess) {
          console.log(`Org access mode:   ${orgAccess.mode}`);
          console.log(`Multi-org:         ${orgAccess.multi_org ? 'yes' : 'no'}`);
          console.log(`Invite enabled:    ${orgAccess.invite_enabled ? 'yes' : 'no'}`);
          if (isAdminPayload && orgAccess.allowed_orgs && orgAccess.allowed_orgs.length > 0) {
            console.log(`Allowed orgs:      ${orgAccess.allowed_orgs.join(', ')}`);
          }
        }
        const origins = response.auth.allowed_redirect_origins ?? [];
        console.log('');
        console.log(`Allowed redirect origins (${origins.length}):`);
        if (origins.length === 0) {
          console.log('  (none — only cluster-domain subdomains are accepted)');
        } else {
          for (const origin of origins) {
            console.log(`  - ${origin}`);
          }
        }
        const ds = orgAccess?.domain_signup;
        const dsBool = orgAccess?.domain_signup_enabled ?? ds?.enabled ?? false;
        console.log('');
        if (isAdminPayload && ds) {
          console.log(`Domain signup:`);
          console.log(`  enabled:     ${ds.enabled ? 'yes' : 'no'}`);
          if (ds.enabled) {
            if (ds.domains.length === 0) {
              console.log(`  rules:       (none)`);
            } else {
              console.log(`  rules (first-match wins):`);
              const padDomain = Math.max(...ds.domains.map((rule) => rule.domain.length));
              for (const rule of ds.domains) {
                console.log(
                  `    - ${rule.domain.padEnd(padDomain)}  ->  ${rule.target_org}  (${rule.role})`,
                );
              }
            }
          }
        } else if (dsBool) {
          console.log(`Domain signup: enabled (details hidden — requires project admin)`);
        }
      } else {
        console.log('No auth config set for this project.');
      }
      return;
    }

    default:
      throw new Error('Usage: eve project <ensure|list|get|spend|update|delete|sync|image|members|bootstrap|status|auth-context>');
  }
}

async function handleImage(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const action = positionals[0];
  switch (action) {
    case 'build-cli': {
      const repoDir = resolve(getStringFlag(flags, ['repo-dir', 'repo_dir', 'dir']) ?? process.cwd());
      const projectSlug = await resolveProjectSlugForImage(positionals[1], flags, context, repoDir);
      const result = buildCliImage({
        projectSlug,
        repoDir,
        dockerfile: getStringFlag(flags, ['dockerfile']),
        tag: getStringFlag(flags, ['tag']),
        importToK3d: toBoolean(flags['import-to-k3d']) ?? toBoolean(flags.import_to_k3d) ?? false,
        quiet: json,
      });
      outputJson(result, json, `✓ Built CLI image ${result.image}${result.imported ? ' and imported it into k3d' : ''}`);
      return;
    }
    default:
      throw new Error('Usage: eve project image build-cli [project-slug|project-id] [--repo-dir <path>] [--dockerfile <path>] [--tag <image>] [--import-to-k3d]');
  }
}

async function resolveProjectSlugForImage(
  positionalProject: string | undefined,
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  repoDir: string,
): Promise<string> {
  const projectRef = getStringFlag(flags, ['project']) ?? positionalProject ?? context.projectId;
  if (projectRef?.startsWith('proj_')) {
    const project = await requestJson<{ slug?: string }>(context, `/projects/${projectRef}`);
    if (!project.slug) {
      throw new Error(`Project ${projectRef} did not include a slug in the API response.`);
    }
    return project.slug;
  }
  if (projectRef) return projectRef;

  const manifestPath = join(repoDir, '.eve', 'manifest.yaml');
  if (existsSync(manifestPath)) {
    const parsed = parseYaml(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown> | null;
    const manifestProject = typeof parsed?.project === 'string' ? parsed.project
      : typeof parsed?.name === 'string' ? parsed.name
        : undefined;
    if (manifestProject) return manifestProject;
  }

  throw new Error('Missing project slug. Provide a positional project, --project <slug>, or a manifest name/project.');
}

// ============================================================================
// Project Status
// ============================================================================

interface StatusServiceInfo {
  name: string;
  pods_ready: number;
  pods_total: number;
  status: string;
  url: string | null;
  alias_urls?: string[];
}

interface StatusReleaseInfo {
  git_sha: string;
  version: string | null;
  tag: string | null;
  deployed_at: string;
  created_by: string | null;
}

interface StatusEnvInfo {
  name: string;
  type: string;
  status: string;
  namespace: string | null;
  release: StatusReleaseInfo | null;
  services: StatusServiceInfo[];
}

interface StatusProfileResult {
  name: string;
  active: boolean;
  api_url: string;
  project_id?: string;
  project_name?: string;
  environments?: StatusEnvInfo[];
  error?: string;
}

/**
 * eve project status [--profile <name>] [--env <name>]
 * Show deployment status across all profiles with service URLs.
 */
async function handleStatus(
  flags: Record<string, FlagValue>,
  currentContext: ResolvedContext,
  json: boolean,
): Promise<void> {
  const repoProfiles = loadRepoProfiles();
  const credentials = loadCredentials();
  const profileFilter = getStringFlag(flags, ['profile']);
  const envFilter = getStringFlag(flags, ['env']);

  const profileEntries = Object.entries(repoProfiles.profiles);

  if (profileEntries.length === 0) {
    throw new Error(
      'No profiles configured. Use `eve profile create <name> --api-url <url> --project <id>` to add one.',
    );
  }

  const results: StatusProfileResult[] = [];

  for (const [name, profile] of profileEntries) {
    if (profileFilter && name !== profileFilter) continue;

    const active = name === repoProfiles.activeProfile;
    const ctx = resolveContextForProfile(name, profile, credentials);

    if (!ctx.projectId) {
      results.push({ name, active, api_url: ctx.apiUrl, error: 'No project_id configured' });
      continue;
    }

    if (!ctx.token) {
      results.push({
        name,
        active,
        api_url: ctx.apiUrl,
        project_id: ctx.projectId,
        error: 'Not authenticated (run: eve auth login --profile ' + name + ')',
      });
      continue;
    }

    try {
      const result = await fetchProfileStatus(ctx, envFilter);
      results.push({ name, active, ...result });
    } catch (err) {
      results.push({
        name,
        active,
        api_url: ctx.apiUrl,
        project_id: ctx.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (json) {
    outputJson({ profiles: results }, json);
    return;
  }

  formatStatusOutput(results);
}

async function fetchProfileStatus(
  ctx: ResolvedContext,
  envFilter?: string,
): Promise<Omit<StatusProfileResult, 'name' | 'active'>> {
  // Fetch project info and releases in parallel
  const [project, releasesResponse] = await Promise.all([
    requestJson<{
      id: string;
      name: string;
      slug: string;
      org_id: string;
    }>(ctx, `/projects/${ctx.projectId}`),
    requestJson<{
      data: Array<{
        id: string;
        git_sha: string;
        version: string | null;
        tag: string | null;
        created_by: string | null;
        created_at: string;
      }>;
    }>(ctx, `/projects/${ctx.projectId}/releases?limit=50`).catch(() => ({ data: [] })),
  ]);

  // Index releases by ID for fast lookup
  const releasesById = new Map(releasesResponse.data.map((r) => [r.id, r]));

  // Fetch environments
  const envResponse = await requestJson<{
    data: Array<{
      id: string;
      name: string;
      type: string;
      namespace: string | null;
      status?: string;
      suspended_at?: string | null;
      current_release_id?: string | null;
      ingress_aliases?: Array<{
        alias: string;
        service_name: string;
      }>;
    }>;
  }>(ctx, `/projects/${ctx.projectId}/envs?limit=50`);

  const domain = inferDomain(ctx.apiUrl);
  const environments: StatusEnvInfo[] = [];

  for (const env of envResponse.data) {
    if (envFilter && env.name !== envFilter) continue;

    const status = env.suspended_at ? 'suspended' : 'active';

    // Resolve release info
    let release: StatusReleaseInfo | null = null;
    if (env.current_release_id) {
      const r = releasesById.get(env.current_release_id);
      if (r) {
        release = {
          git_sha: r.git_sha,
          version: r.version,
          tag: r.tag,
          deployed_at: r.created_at,
          created_by: r.created_by,
        };
      }
    }

    // Skip suspended envs — no services to query
    if (env.suspended_at) {
      environments.push({
        name: env.name,
        type: env.type,
        status,
        namespace: env.namespace,
        release,
        services: [],
      });
      continue;
    }

    // Fetch service diagnostics (best-effort)
    let services: StatusServiceInfo[] = [];
    try {
      const diagnose = await requestJson<{
        namespace: string | null;
        pods: Array<{
          name: string;
          phase: string;
          ready: boolean;
          restarts: number;
          labels: Record<string, string>;
        }>;
      }>(ctx, `/projects/${ctx.projectId}/envs/${env.name}/diagnose`);

      services = buildStatusServices(
        diagnose.pods,
        diagnose.namespace ?? env.namespace,
        domain,
        env.ingress_aliases ?? [],
      );
    } catch {
      // k8s might be unavailable — continue without service details
    }

    environments.push({
      name: env.name,
      type: env.type,
      status,
      namespace: env.namespace,
      release,
      services,
    });
  }

  return {
    api_url: ctx.apiUrl,
    project_id: project.id,
    project_name: project.name,
    environments,
  };
}

/**
 * Build service summaries from pods, inferring external URLs.
 */
function buildStatusServices(
  pods: Array<{
    name: string;
    phase: string;
    ready: boolean;
    labels: Record<string, string>;
  }>,
  namespace: string | null,
  domain: string | null,
  ingressAliases: Array<{ alias: string; service_name: string }>,
): StatusServiceInfo[] {
  const services = new Map<string, { ready: number; total: number; phases: Set<string> }>();

  for (const pod of pods) {
    const component =
      pod.labels['eve.component'] ||
      pod.labels['app.kubernetes.io/name'] ||
      pod.labels['app'] ||
      pod.labels['component'] ||
      'unknown';

    const existing = services.get(component) ?? { ready: 0, total: 0, phases: new Set() };
    existing.total += 1;
    if (pod.ready) existing.ready += 1;
    existing.phases.add(pod.phase);
    services.set(component, existing);
  }

  return Array.from(services.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, info]) => {
      // Skip completed jobs (migrate pods, etc.)
      const allDone = info.phases.size > 0 && [...info.phases].every((p) => p === 'Succeeded' || p === 'Failed');
      const status = allDone
        ? 'completed'
        : info.ready === info.total
          ? 'ready'
          : 'not-ready';

      const url = !allDone && namespace && domain
        ? buildServiceUrl(name, namespace, domain)
        : null;
      const aliasUrls = !allDone && domain
        ? ingressAliases
          .filter((entry) => entry.service_name === name)
          .map((entry) => buildAliasUrl(entry.alias, domain))
          .sort((a, b) => a.localeCompare(b))
        : [];

      return {
        name,
        pods_ready: info.ready,
        pods_total: info.total,
        status,
        url,
        alias_urls: aliasUrls,
      };
    });
}

/**
 * Infer the cluster ingress domain from the Eve API URL.
 *
 * api.eve.lvh.me → lvh.me
 * api.eve.example.com → eve.example.com
 */
function inferDomain(apiUrl: string): string | null {
  try {
    const host = new URL(apiUrl).hostname;
    if (host.startsWith('api.eve.')) return host.slice('api.eve.'.length);
    if (host.startsWith('api.')) return host.slice('api.'.length);
    return null;
  } catch {
    return null;
  }
}

/**
 * Build an external ingress URL for a service.
 *
 * Namespace: eve-{orgSlug}-{projectSlug}-{envName}
 * URL: {proto}://{component}.{orgSlug}-{projectSlug}-{envName}.{domain}
 */
function buildServiceUrl(component: string, namespace: string, domain: string): string {
  const slug = namespace.startsWith('eve-') ? namespace.slice(4) : namespace;
  const secure = !domain.includes('lvh.me') && !domain.includes('localhost');
  return `${secure ? 'https' : 'http'}://${component}.${slug}.${domain}`;
}

function buildAliasUrl(alias: string, domain: string): string {
  const secure = !domain.includes('lvh.me') && !domain.includes('localhost');
  return `${secure ? 'https' : 'http'}://${alias}.${domain}`;
}

/**
 * Format status output for human consumption.
 */
function formatStatusOutput(results: StatusProfileResult[]): void {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (i > 0) console.log('');

    const marker = r.active ? ' (active)' : '';
    console.log(`${r.name}${marker}  ${r.api_url}`);

    if (r.error) {
      console.log(`  error: ${r.error}`);
      continue;
    }

    const label = r.project_name ? `${r.project_id} (${r.project_name})` : r.project_id;
    console.log(`  project: ${label}`);

    if (!r.environments || r.environments.length === 0) {
      console.log('  (no environments)');
      continue;
    }

    for (const env of r.environments) {
      console.log('');
      console.log(`  ${env.name}  ${env.status}  ${env.type}`);

      if (env.release) {
        const sha = env.release.git_sha.substring(0, 8);
        const age = formatAge(env.release.deployed_at);
        const ver = env.release.tag ?? env.release.version ?? '';
        const verPart = ver ? `  ${ver}` : '';
        console.log(`    revision: ${sha}${verPart}  deployed ${age}`);
      }

      if (env.services.length === 0) {
        if (env.status === 'suspended') {
          console.log('    (suspended)');
        } else {
          console.log('    (no services)');
        }
        continue;
      }

      // Compute column widths
      const nameW = Math.max(...env.services.map((s) => s.name.length));
      const podsW = Math.max(...env.services.map((s) => `${s.pods_ready}/${s.pods_total}`.length));

      for (const svc of env.services) {
        const pods = `${svc.pods_ready}/${svc.pods_total}`;
        const urls: string[] = [];
        if (svc.url) {
          urls.push(svc.url);
        }
        for (const aliasUrl of svc.alias_urls ?? []) {
          if (!urls.includes(aliasUrl)) {
            urls.push(aliasUrl);
          }
        }
        const urlPart = urls.length > 0 ? `  ${urls[0]}` : '';
        console.log(
          `    ${padRight(svc.name, nameW)}  ${padRight(pods, podsW)}  ${padRight(svc.status, 9)}${urlPart}`,
        );
        if (urls.length > 1) {
          const prefix = `    ${padRight('', nameW)}  ${padRight('', podsW)}  ${padRight('', 9)}`;
          for (const aliasUrl of urls.slice(1)) {
            console.log(`${prefix}  ${aliasUrl}`);
          }
        }
      }
    }
  }
}

function parseSinceValue(since: string): string {
  // If it looks like an ISO date, return as-is
  if (since.includes('T') || since.includes('-')) {
    return since;
  }

  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid time format: "${since}". Use formats like "10m", "2h", "7d", or ISO timestamp.`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const now = new Date();
  switch (unit) {
    case 's':
      now.setSeconds(now.getSeconds() - value);
      break;
    case 'm':
      now.setMinutes(now.getMinutes() - value);
      break;
    case 'h':
      now.setHours(now.getHours() - value);
      break;
    case 'd':
      now.setDate(now.getDate() - value);
      break;
  }

  return now.toISOString();
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 0) return 'just now';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}
