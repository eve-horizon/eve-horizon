import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { CloudFsService } from './cloud-fs.service.js';
import type { CloudFsEntry, CloudFsProvider } from '@eve/shared';

function entry(overrides: Partial<CloudFsEntry>): CloudFsEntry {
  return {
    id: 'file_a',
    name: 'File.txt',
    path: '',
    mime_type: 'text/plain',
    size_bytes: 10,
    modified_at: '2026-06-02T00:00:00.000Z',
    web_url: 'https://example.com/file',
    is_folder: false,
    ...overrides,
  };
}

function mount() {
  return {
    id: 'mount_a',
    org_id: 'org_test',
    project_id: null,
    integration_id: 'integration_a',
    provider: 'google_drive',
    root_folder_id: 'root',
    root_folder_path: null,
    mode: 'read_write',
    auto_index: true,
    label: null,
    created_by: null,
    created_at: new Date('2026-06-02T00:00:00.000Z'),
    updated_at: new Date('2026-06-02T00:00:00.000Z'),
  };
}

function provider(overrides: Partial<CloudFsProvider> = {}): CloudFsProvider {
  return {
    providerName: 'google_drive',
    listFiles: vi.fn().mockResolvedValue({ entries: [] }),
    getFileMetadata: vi.fn(),
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
    moveFile: vi.fn(),
    createFolder: vi.fn(),
    deleteFile: vi.fn(),
    trashFile: vi.fn(),
    findFileByName: vi.fn().mockResolvedValue(null),
    updateFileContent: vi.fn(),
    searchFiles: vi.fn().mockResolvedValue({ entries: [] }),
    resolvePath: vi.fn(),
    buildPath: vi.fn().mockResolvedValue('/'),
    getChangesStartToken: vi.fn(),
    listChanges: vi.fn(),
    refreshAccessToken: vi.fn(),
    ...overrides,
  } as unknown as CloudFsProvider;
}

function createService(fakeProvider: CloudFsProvider) {
  const cloudFsService = Object.create(CloudFsService.prototype) as CloudFsService;
  const fakeMount = mount();

  (cloudFsService as any).mounts = {
    findById: vi.fn().mockResolvedValue(fakeMount),
    listByOrg: vi.fn().mockResolvedValue([fakeMount]),
  };
  (cloudFsService as any).integrations = {
    findById: vi.fn().mockResolvedValue({
      id: 'integration_a',
      tokens_json: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_date: Date.now() + 3_600_000,
      },
    }),
    updateTokens: vi.fn(),
  };
  (cloudFsService as any).oauthAppConfigs = {
    findByOrgAndProvider: vi.fn(),
  };
  (cloudFsService as any).providers = new Map([['google_drive', fakeProvider]]);

  return cloudFsService;
}

