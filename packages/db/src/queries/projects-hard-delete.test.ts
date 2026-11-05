/**
 * Project hard delete against a migrated database: one DELETE must remove
 * everything the project owns (see migration 00108) and leave other projects
 * alone. Also covers org-wide agent lookups ignoring soft-deleted projects.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { projectQueries } from './projects.js';
import { agentQueries } from './agents.js';
import { teamQueries } from './teams.js';
import type { Db } from '../client.js';

const testDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!testDbUrl) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL environment variable is required for tests');
}

const suffix = Math.random().toString(36).slice(2, 8);
const orgId = `org_hd${suffix}`;
const doomed = `proj_hd${suffix}`;
const bystander = `proj_hk${suffix}`;

/** Every table the seed writes, with the predicate that finds the doomed project's rows. */
const doomedRows: Array<[table: string, where: string]> = [
  ['projects', `id = '${doomed}'`],
  ['environments', `project_id = '${doomed}'`],
  ['events', `project_id = '${doomed}'`],
  ['managed_db_tenants', `project_id = '${doomed}'`],
  ['managed_db_snapshots', `project_id = '${doomed}'`],
  ['build_specs', `project_id = '${doomed}'`],
  ['build_runs', `id = 'brun_${doomed}'`],
  ['build_artifacts', `id = 'bart_${doomed}'`],
  ['build_logs', `build_run_id = 'brun_${doomed}'`],
  ['releases', `project_id = '${doomed}'`],
  ['pipeline_runs', `project_id = '${doomed}'`],
  ['pipeline_step_runs', `id = 'step_${doomed}'`],
  ['jobs', `project_id = '${doomed}'`],
  ['job_attempts', `job_id = 'job-${doomed}'`],
  ['execution_logs', `step_run_id = 'step_${doomed}' OR content->>'tag' = 'attempt-${doomed}'`],
  ['webhook_subscriptions', `project_id = '${doomed}'`],
  ['webhook_replays', `project_id = '${doomed}'`],
  ['agents', `project_id = '${doomed}'`],
];

