import { describe, test, expect } from 'vitest';
import {
  PackYamlSchema,
  PackEntrySchema,
  PackLockSchema,
} from '../../src/schemas/pack.js';
import { AgentsSyncRequestSchema } from '../../src/schemas/agent-config.js';

// --- PackYamlSchema ---

describe('PackYamlSchema', () => {
  test('valid pack.yaml parses successfully', () => {
    const valid = {
      version: 1,
      id: 'my-cool-pack',
      imports: {
        agents: 'eve/agents.yaml',
        teams: 'eve/teams.yaml',
        chat: 'eve/chat.yaml',
        x_eve: 'eve/x-eve.yaml',
      },
    };
    const result = PackYamlSchema.parse(valid);
    expect(result.id).toBe('my-cool-pack');
    expect(result.version).toBe(1);
    expect(result.imports.agents).toBe('eve/agents.yaml');
  });

  test('minimal pack.yaml (no optional imports) parses', () => {
    const minimal = {
      version: 1,
      id: 'basic-pack',
      imports: {
        agents: 'agents.yaml',
        teams: 'teams.yaml',
      },
    };
    const result = PackYamlSchema.parse(minimal);
    expect(result.imports.chat).toBeUndefined();
    expect(result.imports.x_eve).toBeUndefined();
    expect(result.imports.workflows).toBeUndefined();
  });

  test('pack.yaml without teams (single-agent pack) parses', () => {
    const noTeams = {
      version: 1,
      id: 'single-agent',
      imports: {
        agents: 'eve/agents.yaml',
        workflows: 'eve/workflows.yaml',
      },
    };
    const result = PackYamlSchema.parse(noTeams);
    expect(result.imports.teams).toBeUndefined();
    expect(result.imports.workflows).toBe('eve/workflows.yaml');
  });

  test('pack.yaml with workflows import parses', () => {
    const withWorkflows = {
      version: 1,
      id: 'workflow-pack',
      imports: {
        agents: 'eve/agents.yaml',
        teams: 'eve/teams.yaml',
        workflows: 'eve/workflows.yaml',
      },
    };
    const result = PackYamlSchema.parse(withWorkflows);
    expect(result.imports.workflows).toBe('eve/workflows.yaml');
  });

  test('invalid ID (uppercase) is rejected', () => {
    const invalid = {
      version: 1,
      id: 'MyPack',
      imports: { agents: 'a.yaml' },
    };
    expect(() => PackYamlSchema.parse(invalid)).toThrow();
  });

  test('invalid ID (spaces) is rejected', () => {
    const invalid = {
      version: 1,
      id: 'my pack',
      imports: { agents: 'a.yaml' },
    };
    expect(() => PackYamlSchema.parse(invalid)).toThrow();
  });

  test('wrong version is rejected', () => {
    const invalid = {
      version: 2,
      id: 'valid-id',
      imports: { agents: 'a.yaml' },
    };
    expect(() => PackYamlSchema.parse(invalid)).toThrow();
  });
});

// --- PackEntrySchema ---

describe('PackEntrySchema', () => {
  test('local source without ref is OK', () => {
    const local = { source: './packs/my-pack' };
    const result = PackEntrySchema.parse(local);
    expect(result.source).toBe('./packs/my-pack');
    expect(result.ref).toBeUndefined();
  });

  test('local source with ../ prefix without ref is OK', () => {
    const local = { source: '../other-repo/pack' };
    const result = PackEntrySchema.parse(local);
    expect(result.source).toBe('../other-repo/pack');
  });

  test('absolute local source without ref is OK', () => {
    const local = { source: '/opt/packs/my-pack' };
    const result = PackEntrySchema.parse(local);
    expect(result.source).toBe('/opt/packs/my-pack');
  });

  test('remote source (github shorthand) without ref is rejected', () => {
    const remote = { source: 'acme/agent-pack' };
    expect(() => PackEntrySchema.parse(remote)).toThrow(
      'ref (40-char SHA) is required for remote pack sources',
    );
  });

  test('remote source (https) without ref is rejected', () => {
    const remote = { source: 'https://github.com/acme/pack.git' };
    expect(() => PackEntrySchema.parse(remote)).toThrow();
  });

  test('remote source (github:) without ref is rejected', () => {
    const remote = { source: 'github:acme/pack' };
    expect(() => PackEntrySchema.parse(remote)).toThrow();
  });

  test('remote source with valid 40-char SHA ref is OK', () => {
    const sha = 'a'.repeat(40);
    const remote = { source: 'acme/agent-pack', ref: sha };
    const result = PackEntrySchema.parse(remote);
    expect(result.ref).toBe(sha);
  });

  test('ref that is not a 40-char hex SHA is rejected', () => {
    const badRef = { source: './local', ref: 'main' };
    expect(() => PackEntrySchema.parse(badRef)).toThrow();
  });

  test('install_agents field is accepted', () => {
    const entry = {
      source: './local-pack',
      install_agents: ['agent_a', 'agent_b'],
    };
    const result = PackEntrySchema.parse(entry);
    expect(result.install_agents).toEqual(['agent_a', 'agent_b']);
  });
});

