import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveApiError, GoogleDriveProvider } from '../google-drive-provider.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

interface DriveNode {
  mimeType?: string;
  parents?: string[];
  shortcutDetails?: { targetId: string };
}

/** Last path segment of a Drive files.get URL, i.e. the requested file id. */
function requestedId(input: unknown): string {
  const url = new URL(String(input));
  return decodeURIComponent(url.pathname.split('/').pop() ?? '');
}

/**
 * Stub Drive with an in-memory graph. `files.get` on an id in the graph returns
 * that node; any other id is a 404. `files.list` returns `listed`.
 */
function stubDrive(graph: Record<string, DriveNode>, listed: Array<{ id: string; name: string }> = []) {
  const fetchSpy = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/files')) {
      return { ok: true, status: 200, json: async () => ({ files: listed }) } as unknown as Response;
    }
    const id = requestedId(input);
    const node = graph[id];
    if (!node) {
      return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id, mimeType: node.mimeType ?? FOLDER_MIME, parents: node.parents }),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchSpy);
  return {
    fetchSpy,
    fetchedIds: () => fetchSpy.mock.calls.map(([input]) => requestedId(input)),
  };
}

/** A straight chain n0 -> n1 -> ... -> n{length-1} -> `top`. */
function chain(length: number, top: string): Record<string, DriveNode> {
  const graph: Record<string, DriveNode> = {};
  for (let i = 0; i < length; i++) {
    graph[`n${i}`] = { parents: [i + 1 < length ? `n${i + 1}` : top] };
  }
  return graph;
}

describe('GoogleDriveProvider.isWithinRoot', () => {
  const provider = new GoogleDriveProvider();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a file whose parent chain reaches the root', async () => {
    const drive = stubDrive({
      file: { mimeType: 'text/plain', parents: ['reports'] },
      reports: { parents: ['root_folder'] },
      root_folder: { parents: ['my_drive'] },
    });

    await expect(provider.isWithinRoot('token', 'file', 'root_folder')).resolves.toBe(true);
    // The root is recognised in a parents list, so the root itself is never fetched.
    expect(drive.fetchedIds()).toEqual(['file', 'reports']);
  });

  it('rejects a file whose parent chain never reaches the root', async () => {
    stubDrive({
      file: { mimeType: 'text/plain', parents: ['elsewhere'] },
      elsewhere: { parents: ['my_drive'] },
      my_drive: {},
    });

    await expect(provider.isWithinRoot('token', 'file', 'root_folder')).resolves.toBe(false);
  });

  it('accepts the root itself without calling Drive', async () => {
    const drive = stubDrive({});

    await expect(provider.isWithinRoot('token', 'root_folder', 'root_folder')).resolves.toBe(true);
    expect(drive.fetchSpy).not.toHaveBeenCalled();
  });

  it('follows every parent, not just the first', async () => {
    stubDrive({
      file: { mimeType: 'text/plain', parents: ['other_tree', 'in_root'] },
      other_tree: { parents: ['my_drive'] },
      my_drive: {},
      in_root: { parents: ['root_folder'] },
    });

    await expect(provider.isWithinRoot('token', 'file', 'root_folder')).resolves.toBe(true);
  });

  it('terminates on a parent cycle', async () => {
    const drive = stubDrive({
      file: { mimeType: 'text/plain', parents: ['a'] },
      a: { parents: ['b'] },
      b: { parents: ['a'] },
    });

    await expect(provider.isWithinRoot('token', 'file', 'root_folder')).resolves.toBe(false);
    expect(drive.fetchedIds()).toEqual(['file', 'a', 'b']);
  });

  it('finds a root exactly at the depth cap', async () => {
    stubDrive(chain(64, 'root_folder'));

    await expect(provider.isWithinRoot('token', 'n0', 'root_folder')).resolves.toBe(true);
  });

  it('gives up on a chain deeper than the cap', async () => {
    const drive = stubDrive(chain(200, 'root_folder'));

    await expect(provider.isWithinRoot('token', 'n0', 'root_folder')).resolves.toBe(false);
    // The target plus 64 generations of ancestors, and not one more.
    expect(drive.fetchSpy).toHaveBeenCalledTimes(65);
  });

  it('rejects a shortcut inside the root and never follows its target', async () => {
    const drive = stubDrive({
      link: { mimeType: SHORTCUT_MIME, parents: ['root_folder'], shortcutDetails: { targetId: 'secret' } },
      secret: { mimeType: 'text/plain', parents: ['elsewhere'] },
    });

    await expect(provider.isWithinRoot('token', 'link', 'root_folder')).resolves.toBe(false);
    expect(drive.fetchedIds()).toEqual(['link']);
  });

  it('treats the whole-drive alias as containing anything readable, after one lookup', async () => {
    const drive = stubDrive({
      file: { mimeType: 'text/plain', parents: ['deep'] },
      deep: { parents: ['deeper'] },
    });

    await expect(provider.isWithinRoot('token', 'file', 'root')).resolves.toBe(true);
    expect(drive.fetchedIds()).toEqual(['file']);
  });

  it('still rejects a shortcut under the whole-drive alias', async () => {
    stubDrive({ link: { mimeType: SHORTCUT_MIME, parents: ['my_drive'] } });

    await expect(provider.isWithinRoot('token', 'link', 'root')).resolves.toBe(false);
  });

  it('surfaces a Drive error when the target itself is unreadable', async () => {
    stubDrive({});

    await expect(provider.isWithinRoot('token', 'missing', 'root_folder')).rejects.toBeInstanceOf(DriveApiError);
  });

  it('treats an unreadable ancestor as a dead end rather than an error', async () => {
    stubDrive({ file: { mimeType: 'text/plain', parents: ['private_folder'] } });

    await expect(provider.isWithinRoot('token', 'file', 'root_folder')).resolves.toBe(false);
  });
});

describe('GoogleDriveProvider.searchFiles', () => {
  const provider = new GoogleDriveProvider();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps only results that lie within the root', async () => {
    stubDrive(
      {
        inside: { mimeType: 'text/plain', parents: ['root_folder'] },
        outside: { mimeType: 'text/plain', parents: ['elsewhere'] },
        elsewhere: { parents: ['my_drive'] },
        my_drive: {},
      },
      [
        { id: 'inside', name: 'budget-in.txt' },
        { id: 'outside', name: 'budget-out.txt' },
      ],
    );

    const result = await provider.searchFiles('token', 'root_folder', 'budget');

    expect(result.entries.map((entry) => entry.id)).toEqual(['inside']);
  });
});
