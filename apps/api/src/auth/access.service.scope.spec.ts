import { describe, expect, it } from 'vitest';
import { AccessService } from './access.service.js';

describe('AccessService evaluateScope', () => {
  const service = new AccessService({} as never, {} as never);

  it('matches cloud_fs mount ids', () => {
    expect(service.evaluateScope(
      { cloud_fs: { allow_mount_ids: ['mount_a'] } },
      'cloud_fs:read',
      { type: 'cloud_fs', id: 'mount_a', action: 'read' },
    )).toMatchObject({ scope_required: true, scope_matched: true });

    expect(service.evaluateScope(
      { cloud_fs: { allow_mount_ids: ['mount_a'] } },
      'cloud_fs:read',
      { type: 'cloud_fs', id: 'mount_b', action: 'read' },
    )).toMatchObject({ scope_required: true, scope_matched: false });
  });

  it('preserves non-resource permissions as not scope-required', () => {
    expect(service.evaluateScope(
      { cloud_fs: { allow_mount_ids: ['mount_a'] } },
      'jobs:read',
    )).toMatchObject({ scope_required: false, scope_matched: true });
  });
});
