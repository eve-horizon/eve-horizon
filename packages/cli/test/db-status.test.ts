import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleDb } from '../src/commands/db';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
  requestRaw: vi.fn(),
}));

import { requestJson } from '../src/lib/client';

const context = {
  apiUrl: 'http://example.test',
  token: 'token',
  profile: null,
  profileName: null,
  projectId: 'proj_1',
};

const baseTenant = {
  id: 'mdbt_1',
  class: 'db.p1',
  status: 'ready',
  db_name: 'acme-shop-staging-1a2b3c',
  instance_id: 'mdbi_1',
  desired_class: null,
  declared_extensions: [],
  enabled_extensions: [],
  installed_extensions: [],
  installed_extensions_error: null,
  ready_at: '2026-09-15T10:00:00.000Z',
  created_at: '2026-09-15T09:00:00.000Z',
  updated_at: '2026-09-15T10:00:00.000Z',
};

describe('db status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
  });

  it('prints declared and provisioned roles', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({
      ...baseTenant,
      declared_roles: [
        { name: 'app', grants: 'readwrite' },
        { name: 'reports', grants: 'readonly' },
      ],
      roles: [
        { name: 'app', grants: 'readwrite', username: 'acme-shop-staging-u-1a2b3c-app' },
      ],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleDb('status', [], { env: 'staging' }, context as never);

    expect(requestJson).toHaveBeenCalledWith(context, '/projects/proj_1/envs/staging/db/managed');
    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Declared Roles:      app (readwrite), reports (readonly)');
    expect(output).toContain('Provisioned Roles:   app (readwrite) as acme-shop-staging-u-1a2b3c-app');
  });

  it('prints (none) when the tenant has no roles', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({ ...baseTenant, declared_roles: [], roles: [] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleDb('status', [], { env: 'staging' }, context as never);

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Declared Roles:      (none)');
    expect(output).toContain('Provisioned Roles:   (none)');
  });

  it('omits the role lines for API responses that predate roles', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(baseTenant);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleDb('status', [], { env: 'staging' }, context as never);

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).not.toContain('Roles:');
  });
});
