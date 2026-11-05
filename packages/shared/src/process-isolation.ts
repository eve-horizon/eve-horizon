import { statSync } from 'node:fs';

/**
 * Can a job process read this service's environment?
 *
 * The agent runtime and the worker run job code (agent harnesses, pipeline
 * scripts) as child processes under their own UID. Linux lets any process with
 * the same UID read another's `/proc/<pid>/environ` and memory, unless the
 * target is non-dumpable. The service images start the service from an
 * execute-only copy of the interpreter (`/usr/local/libexec/eve-node`), and the
 * kernel marks a process non-dumpable when it executes a binary its user cannot
 * read. A non-dumpable process's `/proc/<pid>` files are owned by root, so the
 * owner of `/proc/self/environ` tells us which case we are in.
 */
export type EnvironExposure =
  /** Non-dumpable: same-UID processes cannot read our environ or memory. */
  | { status: 'protected' }
  /** Dumpable: any process running as `uid` can read our environment. */
  | { status: 'exposed'; uid: number }
  /** Running as root: children inherit root unless they drop privileges. */
  | { status: 'root' }
  /** No Linux procfs (macOS dev, Windows). */
  | { status: 'unsupported' };

export interface EnvironExposureProbe {
  platform: NodeJS.Platform;
  getuid: () => number;
  environOwner: () => number;
}

const defaultProbe: EnvironExposureProbe = {
  platform: process.platform,
  getuid: () => process.getuid?.() ?? -1,
  environOwner: () => statSync('/proc/self/environ').uid,
};

export function inspectEnvironExposure(probe: EnvironExposureProbe = defaultProbe): EnvironExposure {
  if (probe.platform !== 'linux') return { status: 'unsupported' };
  const uid = probe.getuid();
  if (uid === 0) return { status: 'root' };
  let owner: number;
  try {
    owner = probe.environOwner();
  } catch {
    return { status: 'unsupported' };
  }
  return owner === uid ? { status: 'exposed', uid } : { status: 'protected' };
}

/**
 * Log whether job processes can read this service's environment, and refuse to
 * start when `EVE_REQUIRE_ENVIRON_PROTECTION=true` and they can.
 */
export function checkEnvironProtection(
  logger: { log: (message: string) => void; warn: (message: string) => void },
  serviceLabel: string,
  env: NodeJS.ProcessEnv = process.env,
  probe?: EnvironExposureProbe,
): EnvironExposure {
  const exposure = inspectEnvironExposure(probe);
  const required = env.EVE_REQUIRE_ENVIRON_PROTECTION?.trim().toLowerCase() === 'true';
  switch (exposure.status) {
    case 'protected':
      logger.log(`${serviceLabel}: process is non-dumpable; job processes cannot read its environment`);
      break;
    case 'unsupported':
      break;
    case 'root':
    case 'exposed': {
      const why = exposure.status === 'root'
        ? 'runs as root, so job processes it starts run as root too'
        : `is dumpable, so any process running as UID ${exposure.uid} (including job processes) can read `
          + 'its environment and memory through /proc';
      const message = `${serviceLabel}: process ${why}. Start it from the image's execute-only interpreter `
        + '(/usr/local/libexec/eve-node) as a non-root user.';
      if (required) {
        throw new Error(`${message} Refusing to start because EVE_REQUIRE_ENVIRON_PROTECTION=true.`);
      }
      logger.warn(message);
      break;
    }
  }
  return exposure;
}

/**
 * Platform credentials that only Eve's own service processes use. Helper
 * children (git, crane, tar) never need them, and while one runs, a job process
 * with the same UID can read its `/proc/<pid>/environ`. This is a denylist on
 * purpose: helpers still need proxies, CA bundles, registry and cloud SDK
 * settings from the service environment.
 */
export const PLATFORM_SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'EVE_INTERNAL_API_KEY',
  'EVE_SECRETS_MASTER_KEY',
  'EVE_AUTH_JWT_SECRET',
  'EVE_AUTH_PRIVATE_KEY',
  'EVE_AUTH_ADMIN_PASSWORD',
  'EVE_BOOTSTRAP_TOKEN',
  'EVE_GITHUB_WEBHOOK_SECRET',
  'EVE_GITHUB_TOKEN',
  'EVE_ORG_FS_LINK_TOKEN_SECRET',
  'EVE_REGISTRY_SIGNING_KEY',
  'EVE_STORAGE_SECRET_ACCESS_KEY',
  'EVE_APP_STORAGE_SECRET_ACCESS_KEY',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_AUTH_SERVICE_KEY',
] as const;

/** A copy of `env` without Eve's platform credentials, for helper child processes. */
export function withoutPlatformSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of PLATFORM_SECRET_ENV_KEYS) delete copy[key];
  return copy;
}
