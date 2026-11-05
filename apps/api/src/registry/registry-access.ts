import { createHash, timingSafeEqual } from 'crypto';
import { verifyRegistryPullCredential } from '@eve/shared';

export interface RegistryAccessEntry {
  type: string;
  name: string;
  actions: string[];
}

/**
 * Who is asking the token endpoint for registry access.
 *
 * - `internal`: holds `EVE_INTERNAL_API_KEY` (the worker's builds, through
 *   BuildKit, or the internal POST endpoint). May push and pull.
 * - `project-pull`: presents an environment's pull credential from an app
 *   namespace's `eve-registry` pull secret (kubelet). May pull the project's
 *   repositories only, and only while the credential is current
 *   (`isPullCredentialCurrent`).
 */
export type RegistryCaller =
  | { kind: 'internal' }
  | { kind: 'project-pull'; projectId: string; environmentId: string; namespace: string; epoch: number };

/** The environment fields a pull credential is checked against. */
export interface PullCredentialEnvironment {
  project_id: string;
  status: string;
  registry_pull_epoch: number;
}

/**
 * A pull credential is honoured only while its environment still exists,
 * belongs to the credential's (non-deleted) project, is not terminated, and is
 * at the pull epoch the credential was minted for, or the one before it. The
 * one-epoch grace covers kubelet's short-lived secret cache and a deploy and a
 * job run rewriting the secret at the same time; the credential written two
 * rewrites ago is refused.
 */
export function isPullCredentialCurrent(
  caller: Extract<RegistryCaller, { kind: 'project-pull' }>,
  environment: PullCredentialEnvironment | null,
  projectIsLive: boolean,
): boolean {
  if (!environment || !projectIsLive) return false;
  if (environment.project_id !== caller.projectId) return false;
  if (environment.status === 'terminated') return false;
  const current = environment.registry_pull_epoch;
  return caller.epoch === current || caller.epoch === current - 1;
}

const GRANTABLE_ACTIONS: Record<RegistryCaller['kind'], ReadonlySet<string>> = {
  internal: new Set(['pull', 'push']),
  'project-pull': new Set(['pull']),
};

function secretsEqual(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Identify a Basic-auth password as the internal key or a project pull credential. */
export function identifyRegistryCaller(
  password: string | undefined,
  internalKey: string | undefined,
): RegistryCaller | null {
  if (!password || !internalKey) return null;
  if (secretsEqual(password, internalKey)) return { kind: 'internal' };
  const claims = verifyRegistryPullCredential(password, internalKey);
  return claims ? { kind: 'project-pull', ...claims } : null;
}

/**
 * Reduce the requested scopes to what the caller may hold, following the
 * Docker token spec (grant the permitted subset, never fail the request):
 *
 * - only `repository` resources (no `registry:catalog`);
 * - only `pull`/`push` for internal callers, only `pull` for project callers
 *   (never `delete` or `*`);
 * - project callers only on repositories their project has built.
 *
 * Entries left with no actions are dropped.
 */
export function grantRegistryAccess(
  caller: RegistryCaller,
  requested: RegistryAccessEntry[],
  projectRepositories: ReadonlySet<string> = new Set(),
): RegistryAccessEntry[] {
  const grantable = GRANTABLE_ACTIONS[caller.kind];
  const granted: RegistryAccessEntry[] = [];
  for (const entry of requested) {
    if (entry.type !== 'repository') continue;
    if (caller.kind === 'project-pull' && !projectRepositories.has(entry.name)) continue;
    const actions = [...new Set(entry.actions.filter((action) => grantable.has(action)))];
    if (actions.length > 0) {
      granted.push({ type: 'repository', name: entry.name, actions });
    }
  }
  return granted;
}

/**
 * Repository path of an image ref inside its registry, as it appears in a
 * registry scope: drops the digest, the tag and a leading registry host
 * (a first segment containing `.` or `:`, or `localhost`).
 *
 * `registry.example.com/api:sha-1` -> `api`;
 * `eve-registry.eve.svc.cluster.local:5000/acme/web@sha256:...` -> `acme/web`.
 */
export function repositoryFromImageRef(imageRef: string): string | null {
  const withoutDigest = imageRef.split('@')[0] ?? '';
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  const name = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const segments = name.split('/').filter(Boolean);
  const first = segments[0] ?? '';
  if (segments.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    segments.shift();
  }
  return segments.length > 0 ? segments.join('/') : null;
}