// --- PackLockSchema ---

describe('PackLockSchema', () => {
  test('valid lockfile parses successfully', () => {
    const valid = {
      resolved_at: '2025-01-15T10:30:00Z',
      project_slug: 'my-project',
      packs: [
        {
          id: 'core-agents',
          source: 'acme/core-agents',
          ref: 'b'.repeat(40),
          pack_version: 1,
        },
      ],
      effective: {
        agents_count: 5,
        teams_count: 2,
        routes_count: 3,
        profiles_count: 1,
        agents_hash: 'abc123',
        teams_hash: 'def456',
        chat_hash: 'ghi789',
      },
    };
    const result = PackLockSchema.parse(valid);
    expect(result.project_slug).toBe('my-project');
    expect(result.packs).toHaveLength(1);
    expect(result.effective.agents_count).toBe(5);
  });

  test('lockfile with empty packs array is valid', () => {
    const valid = {
      resolved_at: '2025-01-15T10:30:00Z',
      project_slug: 'empty-proj',
      packs: [],
      effective: {
        agents_count: 0,
        teams_count: 0,
        routes_count: 0,
        profiles_count: 0,
        agents_hash: 'empty',
        teams_hash: 'empty',
        chat_hash: 'empty',
      },
    };
    expect(() => PackLockSchema.parse(valid)).not.toThrow();
  });

  test('lockfile with invalid datetime is rejected', () => {
    const invalid = {
      resolved_at: 'not-a-date',
      project_slug: 'proj',
      packs: [],
      effective: {
        agents_count: 0,
        teams_count: 0,
        routes_count: 0,
        profiles_count: 0,
        agents_hash: 'a',
        teams_hash: 'b',
        chat_hash: 'c',
      },
    };
    expect(() => PackLockSchema.parse(invalid)).toThrow();
  });

  test('lockfile with negative count is rejected', () => {
    const invalid = {
      resolved_at: '2025-01-15T10:30:00Z',
      project_slug: 'proj',
      packs: [],
      effective: {
        agents_count: -1,
        teams_count: 0,
        routes_count: 0,
        profiles_count: 0,
        agents_hash: 'a',
        teams_hash: 'b',
        chat_hash: 'c',
      },
    };
    expect(() => PackLockSchema.parse(invalid)).toThrow();
  });
});

// --- AgentsSyncRequestSchema (pack_refs field) ---

describe('AgentsSyncRequestSchema', () => {
  test('pack_refs field is accepted when present', () => {
    const req = {
      agents_yaml: 'version: 1\nagents: {}',
      teams_yaml: 'version: 1\nteams: {}',
      chat_yaml: 'version: 1\nroutes: []',
      pack_refs: [
        { id: 'core', source: 'acme/core', ref: 'abc123' },
      ],
    };
    const result = AgentsSyncRequestSchema.parse(req);
    expect(result.pack_refs).toHaveLength(1);
    expect(result.pack_refs![0].id).toBe('core');
  });

  test('pack_refs is optional', () => {
    const req = {
      agents_yaml: 'version: 1',
      teams_yaml: 'version: 1',
      chat_yaml: 'version: 1',
    };
    const result = AgentsSyncRequestSchema.parse(req);
    expect(result.pack_refs).toBeUndefined();
  });

  test('empty yaml fields are rejected', () => {
    const req = {
      agents_yaml: '',
      teams_yaml: 'version: 1',
      chat_yaml: 'version: 1',
    };
    expect(() => AgentsSyncRequestSchema.parse(req)).toThrow();
  });
});
