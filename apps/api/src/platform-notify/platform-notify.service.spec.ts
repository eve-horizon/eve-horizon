import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlatformNotifyService, type PlatformAlert } from './platform-notify.service.js';

// ---------------------------------------------------------------------------
// Mock loadConfig — must be hoisted before the import resolves
// ---------------------------------------------------------------------------
const mockConfig: Record<string, string | undefined> = {};
vi.mock('@eve/shared', () => ({
  loadConfig: () => mockConfig,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSettings(store: Record<string, string | null> = {}) {
  return {
    get: vi.fn(async (key: string) => {
      const val = store[key];
      return val != null ? { key, value: val } : null;
    }),
  };
}

function createMockHealthChecks(overrides: {
  findByEnvironmentId?: ReturnType<typeof vi.fn>;
  markNotified?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    findByEnvironmentId: overrides.findByEnvironmentId ?? vi.fn().mockResolvedValue(null),
    markNotified: overrides.markNotified ?? vi.fn().mockResolvedValue(undefined),
  };
}

/** Tagged-template mock: db`SELECT ...` returns whatever rows we configure. */
function createMockDb(integrationRows: Array<{ account_id: string }> = []) {
  const dbFn = vi.fn().mockResolvedValue(integrationRows);
  return dbFn as unknown;
}

function buildService(opts: {
  settings?: Record<string, string | null>;
  integrationRows?: Array<{ account_id: string }>;
  healthCheckOverrides?: Parameters<typeof createMockHealthChecks>[0];
}) {
  const db = createMockDb(opts.integrationRows ?? []);
  const service = new PlatformNotifyService(db as any);

  // Inject mocks via private field access (same pattern as workflows.service.spec)
  (service as any).settings = createMockSettings(opts.settings ?? {});
  (service as any).healthChecks = createMockHealthChecks(opts.healthCheckOverrides);

  return { service, db };
}

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as any;

  // Reset config
  Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
  mockConfig.EVE_GATEWAY_URL = 'http://gateway.test:4820';
  mockConfig.EVE_INTERNAL_API_KEY = 'test-internal-key';
});

// Restore after all tests
import { afterAll } from 'vitest';
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const degradedAlert: PlatformAlert = {
  severity: 'warning',
  type: 'env.health.degraded',
  environment: {
    org_slug: 'acme',
    project_slug: 'api',
    env_name: 'staging',
    environment_id: 'env_123',
  },
  issues: [
    { type: 'crash_loop_backoff', pod: 'api-7f8d-abc', restarts: 5 },
  ],
};

const criticalAlert: PlatformAlert = {
  severity: 'critical',
  type: 'env.health.critical',
  environment: {
    org_slug: 'acme',
    project_slug: 'api',
    env_name: 'prod',
    environment_id: 'env_456',
  },
  issues: [
    { type: 'image_pull_backoff', pod: 'api-9a1b-xyz', image: 'ghcr.io/acme/api:bad' },
  ],
};

const circuitBrokenAlert: PlatformAlert = {
  severity: 'critical',
  type: 'env.health.circuit_broken',
  environment: {
    org_slug: 'acme',
    project_slug: 'api',
    env_name: 'staging',
    environment_id: 'env_123',
  },
  actions_taken: [{ type: 'scale_to_zero', deployment: 'api-deployment' }],
};

const recoveredAlert: PlatformAlert = {
  severity: 'info',
  type: 'env.health.recovered',
  environment: {
    org_slug: 'acme',
    project_slug: 'api',
    env_name: 'staging',
    environment_id: 'env_123',
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlatformNotifyService', () => {
  describe('sentinel disabled', () => {
    it('returns delivered=false when sentinel.enabled is not set', async () => {
      const { service } = buildService({ settings: {} });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: false, reason: 'sentinel disabled' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns delivered=false when sentinel.enabled is "false"', async () => {
      const { service } = buildService({
        settings: { 'sentinel.enabled': 'false' },
      });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: false, reason: 'sentinel disabled' });
    });
  });

  describe('missing integration config', () => {
    it('returns error when integration_id is not set', async () => {
      const { service } = buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.channel_id': 'C123',
        },
      });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: false, reason: 'slack config incomplete' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns error when channel_id is not set', async () => {
      const { service } = buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.integration_id': 'int_abc',
        },
      });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: false, reason: 'slack config incomplete' });
    });

    it('returns error when slack integration row is not found in DB', async () => {
      const { service } = buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.integration_id': 'int_ghost',
          'sentinel.slack.channel_id': 'C123',
        },
        integrationRows: [], // no rows returned
      });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: false, reason: 'slack integration not found' });
    });
  });

  describe('successful delivery', () => {
    function buildReadyService(healthCheckOverrides?: Parameters<typeof createMockHealthChecks>[0]) {
      return buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.integration_id': 'int_abc',
          'sentinel.slack.channel_id': 'C123CHAN',
        },
        integrationRows: [{ account_id: 'T_SLACK_TEAM' }],
        healthCheckOverrides,
      });
    }

    it('calls gateway POST /internal/deliver with correct payload', async () => {
      const { service } = buildReadyService();
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: true });
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://gateway.test:4820/internal/deliver');
      expect(init.method).toBe('POST');
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.headers['x-eve-internal-token']).toBe('test-internal-key');

      const body = JSON.parse(init.body);
      expect(body.provider).toBe('slack');
      expect(body.account_id).toBe('T_SLACK_TEAM');
      expect(body.channel_id).toBe('C123CHAN');
      expect(body.text).toContain('Degraded');
    });

    it('marks the environment as notified after successful delivery', async () => {
      const markNotified = vi.fn().mockResolvedValue(undefined);
      const { service } = buildReadyService({ markNotified });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await service.notify(degradedAlert);

      expect(markNotified).toHaveBeenCalledWith('env_123');
    });

    it('returns gateway error status on non-ok response', async () => {
      const { service } = buildReadyService();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve('Bad Gateway'),
      });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: false, reason: 'gateway error: 502' });
    });

    it('returns delivery error on fetch exception', async () => {
      const { service } = buildReadyService();
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: false, reason: 'delivery error: ECONNREFUSED' });
    });

    it('returns error when EVE_GATEWAY_URL is not configured', async () => {
      const { service } = buildReadyService();
      delete mockConfig.EVE_GATEWAY_URL;

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: false, reason: 'gateway url not configured' });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('dedup: within window', () => {
    it('suppresses when same signature was notified within 4 hours', async () => {
      const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour ago
      const findByEnvironmentId = vi.fn().mockResolvedValue({
        notified_at: recentTime,
        issue_signature: 'crash_loop_backoff', // same single-issue signature
      });

      const { service } = buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.integration_id': 'int_abc',
          'sentinel.slack.channel_id': 'C123',
        },
        integrationRows: [{ account_id: 'T1' }],
        healthCheckOverrides: { findByEnvironmentId },
      });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: false, reason: 'dedup: notified within 4h for same issues' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('delivers when signature differs even within window', async () => {
      const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000);
      const findByEnvironmentId = vi.fn().mockResolvedValue({
        notified_at: recentTime,
        issue_signature: 'image_pull_backoff', // different from crash_loop_backoff
      });

      const { service } = buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.integration_id': 'int_abc',
          'sentinel.slack.channel_id': 'C123',
        },
        integrationRows: [{ account_id: 'T1' }],
        healthCheckOverrides: { findByEnvironmentId },
      });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: true });
    });

    it('delivers when outside the 4-hour window', async () => {
      const oldTime = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
      const findByEnvironmentId = vi.fn().mockResolvedValue({
        notified_at: oldTime,
        issue_signature: 'crash_loop_backoff',
      });

      const { service } = buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.integration_id': 'int_abc',
          'sentinel.slack.channel_id': 'C123',
        },
        integrationRows: [{ account_id: 'T1' }],
        healthCheckOverrides: { findByEnvironmentId },
      });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await service.notify(degradedAlert);

      expect(result).toEqual({ delivered: true });
    });
  });

  describe('dedup: recovery bypasses', () => {
    it('always delivers recovery events regardless of dedup state', async () => {
      const recentTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const findByEnvironmentId = vi.fn().mockResolvedValue({
        notified_at: recentTime,
        issue_signature: 'crash_loop_backoff',
      });

      const { service } = buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.integration_id': 'int_abc',
          'sentinel.slack.channel_id': 'C123',
        },
        integrationRows: [{ account_id: 'T1' }],
        healthCheckOverrides: { findByEnvironmentId },
      });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await service.notify(recoveredAlert);

      expect(result).toEqual({ delivered: true });
      // findByEnvironmentId should NOT be called for recovery (dedup skipped)
      expect(findByEnvironmentId).not.toHaveBeenCalled();
    });
  });

  describe('dedup: circuit-breaker bypasses', () => {
    it('always delivers circuit-breaker events regardless of dedup state', async () => {
      const recentTime = new Date(Date.now() - 10 * 60 * 1000);
      const findByEnvironmentId = vi.fn().mockResolvedValue({
        notified_at: recentTime,
        issue_signature: 'crash_loop_backoff',
      });

      const { service } = buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.integration_id': 'int_abc',
          'sentinel.slack.channel_id': 'C123',
        },
        integrationRows: [{ account_id: 'T1' }],
        healthCheckOverrides: { findByEnvironmentId },
      });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await service.notify(circuitBrokenAlert);

      expect(result).toEqual({ delivered: true });
      expect(findByEnvironmentId).not.toHaveBeenCalled();
    });
  });

  describe('message formatting', () => {
    // Use a ready service that delivers successfully, then inspect the text in the fetch call
    function buildFormattingService() {
      const { service } = buildService({
        settings: {
          'sentinel.enabled': 'true',
          'sentinel.slack.integration_id': 'int_abc',
          'sentinel.slack.channel_id': 'C123',
        },
        integrationRows: [{ account_id: 'T1' }],
      });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      return service;
    }

    function extractDeliveredText(): string {
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      return body.text;
    }

    it('formats degraded alert with issues and recovery hint', async () => {
      const service = buildFormattingService();
      await service.notify(degradedAlert);

      const text = extractDeliveredText();
      expect(text).toContain('Environment Degraded');
      expect(text).toContain('acme / api / staging');
      expect(text).toContain('crash_loop_backoff');
      expect(text).toContain('5 restarts');
      expect(text).toContain('eve env diagnose');
    });

    it('formats critical alert with image info and deploy recovery hint', async () => {
      const service = buildFormattingService();
      await service.notify(criticalAlert);

      const text = extractDeliveredText();
      expect(text).toContain('Environment Critical');
      expect(text).toContain('acme / api / prod');
      expect(text).toContain('image_pull_backoff');
      expect(text).toContain('ghcr.io/acme/api:bad');
      expect(text).toContain('eve env deploy');
    });

    it('formats circuit-breaker alert with scaled deployments', async () => {
      const service = buildFormattingService();
      await service.notify(circuitBrokenAlert);

      const text = extractDeliveredText();
      expect(text).toContain('Circuit-Breaker Activated');
      expect(text).toContain('api-deployment');
      expect(text).toContain('scaled to zero');
    });

    it('formats recovered alert with all-healthy message', async () => {
      const service = buildFormattingService();
      await service.notify(recoveredAlert);

      const text = extractDeliveredText();
      expect(text).toContain('Environment Recovered');
      expect(text).toContain('acme / api / staging');
      expect(text).toContain('All pods are healthy');
    });

    it('formats generic alert type with message fallback', async () => {
      const service = buildFormattingService();
      await service.notify({
        severity: 'info',
        type: 'sentinel.startup',
        message: 'Platform Sentinel is now active.',
      });

      const text = extractDeliveredText();
      expect(text).toBe('Platform Sentinel is now active.');
    });

    it('formats generic alert without message field', async () => {
      const service = buildFormattingService();
      await service.notify({
        severity: 'info',
        type: 'sentinel.custom_event',
      });

      const text = extractDeliveredText();
      expect(text).toBe('Platform notification: sentinel.custom_event');
    });
  });
});
