import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Builds the real Nest module graph for the pipeline and workflow expanders and
 * checks that the step-permission ceiling is wired in at runtime, not only when
 * a test constructs the service by hand.
 *
 * Nest resolves constructor dependencies from TypeScript's emitted decorator
 * metadata, which vitest's transform does not produce, so this test loads the
 * compiled modules from apps/api/dist (`pnpm build` runs before `pnpm test`).
 */
const apiRoot = path.resolve(__dirname, '../..');
const distRoot = path.join(apiRoot, 'dist');
const requireDist = createRequire(path.join(distRoot, 'main.js'));

/** DB stand-in: user_member is a plain member of org_a; proj_a belongs to org_a. */
const fakeDb = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM org_memberships/.test(sql) && values[0] === 'user_member' && values[1] === 'org_a') {
      return [{ user_id: 'user_member', org_id: 'org_a', role: 'member' }];
    }
    if (/FROM projects WHERE id/.test(sql) && values[0] === 'proj_a') {
      return [{ id: 'proj_a', org_id: 'org_a', slug: 'a', name: 'a' }];
    }
    return [];
  },
  { json: (v: unknown) => v, begin: async (fn: (tx: unknown) => unknown) => fn(fakeDb), end: async () => undefined },
);

type StepCeiling = {
  ceilStepTokenPermissions(
    orgId: string,
    projectId: string,
    userId: string | undefined,
    permissions: string[] | null,
    context: string,
  ): Promise<{ permissions: string[] | null; withheld: string[] }>;
};

describe('pipeline and workflow expanders in the real module graph', () => {
  it('get the access service and hold a member to their own permissions', async () => {
    expect(existsSync(path.join(distRoot, 'pipelines', 'pipelines.module.js')), 'run `pnpm build` in apps/api first').toBe(true);
    process.env.DATABASE_URL ??= 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'false';

    requireDist('reflect-metadata');
    const { NestFactory } = requireDist('@nestjs/core');
    const { DatabaseModule } = requireDist('./database/database.module.js');
    const { PipelinesModule } = requireDist('./pipelines/pipelines.module.js');
    const { WorkflowsModule } = requireDist('./workflows/workflows.module.js');
    const { PipelineExpanderService } = requireDist('./pipelines/pipeline-expander.service.js');
    const { WorkflowsService } = requireDist('./workflows/workflows.service.js');

    // The real graph, with the stand-in in place of the database connection.
    (Reflect as unknown as { defineMetadata: (k: string, v: unknown, t: object) => void })
      .defineMetadata('providers', [{ provide: 'DB', useValue: fakeDb }], DatabaseModule);
    class TestRootModule {}
    const app = await NestFactory.createApplicationContext(
      { module: TestRootModule, imports: [DatabaseModule, PipelinesModule, WorkflowsModule] },
      { logger: false },
    );

    try {
      for (const service of [app.get(PipelineExpanderService) as StepCeiling, app.get(WorkflowsService) as StepCeiling]) {
        for (const permission of ['system:admin', 'orgs:admin']) {
          await expect(
            service.ceilStepTokenPermissions('org_a', 'proj_a', 'user_member', [permission], 'step'),
          ).rejects.toThrow(/does not hold/);
        }
        await expect(
          service.ceilStepTokenPermissions('org_a', 'proj_a', 'user_member', ['jobs:read'], 'step'),
        ).resolves.toEqual({ permissions: ['jobs:read'], withheld: [] });
      }
    } finally {
      await app.close();
    }
  });
});
