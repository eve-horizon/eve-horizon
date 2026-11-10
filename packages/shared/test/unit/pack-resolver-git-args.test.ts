import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { execSyncMock, execFileSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: execSyncMock, execFileSync: execFileSyncMock };
});

// Keep the pack cache out of the real home directory.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const home = path.join(actual.tmpdir(), `eve-pack-resolver-home-${process.pid}`);
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

import * as os from 'node:os';
import { resolvePack } from '../../src/lib/pack-resolver.js';

function gitCalls(): string[][] {
  return execFileSyncMock.mock.calls
    .filter(([file]) => file === 'git')
    .map(([, args]) => args as string[]);
}

beforeEach(() => {
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();
  execSyncMock.mockReturnValue(Buffer.from(''));
  execFileSyncMock.mockReturnValue(Buffer.from(''));
});

afterAll(() => {
  fs.rmSync(os.homedir(), { recursive: true, force: true });
});

describe('pack-resolver: remote pack sources reach git as single arguments', () => {
  test('passes the pack URL and ref to git with no shell', async () => {
    const source = 'https://github.com/org/pack$(touch eve-pack-marker);touch eve-pack-marker';
    const ref = 'ref$(touch eve-pack-marker)';

    // The fake git fetches nothing, so resolving the empty checkout may fail; only the git calls matter.
    await resolvePack({ source, ref }, 'proj').catch(() => undefined);

    const remoteAdd = gitCalls().find((args) => args.includes('remote') && args.includes('add'));
    expect(remoteAdd).toBeDefined();
    expect(remoteAdd).toContain(source);
    expect(remoteAdd!.indexOf('--')).toBeGreaterThan(-1);
    expect(remoteAdd!.indexOf('--')).toBeLessThan(remoteAdd!.indexOf(source));

    const fetch = gitCalls().find((args) => args.includes('fetch'));
    expect(fetch).toBeDefined();
    expect(fetch).toContain(ref);
    expect(fetch!.indexOf('--')).toBeGreaterThan(-1);
    expect(fetch!.indexOf('--')).toBeLessThan(fetch!.indexOf(ref));

    for (const [, , options] of execFileSyncMock.mock.calls) {
      expect((options as Record<string, unknown> | undefined)?.shell).toBeUndefined();
    }
    expect(
      execSyncMock.mock.calls
        .map(([command]) => String(command))
        .filter((command) => command.includes('eve-pack-marker')),
    ).toEqual([]);
  });
});
