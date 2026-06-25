import { describe, expect, it, vi } from 'vitest';
import { createConversationClient } from '../src/index.js';

describe('createConversationClient', () => {
  it('sends bearer-authenticated ensure and turn requests', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (String(url).endsWith('/conversations')) {
        expect(init?.method).toBe('POST');
        expect((init?.headers as Headers).get('authorization')).toBe('Bearer test-token');
        expect(body.app_key).toBe('app:conv');
        return Response.json({
          thread_id: 'thr_1',
          key: 'app:designer:sha256:x',
          app_key: 'app:conv',
          app_id: 'designer',
          metadata: {},
          current_target: null,
        });
      }
      expect(String(url)).toContain('/conversations/app%3Aconv/turns');
      expect(body.text).toBe('hello');
      return Response.json({
        thread_id: 'thr_1',
        thread_key: 'app:designer:sha256:x',
        route_id: null,
        target: 'agent:designer',
        job_ids: ['job_1'],
        event_id: 'evt_1',
        app_key: 'app:conv',
        app_id: 'designer',
        dispatch_status: 'queued',
      });
    });

    const client = createConversationClient({
      baseUrl: 'https://api.example.com',
      projectId: 'proj_1',
      appKey: 'app:conv',
      appId: 'designer',
      getToken: () => 'test-token',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.ensure()).resolves.toMatchObject({ thread_id: 'thr_1' });
    await expect(client.send('hello')).resolves.toMatchObject({ job_ids: ['job_1'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lists and emits structured conversation events', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(String(url)).toContain('/conversations/app%3Aconv/events?app_id=app-one');
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        expect(body.kind).toBe('artifact.update');
        return Response.json({
          id: 'cevt_2',
          cursor: '2',
          seq: 2,
          thread_id: 'thr_1',
          kind: 'artifact.update',
          source: 'app',
          payload: { artifact_id: 'artifact_1' },
          created_at: new Date(0).toISOString(),
        });
      }

      expect(String(url)).toContain('/conversations/app%3Aconv/events?app_id=app-one&kind=artifact.update&limit=10');
      return Response.json({
        events: [{
          id: 'cevt_1',
          cursor: '1',
          seq: 1,
          thread_id: 'thr_1',
          kind: 'artifact.update',
          source: 'app',
          payload: {},
          created_at: new Date(0).toISOString(),
        }],
      });
    });

    const client = createConversationClient({
      baseUrl: 'https://api.example.com',
      projectId: 'proj_1',
      appKey: 'app:conv',
      appId: 'app-one',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.events({ kind: 'artifact.update', limit: 10 })).resolves.toMatchObject({
      events: [{ kind: 'artifact.update' }],
    });
    await expect(client.emitEvent({
      kind: 'artifact.update',
      payload: { artifact_id: 'artifact_1' },
    })).resolves.toMatchObject({ cursor: '2' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
