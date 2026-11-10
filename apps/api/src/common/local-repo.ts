import { BadRequestException } from '@nestjs/common';
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

/** Read a regular file inside a checkout (see @eve/shared readRepoFile). */
export { readRepoFile } from '@eve/shared';
