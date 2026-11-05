import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AgentsConfigService } from './agents-config.service';

const mocks = vi.hoisted(() => ({
  projects: { findById: vi.fn() },
  orgs: { findById: vi.fn() },
  agents: {
    listByOrgAndSlugs: vi.fn(),
    listByOrgAndAliases: vi.fn(),
    deleteByProject: vi.fn(),
    insert: vi.fn(),
  },
  teams: { deleteByProject: vi.fn(), insert: vi.fn() },
  teamMembers: { deleteByProject: vi.fn(), insert: vi.fn() },
  agentConfigs: { create: vi.fn() },
}));

// The service builds its repositories from the pool and from the transaction;
// both resolve to the same mocks here.
vi.mock('@eve/db', () => ({
  projectQueries: vi.fn(() => mocks.projects),
  orgQueries: vi.fn(() => mocks.orgs),
  projectManifestQueries: vi.fn(() => ({})),
  agentConfigQueries: vi.fn(() => mocks.agentConfigs),
  agentQueries: vi.fn(() => mocks.agents),
  teamQueries: vi.fn(() => mocks.teams),
  teamMemberQueries: vi.fn(() => mocks.teamMembers),
}));

const syncRequest = {
  agents_yaml: 'version: 1\nagents:\n  helper:\n    slug: helper\n    skill: helper\n',
  teams_yaml: 'version: 1\nteams: {}\n',
  chat_yaml: 'version: 1\nroutes: []\n',
};

describe('AgentsConfigService org default agent guard', () => {
  let service: AgentsConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.findById.mockResolvedValue({ id: 'proj_b', org_id: 'org_1' });
    mocks.orgs.findById.mockResolvedValue({ id: 'org_1', default_agent_slug: 'concierge' });
    mocks.agents.listByOrgAndAliases.mockResolvedValue([]);
    mocks.agentConfigs.create.mockImplementation(async (row: Record<string, unknown>) => ({
      ...row,
      created_at: new Date('2026-11-05T00:00:00.000Z'),
      updated_at: new Date('2026-11-05T00:00:00.000Z'),
    }));
    const db = { begin: async (fn: (tx: unknown) => unknown) => fn({}) };
    service = new AgentsConfigService(db as never);
  });

  it('refuses a sync that removes the resolvable org default agent', async () => {
    mocks.agents.listByOrgAndSlugs.mockImplementation(async (_org: string, slugs: string[]) =>
      slugs.includes('concierge') && mocks.agents.deleteByProject.mock.calls.length === 0
        ? [{ project_id: 'proj_b', id: 'concierge', slug: 'concierge' }]
        : [],
    );

    await expect(service.syncAgentsConfig('proj_b', syncRequest)).rejects.toThrow(
      new BadRequestException(
        'Org default agent slug concierge would be removed by this sync. Update the org default before syncing.',
      ),
    );
  });

  it('does not block other projects when the default already resolves nowhere (its project was deleted)', async () => {
    // Org-wide lookups skip soft-deleted projects, so the default resolves to nothing.
    mocks.agents.listByOrgAndSlugs.mockResolvedValue([]);

    await expect(service.syncAgentsConfig('proj_b', syncRequest)).resolves.toBeDefined();
    expect(mocks.agentConfigs.create).toHaveBeenCalledTimes(1);
  });
});
