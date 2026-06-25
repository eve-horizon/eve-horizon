import { describe, it, expect } from 'vitest';
import { buildAppApiInstructionBlock, buildAppApiEnvVars, type AppApiInfo } from '../api-source.js';

describe('buildAppApiInstructionBlock', () => {
  it('returns empty string for empty array', () => {
    expect(buildAppApiInstructionBlock([])).toBe('');
  });

  it('generates instruction block with env var references', () => {
    const apis: AppApiInfo[] = [
      { name: 'api', type: 'openapi', base_url: 'http://localhost:3000' },
    ];
    const result = buildAppApiInstructionBlock(apis);

    expect(result).toContain('Available App APIs');
    expect(result).toContain('**api** (openapi)');
    expect(result).toContain('EVE_APP_API_URL_API');
    expect(result).toContain('EVE_JOB_TOKEN');
    expect(result).toContain('http://localhost:3000');
  });

  it('generates instruction block for multiple APIs', () => {
    const apis: AppApiInfo[] = [
      { name: 'api-one', type: 'openapi', base_url: 'http://svc-a:8080' },
      { name: 'api-two', type: 'postgrest', base_url: 'http://svc-b:3000' },
    ];
    const result = buildAppApiInstructionBlock(apis);

    expect(result).toContain('**api-one** (openapi)');
    expect(result).toContain('**api-two** (postgrest)');
    expect(result).toContain('EVE_APP_API_URL_API_ONE');
    expect(result).toContain('EVE_APP_API_URL_API_TWO');
  });

  it('starts with separator markdown', () => {
    const apis: AppApiInfo[] = [
      { name: 'test', type: 'openapi', base_url: 'http://test:80' },
    ];
    const result = buildAppApiInstructionBlock(apis);

    expect(result).toMatch(/^\n\n---\n/);
  });

  it('generates CLI-first instruction when cli info is present', () => {
    const apis: AppApiInfo[] = [
      {
        name: 'api',
        type: 'openapi',
        base_url: 'http://api.svc:3000',
        cli: { name: 'eden', bin: 'cli/bin/eden' },
      },
    ];
    const result = buildAppApiInstructionBlock(apis);

    expect(result).toContain('CLI: `eden`');
    expect(result).toContain('eden --help');
    expect(result).toContain('Fallback env var');
    expect(result).not.toContain('Or with fetch');
  });

  it('mixes CLI and non-CLI APIs', () => {
    const apis: AppApiInfo[] = [
      {
        name: 'api',
        type: 'openapi',
        base_url: 'http://api.svc:3000',
        cli: { name: 'eden', bin: 'cli/bin/eden' },
      },
      { name: 'db', type: 'postgrest', base_url: 'http://db.svc:3000' },
    ];
    const result = buildAppApiInstructionBlock(apis);

    expect(result).toContain('eden --help');
    expect(result).toContain('EVE_APP_API_URL_DB');
    expect(result).toContain('curl');
  });

  it('generates app link instruction block with link env vars', () => {
    const apis: AppApiInfo[] = [
      {
        name: 'events-api',
        type: 'openapi',
        origin: 'app_link',
        alias: 'analytics',
        base_url: 'http://events-api.producer.svc:3000',
        token: 'token-123',
        producer_project_id: 'producer-project',
      },
    ];
    const result = buildAppApiInstructionBlock(apis);

    expect(result).toContain('**analytics** (cross-project app link to producer-project)');
    expect(result).toContain('EVE_APP_LINK_ANALYTICS_API_URL');
    expect(result).toContain('EVE_APP_LINK_ANALYTICS_TOKEN');
    expect(result).not.toContain('EVE_JOB_TOKEN');
  });
});

