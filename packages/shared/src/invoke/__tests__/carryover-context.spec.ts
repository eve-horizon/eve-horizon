import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { writeCarryoverContext } from '../carryover-context.js';
import type { CarryoverContextDb, OrgDocumentRow } from '../types.js';
import type { HarnessInvocation } from '../../types/harness.js';

function makeDb(overrides: Partial<CarryoverContextDb> = {}): CarryoverContextDb {
  return {
    findJobById: vi.fn().mockResolvedValue(null),
    findProjectById: vi.fn().mockResolvedValue(null),
    listOrgDocsByPrefix: vi.fn().mockResolvedValue([]),
    findOrgDocByPath: vi.fn().mockResolvedValue(null),
    findJobAttachment: vi.fn().mockResolvedValue(null),
    queryJobHints: vi.fn().mockResolvedValue(null),
    listThreadMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeInvocation(overrides: Partial<HarnessInvocation> = {}): HarnessInvocation {
  return {
    attemptId: 'att_test' as any,
    jobId: 'job_test' as any,
    projectId: 'proj_test' as any,
    text: 'test prompt',
    workspacePath: '/tmp/test',
    ...overrides,
  };
}

describe('writeCarryoverContext', () => {
  let tmpDir: string;

  async function setup() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'carryover-test-'));
  }

  async function cleanup() {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------
  // Test 1.1 — user category materialization
  // ------------------------------------------------------------------
  describe('user category materialization', () => {
    it('materializes user and learnings categories side by side', async () => {
      await setup();
      try {
        const now = new Date();
        const docs: OrgDocumentRow[] = [
          { path: '/agents/my-agent/memory/user/prefs.md', content: 'User prefers terse output', updated_at: now },
          { path: '/agents/my-agent/memory/learnings/k8s.md', content: 'DNS fails before CNI', updated_at: now },
        ];

        const db = makeDb({
          findJobById: vi.fn().mockResolvedValue({
            hints: {
              agent_context: {
                memory: {
                  agent: 'my-agent',
                  categories: ['user', 'learnings'],
                  max_items: 5,
                },
              },
            },
          }),
          findProjectById: vi.fn().mockResolvedValue({ org_id: 'org_test' }),
          listOrgDocsByPrefix: vi.fn().mockImplementation((_orgId: string, prefix: string) => {
            return Promise.resolve(docs.filter((d) => d.path.startsWith(prefix)));
          }),
        });

        await writeCarryoverContext(makeInvocation(), tmpDir, db);

        const memoryDir = path.join(tmpDir, '.eve', 'context', 'memory');
        const prefsContent = await fs.readFile(path.join(memoryDir, 'prefs.md'), 'utf-8');
        const k8sContent = await fs.readFile(path.join(memoryDir, 'k8s.md'), 'utf-8');

        expect(prefsContent).toBe('User prefers terse output');
        expect(k8sContent).toBe('DNS fails before CNI');

        // Verify both category prefixes were queried
        const listCalls = (db.listOrgDocsByPrefix as any).mock.calls;
        const prefixes = listCalls.map((c: any) => c[1]);
        expect(prefixes).toContain('/agents/my-agent/memory/user/');
        expect(prefixes).toContain('/agents/my-agent/memory/learnings/');
      } finally {
        await cleanup();
      }
    });

    it('materializes only user category when configured alone', async () => {
      await setup();
      try {
        const db = makeDb({
          findJobById: vi.fn().mockResolvedValue({
            hints: {
              agent_context: {
                memory: {
                  agent: 'my-agent',
                  categories: ['user'],
                  max_items: 10,
                },
              },
            },
          }),
          findProjectById: vi.fn().mockResolvedValue({ org_id: 'org_test' }),
          listOrgDocsByPrefix: vi.fn().mockResolvedValue([
            { path: '/agents/my-agent/memory/user/style.md', content: 'Terse, no emojis', updated_at: new Date() },
          ]),
        });

        await writeCarryoverContext(makeInvocation(), tmpDir, db);

        const content = await fs.readFile(
          path.join(tmpDir, '.eve', 'context', 'memory', 'style.md'),
          'utf-8',
        );
        expect(content).toBe('Terse, no emojis');
      } finally {
        await cleanup();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 1.2 — max_items enforcement
  // ------------------------------------------------------------------
  describe('max_items enforcement', () => {
    it('limits materialized docs to max_items', async () => {
      await setup();
      try {
        const now = new Date();
        const docs: OrgDocumentRow[] = Array.from({ length: 15 }, (_, i) => ({
          path: `/agents/my-agent/memory/learnings/entry-${String(i).padStart(2, '0')}.md`,
          content: `Learning ${i}`,
          updated_at: new Date(now.getTime() - i * 60_000), // newest first
        }));

        const db = makeDb({
          findJobById: vi.fn().mockResolvedValue({
            hints: {
              agent_context: {
                memory: { agent: 'my-agent', categories: ['learnings'], max_items: 5 },
              },
            },
          }),
          findProjectById: vi.fn().mockResolvedValue({ org_id: 'org_test' }),
          listOrgDocsByPrefix: vi.fn().mockResolvedValue(docs),
        });

        await writeCarryoverContext(makeInvocation(), tmpDir, db);

        const memoryDir = path.join(tmpDir, '.eve', 'context', 'memory');
        const files = await fs.readdir(memoryDir);
        expect(files).toHaveLength(5);
      } finally {
        await cleanup();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 1.2 — max_age enforcement
  // ------------------------------------------------------------------
  describe('max_age enforcement', () => {
    it('filters out docs older than max_age', async () => {
      await setup();
      try {
        const now = Date.now();
        const docs: OrgDocumentRow[] = [
          { path: '/agents/my-agent/memory/context/fresh.md', content: 'Fresh fact', updated_at: new Date(now - 3 * 86_400_000) },  // 3 days ago
          { path: '/agents/my-agent/memory/context/stale.md', content: 'Stale fact', updated_at: new Date(now - 10 * 86_400_000) }, // 10 days ago
          { path: '/agents/my-agent/memory/context/ancient.md', content: 'Ancient fact', updated_at: new Date(now - 30 * 86_400_000) }, // 30 days ago
        ];

        const db = makeDb({
          findJobById: vi.fn().mockResolvedValue({
            hints: {
              agent_context: {
                memory: { agent: 'my-agent', categories: ['context'], max_items: 10, max_age: '7d' },
              },
            },
          }),
          findProjectById: vi.fn().mockResolvedValue({ org_id: 'org_test' }),
          listOrgDocsByPrefix: vi.fn().mockResolvedValue(docs),
        });

        await writeCarryoverContext(makeInvocation(), tmpDir, db);

        const memoryDir = path.join(tmpDir, '.eve', 'context', 'memory');
        const files = await fs.readdir(memoryDir);
        expect(files).toHaveLength(1);
        expect(files).toContain('fresh.md');

        const content = await fs.readFile(path.join(memoryDir, 'fresh.md'), 'utf-8');
        expect(content).toBe('Fresh fact');
      } finally {
        await cleanup();
      }
    });
  });

  // ------------------------------------------------------------------
  // No-op when no context configured
  // ------------------------------------------------------------------
  describe('no-op cases', () => {
    it('does nothing when job has no agent_context hints', async () => {
      await setup();
      try {
        const db = makeDb({
          findJobById: vi.fn().mockResolvedValue({ hints: {} }),
          findProjectById: vi.fn().mockResolvedValue({ org_id: 'org_test' }),
        });

        await writeCarryoverContext(makeInvocation(), tmpDir, db);

        const contextExists = await fs.access(path.join(tmpDir, '.eve', 'context'))
          .then(() => true).catch(() => false);
        expect(contextExists).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  // ------------------------------------------------------------------
  // Parent attachments
  // ------------------------------------------------------------------
  describe('parent attachments', () => {
    /** The lead job's attachments: one by the invoker, one by a teammate, one by work no user started. */
    const LEAD_ATTACHMENTS: Record<string, { content: string; created_by: string | null }> = {
      'brief.md': { content: 'Owner brief', created_by: 'user_owner' },
      'notes.md': { content: 'Teammate notes', created_by: 'user_mate' },
      'plan.md': { content: 'Step plan', created_by: 'system' },
    };

    function childOfLead(actor: string | null) {
      return makeDb({
        findJobById: vi.fn().mockResolvedValue({
          actor_user_id: actor,
          hints: { agent_context: { parent_attachments: { names: ['brief.md', 'notes.md', 'plan.md'] } } },
        }),
        findProjectById: vi.fn().mockResolvedValue({ org_id: 'org_test' }),
        findJobAttachment: vi.fn().mockImplementation((jobId: string, name: string) =>
          Promise.resolve(jobId === 'lead_job' ? LEAD_ATTACHMENTS[name] : undefined)),
      });
    }

    async function copied(): Promise<string[]> {
      return (await fs.readdir(path.join(tmpDir, '.eve', 'context', 'parent'))).sort();
    }

    it("copies only the parent's attachments the child's actor created", async () => {
      await setup();
      try {
        await writeCarryoverContext(makeInvocation({ parentJobId: 'lead_job' as any }), tmpDir, childOfLead('user_owner'));

        expect(await copied()).toEqual(['brief.md']);
        await expect(fs.readFile(path.join(tmpDir, '.eve', 'context', 'parent', 'brief.md'), 'utf-8')).resolves.toBe('Owner brief');
      } finally {
        await cleanup();
      }
    });

    it('copies into a child no user started only what work no user started attached', async () => {
      await setup();
      try {
        await writeCarryoverContext(makeInvocation({ parentJobId: 'lead_job' as any }), tmpDir, childOfLead(null));

        expect(await copied()).toEqual(['plan.md']);
      } finally {
        await cleanup();
      }
    });
  });
});
