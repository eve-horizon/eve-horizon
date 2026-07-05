import { describe, it, expect, vi } from 'vitest';
import {
  logStartupConfigWarnings,
  registerCorrelationIdHook,
  registerRawBodyJsonParser,
  type BootstrapFastifyInstance,
} from '../service-bootstrap';
import { CORRELATION_HEADER } from '../observability';

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
});
