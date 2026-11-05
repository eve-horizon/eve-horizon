import { describe, it, expect, vi } from 'vitest';
import {
  assertInternalApiKeyConfigured,
  logStartupConfigWarnings,
  registerCorrelationIdHook,
  registerInternalAuthHook,
  registerRawBodyJsonParser,
  type BootstrapFastifyInstance,
} from '../service-bootstrap';
import { CORRELATION_HEADER } from '../observability';
import {
  INTERNAL_TOKEN_HEADER,
  internalAuthHeaders,
  internalTokenMatches,
} from '../api-client/internal-fetch';

type Hook = (request: any, reply: any, done: () => void) => void;
type Parser = (req: any, body: string, done: (err: Error | null, value?: any) => void) => void;

function fakeFastify() {
  const hooks: Hook[] = [];
  const parsers = new Map<string, Parser>();
  const removed: string[] = [];
  const instance: BootstrapFastifyInstance = {
    addHook: (_name, hook) => hooks.push(hook),
    removeContentTypeParser: (contentType) => removed.push(contentType),
    addContentTypeParser: (contentType, _options, parser) => parsers.set(contentType, parser),
  };
  return { instance, hooks, parsers, removed };
}

describe('service-bootstrap', () => {
  describe('registerCorrelationIdHook', () => {
    it('reuses the incoming correlation header and echoes it on the reply', () => {
      const { instance, hooks } = fakeFastify();
      registerCorrelationIdHook(instance);
      expect(hooks).toHaveLength(1);

      const request: any = { headers: { [CORRELATION_HEADER]: 'corr-123' } };
      const header = vi.fn();
      const done = vi.fn();
      hooks[0](request, { header }, done);

      expect(request.correlationId).toBe('corr-123');
      expect(header).toHaveBeenCalledWith(CORRELATION_HEADER, 'corr-123');
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('mints a correlation id when none is provided', () => {
      const { instance, hooks } = fakeFastify();
      registerCorrelationIdHook(instance);

      const request: any = { headers: {} };
      const header = vi.fn();
      hooks[0](request, { header }, vi.fn());

      expect(typeof request.correlationId).toBe('string');
      expect(request.correlationId.length).toBeGreaterThan(0);
      expect(header).toHaveBeenCalledWith(CORRELATION_HEADER, request.correlationId);
    });
  });

  describe('registerRawBodyJsonParser', () => {
    it('replaces both JSON parsers and keeps the raw body on the request', () => {
      const { instance, parsers, removed } = fakeFastify();
      registerRawBodyJsonParser(instance);

      expect(removed).toEqual(['application/json', 'application/*+json']);
      expect([...parsers.keys()]).toEqual(['application/json', 'application/*+json']);

      const req: any = {};
      const done = vi.fn();
      parsers.get('application/json')!(req, '{"a":1}', done);
      expect(req.rawBody).toBe('{"a":1}');
      expect(done).toHaveBeenCalledWith(null, { a: 1 });
    });

    it('parses an empty body as an empty object', () => {
      const { instance, parsers } = fakeFastify();
      registerRawBodyJsonParser(instance);

      const done = vi.fn();
      parsers.get('application/json')!({}, '', done);
      expect(done).toHaveBeenCalledWith(null, {});
    });

    it('propagates JSON parse errors', () => {
      const { instance, parsers } = fakeFastify();
      registerRawBodyJsonParser(instance);

      const done = vi.fn();
      parsers.get('application/json')!({}, 'not-json', done);
      expect(done).toHaveBeenCalledTimes(1);
      expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
    });
  });

  describe('logStartupConfigWarnings', () => {
    it('warns with the service label when core env vars are missing', () => {
      const savedKey = process.env.EVE_INTERNAL_API_KEY;
      const savedUrl = process.env.EVE_API_URL;
      delete process.env.EVE_INTERNAL_API_KEY;
      delete process.env.EVE_API_URL;
      try {
        const warn = vi.fn();
        logStartupConfigWarnings({ warn }, 'WORKER');
        expect(warn).toHaveBeenCalledWith('WORKER CONFIGURATION WARNINGS:');
        expect(warn).toHaveBeenCalledTimes(3);
      } finally {
        if (savedKey !== undefined) process.env.EVE_INTERNAL_API_KEY = savedKey;
        if (savedUrl !== undefined) process.env.EVE_API_URL = savedUrl;
      }
    });

    it('stays silent when core env vars are present', () => {
      const savedKey = process.env.EVE_INTERNAL_API_KEY;
      const savedUrl = process.env.EVE_API_URL;
      process.env.EVE_INTERNAL_API_KEY = 'key';
      process.env.EVE_API_URL = 'http://api.test';
      try {
        const warn = vi.fn();
        logStartupConfigWarnings({ warn }, 'ORCHESTRATOR');
        expect(warn).not.toHaveBeenCalled();
      } finally {
        if (savedKey !== undefined) process.env.EVE_INTERNAL_API_KEY = savedKey;
        else delete process.env.EVE_INTERNAL_API_KEY;
        if (savedUrl !== undefined) process.env.EVE_API_URL = savedUrl;
        else delete process.env.EVE_API_URL;
      }
    });
  });

  describe('internalTokenMatches', () => {
    it('matches only the exact configured key', () => {
      expect(internalTokenMatches('secret-key', 'secret-key')).toBe(true);
      expect(internalTokenMatches('secret-kez', 'secret-key')).toBe(false);
      expect(internalTokenMatches('secret-key-longer', 'secret-key')).toBe(false);
      expect(internalTokenMatches('secret', 'secret-key')).toBe(false);
    });

    it('fails closed when the key is unset or the token is missing or not a string', () => {
      expect(internalTokenMatches('anything', undefined)).toBe(false);
      expect(internalTokenMatches('', '')).toBe(false);
      expect(internalTokenMatches(undefined, 'secret-key')).toBe(false);
      expect(internalTokenMatches('', 'secret-key')).toBe(false);
      expect(internalTokenMatches(['secret-key'], 'secret-key')).toBe(false);
    });
  });

  describe('internalAuthHeaders', () => {
    it('sends the internal token header when a key is configured', () => {
      expect(internalAuthHeaders('secret-key')).toEqual({ [INTERNAL_TOKEN_HEADER]: 'secret-key' });
    });

    it('sends nothing when no key is configured', () => {
      expect(internalAuthHeaders('')).toEqual({});
    });
  });

  describe('registerInternalAuthHook', () => {
    function runHook(options: Parameters<typeof registerInternalAuthHook>[1], request: any) {
      const { instance, hooks } = fakeFastify();
      registerInternalAuthHook(instance, options);
      expect(hooks).toHaveLength(1);
      const reply = { code: vi.fn(), send: vi.fn() };
      reply.code.mockReturnValue(reply);
      const done = vi.fn();
      hooks[0](request, reply, done);
      return { reply, done };
    }

    it('refuses a request with no token', () => {
      const { reply, done } = runHook({ key: 'secret-key' }, { url: '/invoke', headers: {} });
      expect(done).not.toHaveBeenCalled();
      expect(reply.code).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 401, message: 'Missing or invalid internal token' }),
      );
    });

    it('refuses a request with the wrong token', () => {
      const { reply, done } = runHook(
        { key: 'secret-key' },
        { url: '/deploy', headers: { [INTERNAL_TOKEN_HEADER]: 'wrong-key' } },
      );
      expect(done).not.toHaveBeenCalled();
      expect(reply.code).toHaveBeenCalledWith(401);
    });

    it('passes a request with the right token', () => {
      const { reply, done } = runHook(
        { key: 'secret-key' },
        { url: '/scripts/execute', headers: { [INTERNAL_TOKEN_HEADER]: 'secret-key' } },
      );
      expect(done).toHaveBeenCalledTimes(1);
      expect(reply.code).not.toHaveBeenCalled();
    });

    it('leaves the health probe open, with or without a query string', () => {
      for (const url of ['/health', '/health?probe=readiness']) {
        const { reply, done } = runHook({ key: 'secret-key' }, { url, headers: {} });
        expect(done).toHaveBeenCalledTimes(1);
        expect(reply.code).not.toHaveBeenCalled();
      }
    });

    it('protects every other spelling of the health path', () => {
      for (const url of ['/health/', '/healthz', '//health', '/health/../invoke', '/%68ealth']) {
        const { reply, done } = runHook({ key: 'secret-key' }, { url, headers: {} });
        expect(done).not.toHaveBeenCalled();
        expect(reply.code).toHaveBeenCalledWith(401);
      }
    });

    it('fails closed when no key is configured, but keeps the health probe open', () => {
      const refused = runHook({ key: '' }, { url: '/invoke', headers: { [INTERNAL_TOKEN_HEADER]: '' } });
      expect(refused.done).not.toHaveBeenCalled();
      expect(refused.reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Internal API key not configured' }),
      );

      const health = runHook({ key: '' }, { url: '/health', headers: {} });
      expect(health.done).toHaveBeenCalledTimes(1);
    });

    it('reads EVE_INTERNAL_API_KEY when no key is passed', () => {
      vi.stubEnv('EVE_INTERNAL_API_KEY', 'env-key');
      try {
        const { done } = runHook({}, { url: '/invoke', headers: { [INTERNAL_TOKEN_HEADER]: 'env-key' } });
        expect(done).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('assertInternalApiKeyConfigured', () => {
    it('refuses to start in production without the key', () => {
      const warn = vi.fn();
      expect(() =>
        assertInternalApiKeyConfigured({ warn }, 'WORKER', { NODE_ENV: 'production' }),
      ).toThrow(/EVE_INTERNAL_API_KEY is not set.*Refusing to start/);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns outside production without the key', () => {
      const warn = vi.fn();
      assertInternalApiKeyConfigured({ warn }, 'AGENT_RUNTIME', { NODE_ENV: 'development' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('AGENT_RUNTIME: EVE_INTERNAL_API_KEY is not set'));
    });

    it('is silent when the key is set', () => {
      const warn = vi.fn();
      assertInternalApiKeyConfigured({ warn }, 'WORKER', {
        NODE_ENV: 'production',
        EVE_INTERNAL_API_KEY: 'secret-key',
      });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
