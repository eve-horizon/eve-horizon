import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  threads: { findById: vi.fn() },
  messages: {
    create: vi.fn(),
    createOutbound: vi.fn(),
    updateDeliveryStatus: vi.fn(),
    updateDeliveryStatusById: vi.fn(),
  },
}));

vi.mock('@eve/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/db')>()),
  threadQueries: vi.fn(() => mocks.threads),
  threadMessageQueries: vi.fn(() => mocks.messages),
}));

import { ChatService } from './chat.service';

const THREADS: Record<string, { id: string; project_id: string; key: string; metadata_json: Record<string, string> }> = {
  thr_own: {
    id: 'thr_own',
    project_id: 'proj_a',
    key: 'slack:T1:C1',
    metadata_json: { provider: 'slack', account_id: 'T1', channel_id: 'C1', thread_id: '1.2' },
  },
  thr_other: {
    id: 'thr_other',
    project_id: 'proj_b',
    key: 'slack:T2:C2',
    metadata_json: { provider: 'slack', account_id: 'T2', channel_id: 'C2', thread_id: '3.4' },
  },
};

describe('ChatService.deliverChatResult thread ownership', () => {
  const fetchMock = vi.fn();
  let service: ChatService;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_GATEWAY_URL = 'http://gateway.test';
    process.env.EVE_INTERNAL_API_KEY = 'internal-key';
    mocks.threads.findById.mockImplementation(async (id: string) => THREADS[id] ?? null);
    mocks.messages.createOutbound.mockResolvedValue({ id: 'msg_out' });
    mocks.messages.create.mockResolvedValue({ id: 'msg_progress' });
    mocks.messages.updateDeliveryStatus.mockResolvedValue(undefined);
    mocks.messages.updateDeliveryStatusById.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    service = new ChatService((() => []) as never, {} as never, {} as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "does not write to or forward from another project's thread (progress=%s)",
    async (progress) => {
      const result = await service.deliverChatResult({
        projectId: 'proj_a',
        job_id: 'alpha-1',
        thread_id: 'thr_other',
        text: 'result text',
        progress,
      });

      expect(result.delivered).toBe(false);
      expect(mocks.messages.createOutbound).not.toHaveBeenCalled();
      expect(mocks.messages.create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("delivers to the job's own project thread", async () => {
    const result = await service.deliverChatResult({
      projectId: 'proj_a',
      job_id: 'alpha-1',
      thread_id: 'thr_own',
      text: 'result text',
    });

    expect(result).toMatchObject({ delivered: true, message_id: 'msg_out' });
    expect(mocks.messages.createOutbound).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'thr_own' }));
    expect(fetchMock).toHaveBeenCalledWith('http://gateway.test/internal/deliver', expect.anything());
  });
});
