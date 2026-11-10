import { describe, expect, it, vi } from 'vitest';
import { SecretsService } from '../secrets/secrets.service';

// Which actor bound-token work records, and the marker that keeps it from
// resolving user-scope secrets, are covered in src/auth/bound-token-work.spec.ts.

const secretRows = vi.hoisted(() => ({
  listByScope: vi.fn(async (scopeType: string) => [{ key: `${scopeType.toUpperCase()}_KEY`, value_encrypted: 'x', type: 'env_var' }]),
}));

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  return {
    ...actual,
    secretQueries: vi.fn(() => secretRows),
    projectQueries: vi.fn(() => ({ findById: vi.fn(async () => ({ id: 'proj_a', org_id: 'org_a' })) })),
  };
});

describe('secret resolution for a job that resolves no user', () => {
  it('returns project, org and system secrets but no user secrets', async () => {
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_SECRETS_MASTER_KEY = 'test-master-key';
    const secrets = new SecretsService({} as never);
    (secrets as unknown as { decrypt: (v: string) => string }).decrypt = (v) => v;

    const resolved = await secrets.resolveForProject('proj_a', undefined);

    expect(resolved.map((r) => r.scope_type).sort()).toEqual(['org', 'project', 'system']);
    expect(secretRows.listByScope).not.toHaveBeenCalledWith('user', expect.anything(), expect.anything());
  });
});
