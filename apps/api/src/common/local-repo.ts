import { BadRequestException } from '@nestjs/common';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local development only: lets projects use `file://` repo URLs (a checkout
 * on the machine running Eve). Off by default; the local k3d overlay, the
 * CLI's local stack, docker compose and `./bin/eh start local` turn it on.
 */
export const ALLOW_FILE_REPO_URLS_ENV = 'EVE_ALLOW_FILE_REPO_URLS';

export function fileRepoUrlsAllowed(): boolean {
  const value = (process.env[ALLOW_FILE_REPO_URLS_ENV] ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(value);
}

function isFileRepoUrl(repoUrl: string | null | undefined): boolean {
  return typeof repoUrl === 'string' && /^\s*file:/i.test(repoUrl);
}

/** 400 for a `file://` repo URL unless the local development setting is on. */
export function assertRepoUrlAllowed(repoUrl: string | null | undefined): void {
  if (isFileRepoUrl(repoUrl) && !fileRepoUrlsAllowed()) {
    throw new BadRequestException(
      `file:// repo URLs are only accepted for local development (${ALLOW_FILE_REPO_URLS_ENV}=true). ` +
      'Use an https or SSH git URL.',
    );
  }
}

/** The checkout path of a `file://` repo URL, only when the local setting is on. */
export function localRepoPath(repoUrl: string | null | undefined): string | undefined {
  if (!repoUrl || !isFileRepoUrl(repoUrl) || !fileRepoUrlsAllowed()) return undefined;
  try {
    const url = new URL(repoUrl.trim());
    return url.protocol === 'file:' ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' ? false : !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Read a regular file inside `repoRoot`, at most `maxBytes`. Symlinks are
 * resolved first and must stay inside the (resolved) root; devices, pipes,
 * directories and files over the limit are refused before any content is
 * read.
 */
export async function readRepoFile(repoRoot: string, relativePath: string, maxBytes: number): Promise<string> {
  const root = await fs.realpath(path.resolve(repoRoot));
  const lexical = path.resolve(root, relativePath);
  if (!isInside(root, lexical)) {
    throw new Error(`${relativePath} is outside the repository`);
  }
  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch {
    throw new Error(`${relativePath} does not exist in the repository`);
  }
  if (!isInside(root, real)) {
    throw new Error(`${relativePath} leads outside the repository`);
  }

  // O_NONBLOCK so a named pipe cannot hold the open; fstat on the opened
  // descriptor so the checks apply to exactly what is read.
  const handle = await fs.open(real, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`${relativePath} is not a regular file`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${relativePath} is larger than ${maxBytes} bytes`);
    }
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) {
      throw new Error(`${relativePath} is larger than ${maxBytes} bytes`);
    }
    return buffer.subarray(0, filled).toString('utf8');
  } finally {
    await handle.close();
  }
}
