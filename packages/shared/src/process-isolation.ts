import { statSync } from 'node:fs';
import * as inspector from 'node:inspector';
import * as path from 'node:path';

/*
 * Keeping job code away from the service's credentials.
 *
 * The agent runtime and the worker run job code (agent harnesses, pipeline
 * scripts) as child processes under their own UID. A same-UID process can:
 *
 * 1. read another's `/proc/<pid>/environ` and memory, unless the target is
 *    non-dumpable. The images start each service from an execute-only copy of
 *    node (`/usr/local/libexec/eve-node`); the kernel marks a process that
 *    executes a binary its user cannot read non-dumpable.
 * 2. send it SIGUSR1, which opens the Node inspector on 127.0.0.1:9229 and lets
 *    the sender evaluate code inside the service. The images pass
 *    `--disable-sigusr1`.
 * 3. plant files the service later executes or reads: binaries in a writable
 *    PATH directory, `~/.gitconfig` hooks, toolchain `env.sh`. Service helpers
 *    therefore run from a trusted PATH with an allowlisted environment that
 *    holds no credentials, and service git ignores global config and hooks.
 */

// ---------------------------------------------------------------------------
// Environ exposure (non-dumpable check)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Inspector exposure (SIGUSR1, --inspect)
// ---------------------------------------------------------------------------

export interface InspectorProbe {
  execArgv: readonly string[];
  nodeOptions: string | undefined;
  inspectorUrl: () => string | undefined;
}

const defaultInspectorProbe: InspectorProbe = {
  execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS,
  inspectorUrl: () => inspector.url(),
};

/** Reasons a same-UID process could attach a debugger to this service. Empty means none. */
export function inspectInspectorExposure(probe: InspectorProbe = defaultInspectorProbe): string[] {
  const problems: string[] = [];
  const flags = [...probe.execArgv, ...(probe.nodeOptions?.split(/\s+/) ?? [])];
  if (!flags.includes('--disable-sigusr1')) {
    problems.push('started without --disable-sigusr1, so SIGUSR1 opens the inspector');
  }
  const inspectFlags = flags.filter((flag) => /^--inspect(-brk|-port|-wait|-publish-uid)?(=|$)/.test(flag));
  if (inspectFlags.length > 0) problems.push(`started with ${inspectFlags.join(' ')}`);
  if (probe.inspectorUrl()) problems.push('has an open inspector');
  return problems;
}

// ---------------------------------------------------------------------------
// Startup check
// ---------------------------------------------------------------------------

export interface ProcessIsolationReport {
  environ: EnvironExposure;
  inspector: string[];
}

/**
 * Log whether job processes can read this service's environment or attach a
 * debugger to it, and refuse to start when `EVE_REQUIRE_ENVIRON_PROTECTION=true`
 * and they can.
 */
export function checkProcessIsolation(
  logger: { log: (message: string) => void; warn: (message: string) => void },
  serviceLabel: string,
  env: NodeJS.ProcessEnv = process.env,
  probes: { environ?: EnvironExposureProbe; inspector?: InspectorProbe } = {},
): ProcessIsolationReport {
  const environ = inspectEnvironExposure(probes.environ);
  const inspectorProblems = environ.status === 'unsupported' ? [] : inspectInspectorExposure(probes.inspector);
  const required = env.EVE_REQUIRE_ENVIRON_PROTECTION?.trim().toLowerCase() === 'true';

  const problems: string[] = [];
  if (environ.status === 'root') problems.push('runs as root, so job processes it starts run as root too');
  if (environ.status === 'exposed') {
    problems.push(`is dumpable, so any process running as UID ${environ.uid} (including job processes) can read `
      + 'its environment and memory through /proc');
  }
  problems.push(...inspectorProblems);

  if (problems.length === 0) {
    if (environ.status === 'protected') {
      logger.log(`${serviceLabel}: process is non-dumpable with SIGUSR1 disabled; job processes cannot read `
        + 'its environment or attach to it');
    }
    return { environ, inspector: inspectorProblems };
  }

  const message = `${serviceLabel}: process ${problems.join('; ')}. Start it as a non-root user with `
    + '`/usr/local/libexec/eve-node --disable-sigusr1 dist/main.js` (the image default).';
  if (required) {
    throw new Error(`${message} Refusing to start because EVE_REQUIRE_ENVIRON_PROTECTION=true.`);
  }
  logger.warn(message);
  return { environ, inspector: inspectorProblems };
}

// ---------------------------------------------------------------------------
// Helper child processes
// ---------------------------------------------------------------------------

export interface DirStat {
  uid: number;
  mode: number;
}

export interface TrustedPathOptions {
  platform?: NodeJS.Platform;
  statDir?: (dir: string) => DirStat | undefined;
}

function defaultStatDir(dir: string): DirStat | undefined {
  try {
    const stat = statSync(dir);
    return stat.isDirectory() ? { uid: stat.uid, mode: stat.mode } : undefined;
  } catch {
    return undefined;
  }
}

function rootControlled(dir: string, statDir: (dir: string) => DirStat | undefined): boolean {
  for (let current = dir; ; current = path.dirname(current)) {
    const stat = statDir(current);
    if (!stat || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
    if (current === path.dirname(current)) return true;
  }
}

/**
 * The PATH a service uses for its own helpers: only directories that root alone
 * can change, checked up to `/`. A job running as the service's UID cannot
 * plant a `git` or `kubectl` there. Outside Linux (local development) the PATH
 * is returned unchanged.
 */
export function trustedPath(pathValue: string | undefined, options: TrustedPathOptions = {}): string {
  const entries = (pathValue ?? '').split(path.delimiter).filter(Boolean);
  if ((options.platform ?? process.platform) !== 'linux') return entries.join(path.delimiter);
  const statDir = options.statDir ?? defaultStatDir;
  const trusted = entries.filter((dir) => path.isAbsolute(dir) && rootControlled(dir, statDir));
  return [...new Set(trusted)].join(path.delimiter);
}

/**
 * Service env keys a helper child (git, kubectl, crane, tar, buildctl, kaniko,
 * pg_dump) may inherit. No credentials: helpers that need one (a PGPASSWORD,
 * a GIT_SSH_COMMAND key path, a DOCKER_CONFIG directory) get it from the
 * caller for that call only. Cloud identity is passed only as role and token
 * file pointers (IRSA, EKS Pod Identity, Workload Identity), never static keys.
 */
export const SERVICE_HELPER_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
  'KUBECONFIG',
  'DOCKER_CONFIG',
  'DOCKER_HOST',
  'BUILDKIT_HOST',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_STS_REGIONAL_ENDPOINTS',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

/**
 * Environment for a helper child the service runs on its own behalf. A running
 * child's `/proc/<pid>/environ` is readable by same-UID job processes, so it
 * gets an allowlist plus `extra`, and the trusted PATH.
 */
export function serviceHelperEnv(
  extra: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
  options: TrustedPathOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: trustedPath(source.PATH, options) };
  for (const key of SERVICE_HELPER_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Environment for git run by the service. Global config (`~/.gitconfig`, which a
 * job can write) is ignored, and hooks and fsmonitor are disabled at
 * command-line precedence, so repository config written by a job cannot make
 * the service run a command. System config (`/etc/gitconfig`) stays: it is part
 * of the root-owned image and carries the worker's commit identity.
 */
export function serviceGitEnv(
  extra: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
  options: TrustedPathOptions = {},
): NodeJS.ProcessEnv {
  return serviceHelperEnv({
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    ...extra,
  }, source, options);
}
