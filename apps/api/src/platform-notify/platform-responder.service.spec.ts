import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlatformResponderService } from './platform-responder.service.js';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

interface MockEnv {
  environment_slug: string;
  status: 'healthy' | 'degraded' | 'critical';
  issues_json: Array<{ type: string; pod: string; restarts?: number }> | null;
  actions_taken_json: Array<{ type: string; deployment: string }> | null;
}

const healthyEnv: MockEnv = {
  environment_slug: 'acme-api-prod',
  status: 'healthy',
  issues_json: null,
  actions_taken_json: null,
};

const degradedEnv: MockEnv = {
  environment_slug: 'acme-api-staging',
  status: 'degraded',
  issues_json: [{ type: 'crash_loop_backoff', pod: 'api-7f8d-abc', restarts: 5 }],
  actions_taken_json: null,
};

const criticalEnv: MockEnv = {
  environment_slug: 'acme-web-prod',
  status: 'critical',
  issues_json: [{ type: 'image_pull_backoff', pod: 'web-9a1b-xyz' }],
  actions_taken_json: [{ type: 'scale_to_zero', deployment: 'web-deployment' }],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockHealthChecks(opts: {
  summary?: { total: number; healthy: number; degraded: number; critical: number };
  allEnvs?: MockEnv[];
  degradedEnvs?: MockEnv[];
  criticalEnvs?: MockEnv[];
}) {
  const summary = opts.summary ?? { total: 0, healthy: 0, degraded: 0, critical: 0 };
  const allEnvs = opts.allEnvs ?? [];
  const degradedEnvs = opts.degradedEnvs ?? [];
  const criticalEnvs = opts.criticalEnvs ?? [];

  return {
    summary: vi.fn().mockResolvedValue(summary),
    listAll: vi.fn().mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'degraded') return Promise.resolve(degradedEnvs);
      if (filter?.status === 'critical') return Promise.resolve(criticalEnvs);
      return Promise.resolve(allEnvs);
    }),
  };
}

function buildService(opts: Parameters<typeof createMockHealthChecks>[0] = {}) {
  const db = vi.fn() as unknown;
  const service = new PlatformResponderService(db as any);
  (service as any).healthChecks = createMockHealthChecks(opts);
  return service;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlatformResponderService', () => {
  describe('"health" keyword', () => {
    it('returns full health report with summary counts', async () => {
      const service = buildService({
        summary: { total: 3, healthy: 1, degraded: 1, critical: 1 },
        allEnvs: [healthyEnv, degradedEnv, criticalEnv],
      });

      const result = await service.respond('health');

      expect(result).toContain('Platform Health Report');
      expect(result).toContain('3 tracked');
      expect(result).toContain('1 healthy');
      expect(result).toContain('1 degraded');
      expect(result).toContain('1 critical');
    });

    it('shows unhealthy environments with issue details', async () => {
      const service = buildService({
        summary: { total: 2, healthy: 0, degraded: 1, critical: 1 },
        allEnvs: [degradedEnv, criticalEnv],
      });

      const result = await service.respond('status');

      expect(result).toContain('Issues:');
      expect(result).toContain('acme-api-staging');
      expect(result).toContain('crash_loop_backoff');
      expect(result).toContain('5 restarts');
      expect(result).toContain('acme-web-prod');
      expect(result).toContain('image_pull_backoff');
    });

    it('strips @EveBot mention before matching', async () => {
      const service = buildService({
        summary: { total: 1, healthy: 1, degraded: 0, critical: 0 },
        allEnvs: [healthyEnv],
      });

      const result = await service.respond('@EveBot health');

      expect(result).toContain('Platform Health Report');
    });
  });

  describe('"degraded" keyword', () => {
    it('returns only non-healthy environments', async () => {
      const service = buildService({
        degradedEnvs: [degradedEnv],
        criticalEnvs: [criticalEnv],
      });

      const result = await service.respond('degraded');

      expect(result).toContain('Degraded & Critical Environments');
      expect(result).toContain('acme-api-staging');
      expect(result).toContain('acme-web-prod');
      expect(result).toContain('crash_loop_backoff');
      expect(result).toContain('scale_to_zero');
    });

    it('returns all-clear when no degraded or critical environments', async () => {
      const service = buildService({
        degradedEnvs: [],
        criticalEnvs: [],
      });

      const result = await service.respond('issues');

      expect(result).toContain('No degraded or critical environments');
      expect(result).toContain('All clear');
    });
  });

  describe('"help" keyword', () => {
    it('returns available commands', async () => {
      const service = buildService();

      const result = await service.respond('help');

      expect(result).toContain('Platform Sentinel Commands');
      expect(result).toContain('health');
      expect(result).toContain('degraded');
      expect(result).toContain('resources');
      expect(result).toContain('help');
    });

    it('matches "cmds" alias', async () => {
      const service = buildService();

      const result = await service.respond('cmds');

      expect(result).toContain('Platform Sentinel Commands');
    });
  });

  describe('unknown keyword', () => {
    it('returns fallback message listing available commands', async () => {
      const service = buildService();

      const result = await service.respond('what is going on?');

      expect(result).toContain('health');
      expect(result).toContain('degraded');
      expect(result).toContain('resources');
      expect(result).toContain('help');
    });
  });

  describe('empty health table', () => {
    it('returns "No environments monitored yet" when total is 0', async () => {
      const service = buildService({
        summary: { total: 0, healthy: 0, degraded: 0, critical: 0 },
        allEnvs: [],
      });

      const result = await service.respond('health');

      expect(result).toContain('No environments are being monitored yet');
      expect(result).toContain('0 tracked');
    });
  });

  describe('"resources" keyword', () => {
    it('returns health report (resources is currently aliased to health)', async () => {
      const service = buildService({
        summary: { total: 2, healthy: 2, degraded: 0, critical: 0 },
        allEnvs: [healthyEnv],
      });

      const result = await service.respond('resources');

      expect(result).toContain('Platform Health Report');
    });
  });
});