describe('buildAppApiEnvVars', () => {
  it('returns empty object for empty array', () => {
    expect(buildAppApiEnvVars([])).toEqual({});
  });

  it('builds env vars from resolved APIs', () => {
    const apis: AppApiInfo[] = [
      { name: 'api', type: 'openapi', base_url: 'http://localhost:3000' },
    ];
    expect(buildAppApiEnvVars(apis)).toEqual({
      EVE_APP_API_URL_API: 'http://localhost:3000',
    });
  });

  it('uppercases and sanitizes service names', () => {
    const apis: AppApiInfo[] = [
      { name: 'my-api', type: 'openapi', base_url: 'http://a:80' },
      { name: 'web.service', type: 'openapi', base_url: 'http://b:80' },
    ];
    expect(buildAppApiEnvVars(apis)).toEqual({
      EVE_APP_API_URL_MY_API: 'http://a:80',
      EVE_APP_API_URL_WEB_SERVICE: 'http://b:80',
    });
  });

  it('skips APIs with empty base_url', () => {
    const apis: AppApiInfo[] = [
      { name: 'missing', type: 'openapi', base_url: '' },
      { name: 'ok', type: 'openapi', base_url: 'http://ok:80' },
    ];
    expect(buildAppApiEnvVars(apis)).toEqual({
      EVE_APP_API_URL_OK: 'http://ok:80',
    });
  });

  it('builds env vars for app links with aliases and tokens', () => {
    const apis: AppApiInfo[] = [
      {
        name: 'events-api',
        type: 'openapi',
        origin: 'app_link',
        alias: 'analytics',
        base_url: 'http://events-api.producer.svc:3000',
        token: 'token-123',
        scopes: ['events:read'],
        producer_project_id: 'producer-project',
        producer_env: 'prod',
        cli: { name: 'analytics-cli', bin: 'bin/analytics' },
      },
    ];

    expect(buildAppApiEnvVars(apis)).toEqual({
      EVE_APP_LINK_ANALYTICS_API_URL: 'http://events-api.producer.svc:3000',
      EVE_APP_LINK_ANALYTICS_CLI: 'analytics-cli',
      EVE_APP_LINK_ANALYTICS_ENV: 'prod',
      EVE_APP_LINK_ANALYTICS_PROJECT: 'producer-project',
      EVE_APP_LINK_ANALYTICS_SCOPES: 'events:read',
      EVE_APP_LINK_ANALYTICS_TOKEN: 'token-123',
    });
  });

  it('builds env vars for multiple app links with sanitized aliases', () => {
    const apis: AppApiInfo[] = [
      {
        name: 'observation-api',
        type: 'openapi',
        origin: 'app_link',
        alias: 'observation',
        base_url: 'http://observation.svc:3000',
        token: 'obs-token',
        scopes: ['observations:read', 'observations:write'],
        producer_project_id: 'proj_observation',
        producer_env: 'sandbox',
      },
      {
        name: 'observation-ingest-api',
        type: 'openapi',
        origin: 'app_link',
        alias: 'observation-ingest',
        base_url: 'http://observation-ingest.svc:3000',
        token: 'ingest-token',
        scopes: ['observations:write'],
        producer_project_id: 'proj_observation',
        producer_env: 'sandbox',
      },
    ];

    expect(buildAppApiEnvVars(apis)).toEqual({
      EVE_APP_LINK_OBSERVATION_API_URL: 'http://observation.svc:3000',
      EVE_APP_LINK_OBSERVATION_ENV: 'sandbox',
      EVE_APP_LINK_OBSERVATION_INGEST_API_URL: 'http://observation-ingest.svc:3000',
      EVE_APP_LINK_OBSERVATION_INGEST_ENV: 'sandbox',
      EVE_APP_LINK_OBSERVATION_INGEST_PROJECT: 'proj_observation',
      EVE_APP_LINK_OBSERVATION_INGEST_SCOPES: 'observations:write',
      EVE_APP_LINK_OBSERVATION_INGEST_TOKEN: 'ingest-token',
      EVE_APP_LINK_OBSERVATION_PROJECT: 'proj_observation',
      EVE_APP_LINK_OBSERVATION_SCOPES: 'observations:read,observations:write',
      EVE_APP_LINK_OBSERVATION_TOKEN: 'obs-token',
    });
  });
});