describe('CloudFsService pagination', () => {
  afterEach(() => {
    delete process.env.EVE_CLOUD_FS_MAX_RECURSIVE_ENTRIES;
    delete process.env.EVE_CLOUD_FS_MAX_RECURSIVE_DEPTH;
  });

  it('threads browse paging options and clamps page size', async () => {
    const fakeProvider = provider({
      listFiles: vi.fn().mockResolvedValue({
        entries: [entry({ id: 'file_a', name: 'A.txt' })],
        next_page_token: 'next',
      }),
    });
    const service = createService(fakeProvider);

    const result = await service.browse('org_test', 'mount_a', '/', {
      pageToken: 'cursor',
      pageSize: 5000,
      orderBy: 'name_desc',
    });

    expect(fakeProvider.listFiles).toHaveBeenCalledWith('access-token', 'root', {
      page_size: 1000,
      page_token: 'cursor',
      order_by: 'folder,name desc',
    });
    expect(result.entries[0]?.path).toBe('/A.txt');
    expect(result.next_page_token).toBe('next');
  });

  it('threads search MIME, paging, and order options', async () => {
    const fakeProvider = provider({
      searchFiles: vi.fn().mockResolvedValue({
        entries: [entry({ id: 'file_pdf', name: 'Budget.pdf', mime_type: 'application/pdf' })],
        next_page_token: 'search-next',
      }),
    });
    const service = createService(fakeProvider);

    const result = await service.search('org_test', 'mount_a', 'budget', {
      mimeType: 'application/pdf',
      pageToken: 'cursor',
      pageSize: 0,
      orderBy: 'modified_desc',
    });

    expect(fakeProvider.searchFiles).toHaveBeenCalledWith('access-token', 'root', 'budget', {
      page_size: 1,
      page_token: 'cursor',
      mime_type_filter: 'application/pdf',
      order_by: 'folder,modifiedTime desc',
    });
    expect(result.next_page_token).toBe('search-next');
  });

  it('walks folders recursively and maps full paths', async () => {
    const fakeProvider = provider({
      listFiles: vi.fn()
        .mockResolvedValueOnce({
          entries: [
            entry({ id: 'folder_a', name: 'Reports', mime_type: 'application/vnd.google-apps.folder', is_folder: true }),
            entry({ id: 'file_root', name: 'Root.txt' }),
          ],
        })
        .mockResolvedValueOnce({
          entries: [entry({ id: 'file_nested', name: 'Nested.txt' })],
        }),
    });
    const service = createService(fakeProvider);

    const result = await service.browse('org_test', 'mount_a', '/', { recursive: true, pageSize: 50 });

    expect(fakeProvider.listFiles).toHaveBeenNthCalledWith(1, 'access-token', 'root', { page_size: 50 });
    expect(fakeProvider.listFiles).toHaveBeenNthCalledWith(2, 'access-token', 'folder_a', { page_size: 50 });
    expect(result.entries.map((item) => item.path)).toEqual(['/Reports', '/Root.txt', '/Reports/Nested.txt']);
    expect(result.truncated).toBe(false);
  });

  it('marks recursive browse truncated when the entry cap is reached', async () => {
    process.env.EVE_CLOUD_FS_MAX_RECURSIVE_ENTRIES = '2';
    const fakeProvider = provider({
      listFiles: vi.fn().mockResolvedValue({
        entries: [
          entry({ id: 'folder_a', name: 'Reports', mime_type: 'application/vnd.google-apps.folder', is_folder: true }),
          entry({ id: 'file_root', name: 'Root.txt' }),
          entry({ id: 'file_extra', name: 'Extra.txt' }),
        ],
      }),
    });
    const service = createService(fakeProvider);

    const result = await service.browse('org_test', 'mount_a', '/', { recursive: true });

    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('derives display paths when browsing a folder id without a path', async () => {
    const fakeProvider = provider({
      buildPath: vi.fn().mockResolvedValue('/Reports'),
      listFiles: vi.fn().mockResolvedValue({
        entries: [entry({ id: 'file_q1', name: 'Q1.pdf', mime_type: 'application/pdf' })],
      }),
    });
    const service = createService(fakeProvider);

    const result = await service.browseMount('org_test', 'mount_a', 'folder_reports');

    expect(fakeProvider.buildPath).toHaveBeenCalledWith('access-token', 'folder_reports', 'root');
    expect(fakeProvider.listFiles).toHaveBeenCalledWith('access-token', 'folder_reports', {});
    expect(result.path).toBe('/Reports');
    expect(result.entries[0]?.path).toBe('/Reports/Q1.pdf');
  });
});

describe('CloudFsService upload-by-path and trash', () => {
  it('replaces an existing same-name file in place instead of creating a duplicate', async () => {
    const existing = entry({ id: 'file_existing', name: 'report.md', web_url: 'https://example.com/existing' });
    const fakeProvider = provider({
      resolvePath: vi.fn().mockResolvedValue('folder_inputs'),
      findFileByName: vi.fn().mockResolvedValue(existing),
      updateFileContent: vi.fn().mockResolvedValue({ ...existing, modified_at: '2026-09-04T00:00:00.000Z' }),
    });
    const service = createService(fakeProvider);

    const result = await service.uploadFile('org_test', 'mount_a', '/inputs/report.md', Buffer.from('v2'), 'text/markdown');

    expect(fakeProvider.findFileByName).toHaveBeenCalledWith('access-token', 'folder_inputs', 'report.md');
    expect(fakeProvider.updateFileContent).toHaveBeenCalledWith('access-token', 'file_existing', Buffer.from('v2'), 'text/markdown');
    expect(fakeProvider.uploadFile).not.toHaveBeenCalled();
    expect(result).toEqual({ file_id: 'file_existing', web_view_link: 'https://example.com/existing', replaced: true });
  });

  it('creates the file when no same-name sibling exists', async () => {
    const created = entry({ id: 'file_new', name: 'report.md', web_url: 'https://example.com/new' });
    const fakeProvider = provider({
      resolvePath: vi.fn().mockResolvedValue('folder_inputs'),
      findFileByName: vi.fn().mockResolvedValue(null),
      uploadFile: vi.fn().mockResolvedValue(created),
    });
    const service = createService(fakeProvider);

    const result = await service.uploadFile('org_test', 'mount_a', '/inputs/report.md', Buffer.from('v1'), 'text/markdown');

    expect(fakeProvider.uploadFile).toHaveBeenCalledWith('access-token', 'folder_inputs', 'report.md', Buffer.from('v1'), 'text/markdown');
    expect(fakeProvider.updateFileContent).not.toHaveBeenCalled();
    expect(result).toEqual({ file_id: 'file_new', web_view_link: 'https://example.com/new', replaced: false });
  });

  it('trashes a file through the provider, never permanently deleting it', async () => {
    const fakeProvider = provider({ trashFile: vi.fn().mockResolvedValue(undefined) });
    const service = createService(fakeProvider);

    await service.trashFile('org_test', 'mount_a', 'file_old');

    expect(fakeProvider.trashFile).toHaveBeenCalledWith('access-token', 'file_old');
    expect(fakeProvider.deleteFile).not.toHaveBeenCalled();
  });

  it('refuses to trash on a read-only mount', async () => {
    const fakeProvider = provider({ trashFile: vi.fn() });
    const service = createService(fakeProvider);
    (service as any).mounts.findById.mockResolvedValue({ ...mount(), mode: 'read_only' });

    await expect(service.trashFile('org_test', 'mount_a', 'file_old')).rejects.toBeInstanceOf(ForbiddenException);
    expect(fakeProvider.trashFile).not.toHaveBeenCalled();
  });
});
