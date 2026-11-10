import { describe, expect, it } from 'vitest';
import { CreatePrivateEndpointRequestSchema } from '../private-endpoint.js';

const base = { name: 'llm', hostname: 'gpu-box', port: 8080 };

function create(healthPath: string | null) {
  return CreatePrivateEndpointRequestSchema.safeParse({ ...base, health_path: healthPath });
}

describe('private endpoint health_path', () => {
  it.each(['/v1/models', '/health', '/healthz?full=1', '/a/b-c_d.json'])('accepts the path %s', (path) => {
    expect(create(path).success).toBe(true);
  });

  it('accepts null (health checks off) and defaults to /v1/models', () => {
    expect(create(null).success).toBe(true);
    const result = CreatePrivateEndpointRequestSchema.safeParse(base);
    expect(result.success && result.data.health_path).toBe('/v1/models');
  });

  it.each([
    ['userinfo that moves the host', '@169.254.169.254/latest/meta-data/'],
    ['a scheme-relative host', '//169.254.169.254/latest/meta-data/'],
    ['an absolute URL', 'http://169.254.169.254/latest/meta-data/'],
    ['a backslash', '\\\\169.254.169.254\\latest'],
    ['no leading slash', 'v1/models'],
    ['an at sign later in the path', '/v1/models@other-host'],
  ])('rejects %s', (_label, path) => {
    expect(create(path).success).toBe(false);
  });
});
