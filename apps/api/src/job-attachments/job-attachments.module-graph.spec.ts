import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Builds the real Nest module graph for job attachments and checks that an
 * attachment change by someone other than the job's actor is judged at
 * runtime, not only when a test constructs the service by hand.
 *
 * Nest resolves constructor dependencies from TypeScript's emitted decorator
 * metadata, which vitest's transform does not produce, so this test loads the
 * compiled modules from apps/api/dist (`pnpm build` runs before `pnpm test`).
 */
const apiRoot = path.resolve(__dirname, '../..');
const distRoot = path.join(apiRoot, 'dist');
const requireDist = createRequire(path.join(distRoot, 'main.js'));

/** DB stand-in: user_mate is a plain member of org_a; job a-1 in proj_a runs as user_owner. */
const JOB = {
  id: 'a-1',
  project_id: 'proj_a',
  phase: 'backlog',
  actor_user_id: 'user_owner',
  user_secrets_excluded: false,
  token_permissions: ['jobs:read', 'secrets:write'],
  token_scope: null,
};
const fakeDb = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM jobs WHERE id/.test(sql) && values[0] === 'a-1') {
      return [JOB];
    }
    if (/FROM org_memberships/.test(sql) && values[0] === 'user_mate' && values[1] === 'org_a') {
      return [{ user_id: 'user_mate', org_id: 'org_a', role: 'member' }];
    }
    if (/FROM projects WHERE id/.test(sql) && values[0] === 'proj_a') {
      return [{ id: 'proj_a', org_id: 'org_a', slug: 'a', name: 'a' }];
    }
    return [];
  },
  { json: (v: unknown) => v, begin: async (fn: (tx: unknown) => unknown) => fn(fakeDb), end: async () => undefined },
);

type AttachmentCalls = {
  create(jobId: string, body: Record<string, unknown>, caller: unknown): Promise<unknown>;
};

describe('job attachments in the real module graph', () => {
  it("judge a teammate's attachment against the permissions the job carries", async () => {
    expect(existsSync(path.join(distRoot, 'job-attachments', 'job-attachments.module.js')), 'run `pnpm build` in apps/api first').toBe(true);
    process.env.DATABASE_URL ??= 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'false';

    requireDist('reflect-metadata');
    const { NestFactory } = requireDist('@nestjs/core');
    const { DatabaseModule } = requireDist('./database/database.module.js');
    const { JobAttachmentsModule } = requireDist('./job-attachments/job-attachments.module.js');
    const { JobAttachmentsService } = requireDist('./job-attachments/job-attachments.service.js');

    // The real graph, with the stand-in in place of the database connection.
    (Reflect as unknown as { defineMetadata: (k: string, v: unknown, t: object) => void })
      .defineMetadata('providers', [{ provide: 'DB', useValue: fakeDb }], DatabaseModule);
    class TestRootModule {}
    const app = await NestFactory.createApplicationContext(
      { module: TestRootModule, imports: [DatabaseModule, JobAttachmentsModule] },
      { logger: false },
    );

    try {
      const attachments = app.get(JobAttachmentsService) as AttachmentCalls;
      await expect(
        attachments.create('a-1', { name: 'notes.md', content: 'x' }, { user_id: 'user_mate' }),
      ).rejects.toThrow(/does not hold/);
    } finally {
      await app.close();
    }
  });
});
