import { describe, expect, it } from 'vitest';
import { internalRouteProxyHooks, isInternalApiPath } from '../server/internal-api-guard.js';

describe('isInternalApiPath', () => {
  it('matches /api/internal however it is spelled', () => {
    for (const path of [
      '/api/internal',
      '/api/internal/x?y=/z',
      '/api/%2F%2Finternal/x',
      '/api/%25%36%39nternal/x',
      '/api/x/./../INTERNAL/y',
    ]) {
      expect(isInternalApiPath(path), path).toBe(true);
    }
  });

  it('refuses a path still changing after five rounds of decoding', () => {
    let encoded = 'i';
    for (let i = 0; i < 6; i += 1) encoded = encodeURIComponent(encoded).replace('i', '%69');
    expect(isInternalApiPath(`/api/${encoded}nternal/x`)).toBe(true);
  });

  it('leaves other paths alone', () => {
    for (const path of [
      '/',
      '/jobs',
      '/internal',
      '/api',
      '/api/jobs?filter=/api/internal',
      '/api/internalize',
      '/apps/internal',
      '/api/orgs/o1/files/50%25off.txt',
      '/api/docs/100%2525%2520off',
      '/api/files/%E0%A4%A',
    ]) {
      expect(isInternalApiPath(path), path).toBe(false);
    }
  });
});

function fakeProxyReq(path) {
  return { path, destroyed: null, destroy(error) { this.destroyed = error; } };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    setHeader() {},
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(body) { this.body = body; this.headersSent = true; },
  };
}

describe('internalRouteProxyHooks', () => {
  it('drops upstream requests under the API /internal and answers them 404', () => {
    const hooks = internalRouteProxyHooks('http://eve-api:4701');
    for (const path of ['/internal', '/internal/x?y=1', '/%69nternal/x', '/INTERNAL/x', '/x/../internal/y', '/internal/../../x']) {
      const proxyReq = fakeProxyReq(path);
      hooks.proxyReq(proxyReq);
      expect(proxyReq.destroyed, path).toBeInstanceOf(Error);
      const res = fakeResponse();
      hooks.error(proxyReq.destroyed, {}, res);
      expect(res.statusCode, path).toBe(404);
    }
  });

  it('lets other upstream paths through', () => {
    const hooks = internalRouteProxyHooks('http://eve-api:4701/');
    for (const path of ['/auth/me', '/internalize', '/projects/internal', '/orgs/o1/jobs?q=/internal/x', '/orgs/o1/files/50%25off.txt']) {
      const proxyReq = fakeProxyReq(path);
      hooks.proxyReq(proxyReq);
      expect(proxyReq.destroyed, path).toBeNull();
    }
  });

  it('measures /internal from the target path', () => {
    const hooks = internalRouteProxyHooks('http://eve-api:4701/v1');
    const inside = fakeProxyReq('/v1/internal/x');
    hooks.proxyReq(inside);
    expect(inside.destroyed).toBeInstanceOf(Error);
  });

  it('answers other proxy failures like the library default', () => {
    const { error } = internalRouteProxyHooks('http://eve-api:4701');
    for (const [code, status] of [['ECONNREFUSED', 504], ['ETIMEDOUT', 504], ['HPE_INVALID_CONSTANT', 502], ['EOTHER', 500]]) {
      const res = fakeResponse();
      error(Object.assign(new Error(code), { code }), {}, res);
      expect(res.statusCode, code).toBe(status);
    }
    const streaming = { ...fakeResponse(), headersSent: true, writeHead: () => { throw new Error('headers already sent'); } };
    error(Object.assign(new Error('reset'), { code: 'ECONNRESET' }), {}, streaming);
  });
});
