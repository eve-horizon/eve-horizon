import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCloudFs } from '../src/commands/cloud-fs';
import { requestJson } from '../src/lib/client';
import type { ResolvedContext } from '../src/lib/context';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
}));

const requestJsonMock = vi.mocked(requestJson);

const context: ResolvedContext = {
  apiUrl: 'https://api.example.test',
  orgId: 'org_test',
  profileName: 'default',
  profile: {},
  authKey: 'test',
  profileSource: 'default',
};

const fileEntry = {
  id: 'file_a',
  name: 'A.txt',
  path: '/A.txt',
  mime_type: 'text/plain',
  size_bytes: 10,
  modified_at: '2026-06-02T00:00:00.000Z',
  web_url: 'https://example.test/A.txt',
  is_folder: false,
};

describe('cloud-fs command paging', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    requestJsonMock.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('passes manual browse paging flags and prints a next-page hint', async () => {
    requestJsonMock.mockResolvedValue({
      mount_id: 'mount_a',
      path: '/',
      entries: [],
      next_page_token: 'next',
    });

    await handleCloudFs('ls', ['/'], { 'page-size': '2', 'order-by': 'name' }, context);

    const url = requestJsonMock.mock.calls[0]?.[1] as string;
    expect(url).toContain('/orgs/org_test/cloud-fs/browse?');
    expect(url).toContain('path=%2F');
    expect(url).toContain('page_size=2');
    expect(url).toContain('order_by=name');
    expect(errorSpy.mock.calls.map((call) => call[0]).join('\n')).toContain('--page-token next');
  });

  it('merges browse pages for json --all output', async () => {
    requestJsonMock
      .mockResolvedValueOnce({
        mount_id: 'mount_a',
        path: '/',
        entries: [fileEntry],
        next_page_token: 'next',
      })
      .mockResolvedValueOnce({
        mount_id: 'mount_a',
        path: '/',
        entries: [{ ...fileEntry, id: 'file_b', name: 'B.txt', path: '/B.txt' }],
      });

    await handleCloudFs('ls', ['/'], { all: true, json: true, 'page-size': '1' }, context);

    const secondUrl = requestJsonMock.mock.calls[1]?.[1] as string;
    expect(secondUrl).toContain('page_token=next');
    const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(output.entries).toHaveLength(2);
    expect(output.complete).toBe(true);
    expect(output.page_count).toBe(2);
  });

  it('marks json --all browse incomplete at the auto-page cap', async () => {
    vi.stubEnv('EVE_CLOUD_FS_MAX_AUTO_PAGES', '1');
    requestJsonMock.mockResolvedValueOnce({
      mount_id: 'mount_a',
      path: '/',
      entries: [fileEntry],
      next_page_token: 'next',
    });

    await handleCloudFs('ls', ['/'], { all: true, json: true }, context);

    const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(output.complete).toBe(false);
    expect(output.next_page_token).toBe('next');
    expect(output.page_count).toBe(1);
    expect(errorSpy.mock.calls.map((call) => call[0]).join('\n')).toContain('resume with --page-token next');
  });

  it('rejects recursive browse with incompatible paging flags', async () => {
    await expect(handleCloudFs('ls', ['-r', '/'], { all: true }, context)).rejects.toThrow('--recursive cannot be used with --all');
    await expect(handleCloudFs('ls', ['/'], { recursive: true, 'page-token': 'next' }, context)).rejects.toThrow('--recursive cannot be used with --page-token');
  });

  it('sends recursive browse requests with the short -r alias', async () => {
    requestJsonMock.mockResolvedValue({
      mount_id: 'mount_a',
      path: '/Docs',
      entries: [],
      truncated: false,
    });

    await handleCloudFs('ls', ['-r', '/Docs'], {}, context);

    const url = requestJsonMock.mock.calls[0]?.[1] as string;
    expect(url).toContain('path=%2FDocs');
    expect(url).toContain('recursive=true');
  });

  it('continues search --all through empty pages with tokens', async () => {
    requestJsonMock
      .mockResolvedValueOnce({
        mount_id: 'mount_a',
        entries: [],
        next_page_token: 'empty-next',
      })
      .mockResolvedValueOnce({
        mount_id: 'mount_a',
        entries: [fileEntry],
      });

    await handleCloudFs('search', ['budget'], {
      all: true,
      json: true,
      'mime-type': 'application/pdf',
    }, context);

    const firstUrl = requestJsonMock.mock.calls[0]?.[1] as string;
    const secondUrl = requestJsonMock.mock.calls[1]?.[1] as string;
    expect(firstUrl).toContain('mime_type=application%2Fpdf');
    expect(secondUrl).toContain('page_token=empty-next');
    const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(output.entries).toHaveLength(1);
    expect(output.complete).toBe(true);
    expect(output.page_count).toBe(2);
  });
});