async function seedProject(db: Db, projectId: string, slug: string): Promise<void> {
  const envId = `env_${projectId}`;
  const instanceId = `mdbi_${projectId}`;
  const tenantId = `mdbt_${projectId}`;
  const buildId = `build_${projectId}`;
  const runId = `prun_${projectId}`;
  const jobId = `job-${projectId}`;

  await db`INSERT INTO projects (id, org_id, name, slug, repo_url)
           VALUES (${projectId}, ${orgId}, ${projectId}, ${slug}, 'https://example.com/repo.git')`;
  await db`INSERT INTO environments (id, project_id, name, type)
           VALUES (${envId}, ${projectId}, 'staging', 'persistent')`;
  await db`INSERT INTO events (id, project_id, type, source)
           VALUES (${`evt_${projectId}`}, ${projectId}, 'test.event', 'test')`;

  // A destroyed managed DB tenant (deleted_at set) with a snapshot that references
  // the project, its environment and the tenant.
  await db`INSERT INTO managed_db_instances (id, provider, provider_instance_id, region, engine_version, host, instance_class)
           VALUES (${instanceId}, 'local', ${instanceId}, 'local', '16', 'localhost', 'db.test')`;
  await db`INSERT INTO managed_db_tenants (id, org_id, project_id, env_id, service_name, instance_id, db_name, db_user, class, deleted_at)
           VALUES (${tenantId}, ${orgId}, ${projectId}, ${envId}, 'db', ${instanceId}, ${`db_${projectId}`}, ${`u_${projectId}`}, 'db.p1', NOW())`;
  await db`INSERT INTO managed_db_snapshots (id, tenant_id, org_id, project_id, env_id, instance_id, trigger)
           VALUES (${`mdbs_${projectId}`}, ${tenantId}, ${orgId}, ${projectId}, ${envId}, ${instanceId}, 'manual')`;

  // Build chain: spec -> run -> logs, spec -> artifact, spec <- release.
  await db`INSERT INTO build_specs (id, project_id, git_sha, manifest_hash)
           VALUES (${buildId}, ${projectId}, 'abc123', 'hash')`;
  await db`INSERT INTO build_runs (id, build_id, status, backend)
           VALUES (${`brun_${projectId}`}, ${buildId}, 'succeeded', 'buildkit')`;
  await db`INSERT INTO build_artifacts (id, build_id, service_name, image_ref, digest)
           VALUES (${`bart_${projectId}`}, ${buildId}, 'web', 'registry/web:abc', 'sha256:0')`;
  await db`INSERT INTO build_logs (build_run_id, seq, type, content)
           VALUES (${`brun_${projectId}`}, 1, 'log', ${db.json({ line: 'built' })})`;
  await db`INSERT INTO releases (id, project_id, git_sha, manifest_hash, build_id)
           VALUES (${`rel_${projectId}`}, ${projectId}, 'abc123', 'hash', ${buildId})`;

  // Pipeline chain: run -> step run -> execution logs; a job in the run with an attempt and its logs.
  await db`INSERT INTO pipeline_runs (id, project_id, pipeline_name)
           VALUES (${runId}, ${projectId}, 'deploy')`;
  await db`INSERT INTO pipeline_step_runs (id, pipeline_run_id, step_index, step_name, step_type)
           VALUES (${`step_${projectId}`}, ${runId}, 0, 'build', 'action')`;
  await db`INSERT INTO execution_logs (step_run_id, seq, type, content)
           VALUES (${`step_${projectId}`}, 1, 'log', ${db.json({ tag: `step-${projectId}` })})`;
  await db`INSERT INTO jobs (id, project_id, title, description, run_id)
           VALUES (${jobId}, ${projectId}, 'job', 'job', ${runId})`;
  const [attempt] = await db<{ id: string }[]>`
    INSERT INTO job_attempts (job_id, attempt_number) VALUES (${jobId}, 1) RETURNING id`;
  await db`INSERT INTO execution_logs (attempt_id, seq, type, content)
           VALUES (${attempt.id}, 1, 'log', ${db.json({ tag: `attempt-${projectId}` })})`;

  // Billing history referencing the project and its environment.
  await db`INSERT INTO usage_records (id, org_id, project_id, env_id, resource_type, quantity, unit, started_at, source_type, source_id)
           VALUES (${`use_${projectId}`}, ${orgId}, ${projectId}, ${envId}, 'compute', 1, 'hour', NOW(), 'test', ${projectId})`;

  // Project-scoped webhook subscription with a replay.
  const [sub] = await db<{ id: string }[]>`
    INSERT INTO webhook_subscriptions (org_id, project_id, url, events, secret)
    VALUES (${orgId}, ${projectId}, 'https://hooks.example.com', ${['*']}, 'secret')
    RETURNING id`;
  await db`INSERT INTO webhook_replays (subscription_id, org_id, project_id)
           VALUES (${sub.id}, ${orgId}, ${projectId})`;

  await db`INSERT INTO agents (project_id, id, slug) VALUES (${projectId}, 'helper', ${`helper-${projectId.slice(-8)}`})`;
}

async function countRows(db: Db, table: string, where: string): Promise<number> {
  const [row] = await db.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return row.n;
}

