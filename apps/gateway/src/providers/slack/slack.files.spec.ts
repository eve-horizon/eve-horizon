import type { ChatFile, FileResolveContext } from '@eve/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./slack-sender.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./slack-sender.js')>()),
  getIntegrationTokens: vi.fn(async () => ({ access_token: 'xoxb-test' })),
}));

import { SlackGatewayProvider } from './slack.provider.js';

const UPLOAD_URL = 'https://storage.test/upload';

function file(url: string, extra: Partial<ChatFile> = {}): ChatFile {
  return { id: 'F123', name: 'notes.txt', mimetype: 'text/plain', url, ...extra } as ChatFile;
}

const context: FileResolveContext = {
  orgId: 'org_workspace',
  channelId: 'C_CHAN',
  messageTs: '1700000000.000100',
  accountId: 'T_WORKSPACE',
  provider: 'slack',
  getUploadUrl: async () => UPLOAD_URL,
};

/** A body of `bytes` bytes streamed in 1 MiB chunks, with no content-length. */
function streamOf(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.length, bytes - sent);
      controller.enqueue(chunk.subarray(0, size));
      sent += size;
    },
  });
}

describe('Slack file downloads', () => {
  const fetchMock = vi.fn();
  let provider: SlackGatewayProvider;

  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === UPLOAD_URL) return new Response(null, { status: 200 });
      if (init?.method === undefined || init.method === 'GET') {
        return new Response('file body', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    provider = new SlackGatewayProvider();
    await provider.initialize({
      integration: { id: 'int_workspace' } as never,
      settings: { signing_secret: 'secret' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fetchedUrls(): string[] {
    return fetchMock.mock.calls.map(([input]) => String(input));
  }

  it.each([
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://eve-api.eve.svc.cluster.local:4701/internal/integrations/active',
    'http://127.0.0.1:4820/internal/deliver',
    'http://files.slack.com/files-pri/T1-F1/notes.txt',
    'https://files.slack.com.example.com/files-pri/T1-F1/notes.txt',
    'https://example.com/files-pri/T1-F1/notes.txt',
    'https://user@files.slack.com:8443/files-pri/T1-F1/notes.txt',
  ])('does not fetch a file URL outside Slack\'s file host (%s)', async (url) => {
    const [resolved] = await provider.resolveFiles([file(url)], context);

    expect(fetchedUrls()).toEqual([]);
    expect(resolved.url).not.toMatch(/^eve-storage:\/\//);
  });

  it('fetches a files.slack.com URL with the bot token and stores it', async () => {
    const url = 'https://files.slack.com/files-pri/T1-F1/notes.txt';

    const [resolved] = await provider.resolveFiles([file(url)], context);

    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({
      headers: { Authorization: 'Bearer xoxb-test' },
      redirect: 'manual',
    }));
    expect(fetchedUrls()).toContain(UPLOAD_URL);
    expect(resolved.url).toMatch(/^eve-storage:\/\/chat-attachments\/org_workspace\//);
  });

  it('does not store a download larger than the per-file limit, whatever size the event declared', async () => {
    const url = 'https://files.slack.com/files-pri/T1-F1/big.bin';
    fetchMock.mockImplementation(async (input: string) => {
      if (input === UPLOAD_URL) return new Response(null, { status: 200 });
      return new Response(streamOf(51 * 1024 * 1024), { status: 200 });
    });

    const [resolved] = await provider.resolveFiles([file(url, { size: 10 })], context);

    expect(fetchedUrls()).not.toContain(UPLOAD_URL);
    expect(resolved.url).not.toMatch(/^eve-storage:\/\//);
  });
});
