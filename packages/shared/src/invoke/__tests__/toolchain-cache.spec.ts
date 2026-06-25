import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureToolchains } from '../toolchain-cache.js';

let tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-toolchains-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

describe('ensureToolchains', () => {
  it('uses an installed matching toolchain and returns the sourced environment', async () => {
    const root = await makeTempRoot();
    const pythonRoot = path.join(root, 'python');
    await fs.mkdir(path.join(pythonRoot, 'bin'), { recursive: true });
    await fs.writeFile(path.join(pythonRoot, '.installed'), 'test/toolchain-python:v1\n');
    await fs.writeFile(
      path.join(pythonRoot, 'env.sh'),
      `export PATH="${path.join(pythonRoot, 'bin')}:$PATH"\nexport PYTHONPATH="${path.join(pythonRoot, 'lib')}"\n`,
    );

    const events: string[] = [];
    const result = await ensureToolchains({
      toolchainRoot: root,
      imagePrefix: 'test/toolchain-',
      imageTag: 'v1',
      toolchains: ['python', 'python'],
      baseEnv: { PATH: '/usr/bin' },
      logger: (event) => events.push(event.type),
    });

    expect(result.resolved).toEqual(['python']);
    expect(result.missing).toEqual([]);
    expect(result.env.PATH).toBe(`${path.join(pythonRoot, 'bin')}:/usr/bin`);
    expect(result.pathPrefix).toBe(path.join(pythonRoot, 'bin'));
    expect(result.envOverlay).toEqual({ PYTHONPATH: path.join(pythonRoot, 'lib') });
    expect(events).toEqual(['cache_hit', 'env_loaded']);
  });

  it('rejects unknown toolchain names before trying to install', async () => {
    await expect(ensureToolchains({
      toolchains: ['python', 'rubber'],
      baseEnv: { PATH: '/usr/bin' },
    })).rejects.toThrow(/Unknown toolchain "rubber"/);
  });

  it('preserves relative symlinks when installing an extracted payload', async () => {
    const root = await makeTempRoot();
    const imageRoot = await makeTempRoot();
    const fakeBin = await makeTempRoot();
    await fs.mkdir(path.join(imageRoot, 'toolchain', 'bin'), { recursive: true });
    await fs.writeFile(path.join(imageRoot, 'toolchain', 'bin', 'python3.11'), '#!/bin/sh\n');
    await fs.symlink('python3.11', path.join(imageRoot, 'toolchain', 'bin', 'python3'));
    await fs.writeFile(
      path.join(imageRoot, 'toolchain', 'env.sh'),
      `export PATH="${path.join(root, 'python', 'bin')}:$PATH"\n`,
    );
    await fs.writeFile(
      path.join(fakeBin, 'crane'),
      `#!/bin/sh\ntar -cf - -C ${JSON.stringify(imageRoot)} toolchain\n`,
      { mode: 0o755 },
    );

    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${oldPath ?? ''}`;
    try {
      await ensureToolchains({
        toolchainRoot: root,
        imagePrefix: 'test/toolchain-',
        imageTag: 'v1',
        toolchains: ['python'],
        baseEnv: { PATH: '/usr/bin' },
      });
    } finally {
      process.env.PATH = oldPath;
    }

    await expect(fs.readlink(path.join(root, 'python', 'bin', 'python3'))).resolves.toBe('python3.11');
  });

  it('retries transient registry export failures', async () => {
    const root = await makeTempRoot();
    const imageRoot = await makeTempRoot();
    const fakeBin = await makeTempRoot();
    const stateFile = path.join(fakeBin, 'crane-state');
    await fs.mkdir(path.join(imageRoot, 'toolchain', 'bin'), { recursive: true });
    await fs.writeFile(path.join(imageRoot, 'toolchain', 'bin', 'python'), '#!/bin/sh\n');
    await fs.writeFile(
      path.join(imageRoot, 'toolchain', 'env.sh'),
      `export PATH="${path.join(root, 'python', 'bin')}:$PATH"\n`,
    );
    await fs.writeFile(
      path.join(fakeBin, 'crane'),
      [
        '#!/bin/sh',
        `state=${JSON.stringify(stateFile)}`,
        'count="$(cat "$state" 2>/dev/null || echo 0)"',
        'if [ "$count" = "0" ]; then',
        '  echo 1 > "$state"',
        '  echo "TOOMANYREQUESTS: rate exceeded" >&2',
        '  exit 1',
        'fi',
        `tar -cf - -C ${JSON.stringify(imageRoot)} toolchain`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const oldPath = process.env.PATH;
    const oldRetries = process.env.EVE_TOOLCHAIN_EXPORT_RETRIES;
    const oldRetryBase = process.env.EVE_TOOLCHAIN_EXPORT_RETRY_BASE_MS;
    process.env.PATH = `${fakeBin}:${oldPath ?? ''}`;
    process.env.EVE_TOOLCHAIN_EXPORT_RETRIES = '2';
    process.env.EVE_TOOLCHAIN_EXPORT_RETRY_BASE_MS = '1';
    try {
      await ensureToolchains({
        toolchainRoot: root,
        imagePrefix: 'test/toolchain-',
        imageTag: 'v1',
        toolchains: ['python'],
        baseEnv: { PATH: '/usr/bin' },
      });
    } finally {
      process.env.PATH = oldPath;
      if (oldRetries === undefined) delete process.env.EVE_TOOLCHAIN_EXPORT_RETRIES;
      else process.env.EVE_TOOLCHAIN_EXPORT_RETRIES = oldRetries;
      if (oldRetryBase === undefined) delete process.env.EVE_TOOLCHAIN_EXPORT_RETRY_BASE_MS;
      else process.env.EVE_TOOLCHAIN_EXPORT_RETRY_BASE_MS = oldRetryBase;
    }

    await expect(fs.readFile(path.join(root, 'python', '.installed'), 'utf8')).resolves.toBe('test/toolchain-python:v1\n');
  });
});