describe('projectQueries.hardDelete', () => {
  let db: Db;
  let orgWideSubId: string;

  beforeAll(async () => {
    db = postgres(testDbUrl) as unknown as Db;
    await db`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, ${orgId}, ${`hd${suffix}`})`;
    await seedProject(db, doomed, `Hd${suffix}`);
    await seedProject(db, bystander, `Hk${suffix}`);
    // An org-wide subscription whose replay is filtered to the doomed project.
    const [sub] = await db<{ id: string }[]>`
      INSERT INTO webhook_subscriptions (org_id, project_id, url, events, secret)
      VALUES (${orgId}, NULL, 'https://hooks.example.com/org', ${['*']}, 'secret')
      RETURNING id`;
    orgWideSubId = sub.id;
    await db`INSERT INTO webhook_replays (subscription_id, org_id, project_id)
             VALUES (${orgWideSubId}, ${orgId}, ${doomed})`;
  });

  afterAll(async () => {
    await projectQueries(db).hardDelete(bystander).catch(() => undefined);
    await db`DELETE FROM webhook_subscriptions WHERE org_id = ${orgId}`;
    await db`DELETE FROM usage_records WHERE org_id = ${orgId}`;
    await db`DELETE FROM managed_db_instances WHERE id IN (${`mdbi_${doomed}`}, ${`mdbi_${bystander}`})`;
    await db`DELETE FROM orgs WHERE id = ${orgId}`;
    await db.end();
  });

  it('removes every row the project owns in one call', async () => {
    for (const [table, where] of doomedRows) {
      expect(await countRows(db, table, where), `${table} seeded`).toBeGreaterThan(0);
    }

    await expect(projectQueries(db).hardDelete(doomed)).resolves.toBe(true);

    for (const [table, where] of doomedRows) {
      expect(await countRows(db, table, where), `${table} after delete`).toBe(0);
    }
  });

  it('keeps billing history and org-wide subscriptions, detached from the project', async () => {
    expect(await countRows(db, 'usage_records', `id = 'use_${doomed}' AND project_id IS NULL AND env_id IS NULL`)).toBe(1);
    expect(await countRows(db, 'webhook_subscriptions', `id = '${orgWideSubId}'`)).toBe(1);
  });

  it('leaves other projects in the org untouched', async () => {
    const bystanderRows = doomedRows.map(([table, where]) => [table, where.split(doomed).join(bystander)] as const);
    for (const [table, where] of bystanderRows) {
      expect(await countRows(db, table, where), `${table} of bystander`).toBeGreaterThan(0);
    }
  });

  it('returns false for an unknown project', async () => {
    await expect(projectQueries(db).hardDelete(`proj_missing${suffix}`)).resolves.toBe(false);
  });
});

describe('agentQueries org-wide lookups', () => {
  let db: Db;
  const live = `proj_al${suffix}`;
  const deleted = `proj_ad${suffix}`;
  const lookupOrg = `org_al${suffix}`;

  beforeAll(async () => {
    db = postgres(testDbUrl) as unknown as Db;
    await db`INSERT INTO orgs (id, name, slug) VALUES (${lookupOrg}, ${lookupOrg}, ${`al${suffix}`})`;
    await db`INSERT INTO projects (id, org_id, name, slug, repo_url, deleted_at)
             VALUES (${live}, ${lookupOrg}, ${live}, ${`Al${suffix}`}, 'https://example.com/a.git', NULL),
                    (${deleted}, ${lookupOrg}, ${deleted}, ${`Ad${suffix}`}, 'https://example.com/b.git', NOW())`;
    await db`INSERT INTO agents (project_id, id, slug, alias)
             VALUES (${live}, 'live', 'live-agent', 'live-alias'),
                    (${deleted}, 'gone', 'gone-agent', 'gone-alias')`;
    await db`INSERT INTO teams (project_id, id) VALUES (${deleted}, 'gone-team')`;
  });

  afterAll(async () => {
    await db`DELETE FROM projects WHERE org_id = ${lookupOrg}`;
    await db`DELETE FROM orgs WHERE id = ${lookupOrg}`;
    await db.end();
  });

  it('does not let a soft-deleted project reserve agent slugs or aliases', async () => {
    const agents = agentQueries(db);
    const bySlug = await agents.listByOrgAndSlugs(lookupOrg, ['live-agent', 'gone-agent']);
    expect(bySlug.map((a) => a.slug)).toEqual(['live-agent']);
    expect(await agents.findByOrgAndSlug(lookupOrg, 'gone-agent')).toBeNull();
    expect((await agents.findByOrgAndSlug(lookupOrg, 'live-agent'))?.project_id).toBe(live);

    const byAlias = await agents.listByOrgAndAliases(lookupOrg, ['live-alias', 'gone-alias']);
    expect(byAlias.map((a) => a.alias)).toEqual(['live-alias']);
    expect(await agents.findByOrgAndAlias(lookupOrg, 'gone-alias')).toBeNull();
  });

  it('does not route to teams of a soft-deleted project', async () => {
    expect(await teamQueries(db).findByOrgAndId(lookupOrg, 'gone-team')).toBeNull();
  });

  it('hides soft-deleted projects from the org agent directory', async () => {
    const directory = await agentQueries(db).listDirectoryByOrg(lookupOrg);
    expect(directory.map((entry) => entry.project_id)).toEqual([live]);
  });
});
