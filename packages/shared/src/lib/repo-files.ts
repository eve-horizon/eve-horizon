import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Reading tenant-named files from a repository checkout (node-only).
 *
 * The path must be relative, must stay inside the checkout after every
 * symlink is resolved (the checkout root is resolved too), and must name a
 * regular file no larger than the given limit. Devices, pipes and sockets
 * are refused before any content is read. Git metadata (any `.git` path
 * segment, in any case) is never read: a clone's `.git/config` can hold the
 * credential it was cloned with.
 */

export type RepoFileErrorCode = 'absolute' | 'outside' | 'git_metadata' | 'not_found' | 'not_regular' | 'too_large';

export class RepoFileError extends Error {
  constructor(message: string, readonly code: RepoFileErrorCode) {
    super(message);
  }
}

function hasGitSegment(root: string, candidate: string): boolean {
  return path.relative(root, candidate).split(path.sep).some((segment) => segment.toLowerCase() === '.git');
}

function isInside(root: string, candidate: string, allowRoot: boolean): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function resolveInRepo(
  repoRoot: string,
  relativePath: string,
  allowRoot: boolean,
): Promise<{ root: string; lexical: string; real: string }> {
  if (path.isAbsolute(relativePath)) {
    throw new RepoFileError(`${relativePath} must be a path relative to the repository`, 'absolute');
  }
  const root = await fs.realpath(path.resolve(repoRoot));
  const lexical = path.resolve(root, relativePath);
  if (!isInside(root, lexical, allowRoot)) {
    throw new RepoFileError(`${relativePath} is outside the repository`, 'outside');
  }
  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch {
    throw new RepoFileError(`${relativePath} does not exist in the repository`, 'not_found');
  }
  if (!isInside(root, real, allowRoot)) {
    throw new RepoFileError(`${relativePath} leads outside the repository`, 'outside');
  }
  if (hasGitSegment(root, lexical) || hasGitSegment(root, real)) {
    throw new RepoFileError(`${relativePath} is git metadata, which is never read`, 'git_metadata');
  }
  return { root, lexical, real };
}

/** Read an already-resolved path, checking the opened descriptor itself. */
async function readRegularFile(realPath: string, label: string, maxBytes: number): Promise<string> {
  // O_NONBLOCK so a named pipe cannot hold the open.
  const handle = await fs.open(realPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new RepoFileError(`${label} is not a regular file`, 'not_regular');
    }
    if (stat.size > maxBytes) {
      throw new RepoFileError(`${label} is larger than ${maxBytes} bytes`, 'too_large');
    }
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) {
      throw new RepoFileError(`${label} is larger than ${maxBytes} bytes`, 'too_large');
    }
    return buffer.subarray(0, filled).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Read one regular file inside the checkout, at most `maxBytes`. */
export async function readRepoFile(repoRoot: string, relativePath: string, maxBytes: number): Promise<string> {
  const { real } = await resolveInRepo(repoRoot, relativePath, false);
  return readRegularFile(real, relativePath, maxBytes);
}

/**
 * Read a file, or the files directly inside a directory, from the checkout,
 * keyed by file name. Subdirectories are skipped (the result is flat); any
 * other entry that is not a regular file inside the checkout is refused.
 * Each file may be at most `maxBytesPerFile`.
 */
export async function readRepoFiles(
  repoRoot: string,
  relativePath: string,
  maxBytesPerFile: number,
): Promise<Record<string, string>> {
  const { root, lexical, real } = await resolveInRepo(repoRoot, relativePath, true);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    return { [path.basename(lexical)]: await readRegularFile(real, relativePath, maxBytesPerFile) };
  }

  const data: Record<string, string> = {};
  for (const entry of await fs.readdir(real)) {
    if (entry.toLowerCase() === '.git') {
      continue;
    }
    const label = path.join(relativePath, entry);
    let entryReal: string;
    try {
      entryReal = await fs.realpath(path.join(real, entry));
    } catch {
      throw new RepoFileError(`${label} does not exist in the repository`, 'not_found');
    }
    if (!isInside(root, entryReal, false)) {
      throw new RepoFileError(`${label} leads outside the repository`, 'outside');
    }
    if (hasGitSegment(root, entryReal)) {
      throw new RepoFileError(`${label} leads into git metadata, which is never read`, 'git_metadata');
    }
    if ((await fs.stat(entryReal)).isDirectory()) {
      continue;
    }
    data[entry] = await readRegularFile(entryReal, label, maxBytesPerFile);
  }
  return data;
}
