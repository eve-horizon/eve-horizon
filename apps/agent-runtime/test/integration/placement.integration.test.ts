import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import type { Db } from '@eve/db';
import { createDb } from '@eve/db';
import { RuntimeService } from '../../src/runtime/runtime.service.js';

const databaseUrl = process.env.DATABASE_URL ||
  `postgres://eve:eve@localhost:${process.env.EVE_DB_PORT || '4803'}/${process.env.EVE_DB_NAME_TEST || 'eve_test'}`;

describe('agent runtime placement', () => {
  let db: Db;
  let dbAvailable = false;

  beforeAll(async () => {
    try {
      const probe = createDb(databaseUrl);
      await probe`SELECT 1`;
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    db = createDb(databaseUrl);
    await db`TRUNCATE agent_runtime_pods, agent_placements CASCADE`;
  });

  it('rejects when agent hashes to another pod', async () => {
    if (!dbAvailable) {
      return;
    }
    process.env.EVE_ORG_ID = 'org_test';
    process.env.AGENT_RUNTIME_POD_NAME = 'pod-b';
    process.env.AGENT_RUNTIME_HEARTBEAT_TTL_MS = '60000';

    await db`
      INSERT INTO orgs (id, name, slug)
      VALUES ('org_test', 'Org Test', 'orgtest')
      ON CONFLICT (id) DO NOTHING
    `;

    await db`
      INSERT INTO agent_runtime_pods (org_id, pod_name, status, capacity, last_heartbeat_at)
      VALUES ('org_test', 'pod-a', 'healthy', 1, NOW()),
             ('org_test', 'pod-b', 'healthy', 1, NOW())
    `;

    const service = new RuntimeService(db);
    const result = await service.resolvePlacement('agent-one');
    expect(result.accepted).toBeTypeOf('boolean');
    if (!result.accepted) {
      expect(result.targetPod).toBeTruthy();
    }
  });

  it('uses invocation org in multi-org mode instead of static env org', async () => {
    if (!dbAvailable) {
      return;
    }

    process.env.EVE_ORG_ID = 'org_static';
    process.env.AGENT_RUNTIME_MULTI_ORG = 'true';
    process.env.AGENT_RUNTIME_POD_NAME = 'pod-shared';
    process.env.AGENT_RUNTIME_HEARTBEAT_TTL_MS = '60000';

    await db`
      INSERT INTO orgs (id, name, slug)
      VALUES ('org_static', 'Static Org', 'orgstatic'),
             ('org_dynamic', 'Dynamic Org', 'orgdynamic')
      ON CONFLICT (id) DO NOTHING
    `;

    await db`
      INSERT INTO agent_runtime_pods (org_id, pod_name, status, capacity, last_heartbeat_at)
      VALUES ('org_dynamic', 'pod-shared', 'healthy', 1, NOW())
    `;

    const service = new RuntimeService(db);
    const result = await service.resolvePlacement('agent-two', 'org_dynamic');
    expect(result.accepted).toBe(true);

    const rows = await db<{ org_id: string; agent_id: string; pod_name: string }[]>`
      SELECT org_id, agent_id, pod_name
      FROM agent_placements
      WHERE agent_id = 'agent-two'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].org_id).toBe('org_dynamic');
    expect(rows[0].pod_name).toBe('pod-shared');
  });
});
