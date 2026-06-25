import { describe, expect, it, vi } from 'vitest';
import { ManagedDbReconcilerService } from './managed-db-reconciler.service.js';

describe('ManagedDbReconcilerService.reconcile', () => {
  it('releases stale locks before processing tenants', async () => {
    const forceReleaseStaleOperationLocks = vi.fn().mockResolvedValue([]);
    const listTenantsNeedingReconciliation = vi.fn().mockResolvedValue([]);
    const findOrphanedTenants = vi.fn().mockResolvedValue([]);

    // Create a minimal mock DB that returns a queries object
    const mockDb = Object.assign(
      () => Promise.resolve([]),
      { json: vi.fn(), end: vi.fn() },
    ) as unknown as import('@eve/db').Db;

    const service = new ManagedDbReconcilerService(mockDb);

    // Replace the internal managedDb with our mock
    const managedDb = {
      forceReleaseStaleOperationLocks,
      listTenantsNeedingReconciliation,
      findOrphanedTenants,
    };
    Object.assign(service, { managedDb });

    await service.reconcile();

    expect(forceReleaseStaleOperationLocks).toHaveBeenCalledWith(10);
    expect(listTenantsNeedingReconciliation).toHaveBeenCalled();
  });

  it('logs a warning when stale locks are released', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forceReleaseStaleOperationLocks = vi.fn().mockResolvedValue([
      { id: 'mdbt_abc', operation_token: 'tok-123' },
    ]);
    const listTenantsNeedingReconciliation = vi.fn().mockResolvedValue([]);
    const findOrphanedTenants = vi.fn().mockResolvedValue([]);

    const mockDb = Object.assign(
      () => Promise.resolve([]),
      { json: vi.fn(), end: vi.fn() },
    ) as unknown as import('@eve/db').Db;

    const service = new ManagedDbReconcilerService(mockDb);
    Object.assign(service, {
      managedDb: {
        forceReleaseStaleOperationLocks,
        listTenantsNeedingReconciliation,
        findOrphanedTenants,
      },
    });

    await service.reconcile();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Released 1 stale lock(s)'),
      'mdbt_abc',
    );
    consoleSpy.mockRestore();
  });
});

