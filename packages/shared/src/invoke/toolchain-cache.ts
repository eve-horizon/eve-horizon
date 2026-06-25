import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { VALID_TOOLCHAINS } from '../schemas/agent-config.js';

const DEFAULT_TOOLCHAIN_ROOT = '/opt/eve/toolchains';
const DEFAULT_IMAGE_PREFIX = 'eve-horizon/toolchain-';
const DEFAULT_IMAGE_TAG = 'local';
const DEFAULT_EXPORT_RETRIES = 3;
const DEFAULT_EXPORT_RETRY_BASE_MS = 1000;
const VALID_TOOLCHAIN_SET = new Set<string>(VALID_TOOLCHAINS);
const SHELL_ADDED_ENV_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);

export type ToolchainCacheEventType =
  | 'cache_hit'
  | 'install_wait'
  | 'install_start'
  | 'install_done'
  | 'env_loaded';

export interface ToolchainCacheEvent {
  type: ToolchainCacheEventType;
  toolchain: string;
  image?: string;
  root?: string;
  message?: string;
}

export interface EnsureToolchainsOptions {
  toolchains: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
  toolchainRoot?: string;
  imagePrefix?: string;
  imageTag?: string;
  dockerConfigDir?: string;
  insecureRegistry?: boolean;
  logger?: (event: ToolchainCacheEvent) => void | Promise<void>;
}

export interface ToolchainProvisionResult {
  resolved: string[];
  missing: string[];
  pathPrefix: string;
  envOverlay: Record<string, string>;
  env: NodeJS.ProcessEnv;
}

export class ToolchainProvisionError extends Error {
  constructor(
    message: string,
    readonly toolchain: string,
    readonly image: string,
  ) {
    super(message);
    this.name = 'ToolchainProvisionError';
  }
}

export async function ensureToolchains(options: EnsureToolchainsOptions): Promise<ToolchainProvisionResult> {
  const baseEnv: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };
  const requested = normalizeToolchains(options.toolchains);
  if (requested.length === 0) {
    return {
      resolved: [],
      missing: [],
      pathPrefix: '',
      envOverlay: {},
      env: baseEnv,
    };
  }

  const toolchainRoot = options.toolchainRoot ?? process.env.EVE_TOOLCHAIN_ROOT ?? DEFAULT_TOOLCHAIN_ROOT;
  const imagePrefix = options.imagePrefix ?? process.env.EVE_TOOLCHAIN_IMAGE_PREFIX ?? DEFAULT_IMAGE_PREFIX;
  const imageTag = options.imageTag ?? process.env.EVE_TOOLCHAIN_IMAGE_TAG ?? DEFAULT_IMAGE_TAG;
  const insecureRegistry = options.insecureRegistry ?? process.env.EVE_TOOLCHAIN_REGISTRY_INSECURE === 'true';
  await fs.mkdir(toolchainRoot, { recursive: true });

  for (const toolchain of requested) {
    const image = `${imagePrefix}${toolchain}:${imageTag}`;
    try {
      await ensureToolchainInstalled(toolchainRoot, toolchain, image, {
        dockerConfigDir: options.dockerConfigDir ?? process.env.DOCKER_CONFIG,
        insecureRegistry,
        logger: options.logger,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolchainProvisionError(
        `Failed to provision toolchain "${toolchain}" from ${image}: ${message}`,
        toolchain,
        image,
      );
    }
  }

  let env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const toolchain of requested) {
    const envPath = path.join(toolchainRoot, toolchain, 'env.sh');
    env = await sourceToolchainEnv(envPath, env);
    await options.logger?.({
      type: 'env_loaded',
      toolchain,
      root: path.join(toolchainRoot, toolchain),
    });
  }

  const { pathPrefix, envOverlay } = diffEnv(baseEnv, env);
  return {
    resolved: requested,
    missing: [],
    pathPrefix,
    envOverlay,
    env,
  };
}

function normalizeToolchains(toolchains: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const toolchain of toolchains) {
    if (typeof toolchain !== 'string' || toolchain.length === 0) {
      throw new Error('Toolchain names must be non-empty strings');
    }
    if (!VALID_TOOLCHAIN_SET.has(toolchain)) {
      throw new Error(`Unknown toolchain "${toolchain}"`);
    }
    normalized.push(toolchain);
  }
  return [...new Set(normalized)];
}

async function ensureToolchainInstalled(
  toolchainRoot: string,
  toolchain: string,
  image: string,
  options: {
    dockerConfigDir?: string;
    insecureRegistry: boolean;
    logger?: (event: ToolchainCacheEvent) => void | Promise<void>;
  },
): Promise<void> {
  const target = path.join(toolchainRoot, toolchain);
  if (await isInstalled(target, image)) {
    await options.logger?.({ type: 'cache_hit', toolchain, image, root: target });
    return;
  }

  const lockDir = path.join(toolchainRoot, `.${toolchain}.lock`);
  await withInstallLock(lockDir, async () => {
    if (await isInstalled(target, image)) {
      await options.logger?.({ type: 'cache_hit', toolchain, image, root: target });
      return;
    }

    await options.logger?.({ type: 'install_start', toolchain, image, root: target });
    await installToolchain(toolchainRoot, toolchain, image, options);
    await options.logger?.({ type: 'install_done', toolchain, image, root: target });
  }, async () => {
    await options.logger?.({
      type: 'install_wait',
      toolchain,
      image,
      root: target,
      message: 'waiting for concurrent toolchain install',
    });
  });
}

async function isInstalled(target: string, image: string): Promise<boolean> {
  try {
    const marker = await fs.readFile(path.join(target, '.installed'), 'utf8');
    return marker.trim() === image;
  } catch {
    return false;
  }
}

async function installToolchain(
  toolchainRoot: string,
  toolchain: string,
  image: string,
  options: {
    dockerConfigDir?: string;
    insecureRegistry: boolean;
  },
): Promise<void> {
  const nonce = `${process.pid}-${Date.now()}`;
  const extractRoot = path.join(toolchainRoot, `.${toolchain}.extract-${nonce}`);
  const installDir = path.join(toolchainRoot, `.${toolchain}.install-${nonce}`);
  const target = path.join(toolchainRoot, toolchain);

  await fs.rm(extractRoot, { recursive: true, force: true });
  await fs.rm(installDir, { recursive: true, force: true });
  await fs.mkdir(extractRoot, { recursive: true });

  try {
    await exportToolchainImageWithRetry(image, extractRoot, options);
    const payloadDir = path.join(extractRoot, 'toolchain');
    await assertDirectory(payloadDir, `toolchain image ${image} did not contain /toolchain`);
    await fs.cp(payloadDir, installDir, { recursive: true, force: true, verbatimSymlinks: true });
    await fs.writeFile(path.join(installDir, '.installed'), `${image}\n`, 'utf8');
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(installDir, target);
  } finally {
    await fs.rm(extractRoot, { recursive: true, force: true });
    await fs.rm(installDir, { recursive: true, force: true });
  }
}

async function exportToolchainImageWithRetry(
  image: string,
  extractRoot: string,
  options: {
    dockerConfigDir?: string;
    insecureRegistry: boolean;
  },
): Promise<void> {
  const maxRetries = readNonNegativeInt(process.env.EVE_TOOLCHAIN_EXPORT_RETRIES, DEFAULT_EXPORT_RETRIES);
  const retryBaseMs = readNonNegativeInt(process.env.EVE_TOOLCHAIN_EXPORT_RETRY_BASE_MS, DEFAULT_EXPORT_RETRY_BASE_MS);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await fs.rm(extractRoot, { recursive: true, force: true });
    await fs.mkdir(extractRoot, { recursive: true });

    try {
      await exportToolchainImage(image, extractRoot, options);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= maxRetries || !isRetryableRegistryError(message)) {
        throw error;
      }

      const delayMs = retryBaseMs * 2 ** attempt;
      console.warn(
        `[toolchain] ${image} export failed on attempt ${attempt + 1}/${maxRetries + 1}; ` +
        `retrying in ${delayMs}ms: ${message}`,
      );
      await delay(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function exportToolchainImage(
  image: string,
  extractRoot: string,
  options: {
    dockerConfigDir?: string;
    insecureRegistry: boolean;
  },
): Promise<void> {
  const craneArgs = [
    ...(options.insecureRegistry ? ['--insecure'] : []),
    'export',
    image,
    '-',
  ];
  const env = {
    ...process.env,
    ...(options.dockerConfigDir ? { DOCKER_CONFIG: options.dockerConfigDir } : {}),
  };

  const crane = spawn('crane', craneArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tar = spawn('tar', ['-xf', '-', '-C', extractRoot], { stdio: ['pipe', 'ignore', 'pipe'] });
  crane.stdout.pipe(tar.stdin);

  const [craneResult, tarResult] = await Promise.all([
    waitForProcess(crane, 'crane'),
    waitForProcess(tar, 'tar'),
  ]);

  if (craneResult.code !== 0) {
    throw new Error(`crane export failed (${craneResult.code}): ${craneResult.stderr.trim()}`);
  }
  if (tarResult.code !== 0) {
    throw new Error(`tar extract failed (${tarResult.code}): ${tarResult.stderr.trim()}`);
  }
}

function isRetryableRegistryError(message: string): boolean {
  return /(\b429\b|too many requests|toomanyrequests|rate limit|rate exceeded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|\b5\d\d\b|timeout|timed out|i\/o timeout|connection reset|connection refused|unexpected eof|tls handshake timeout)/i
    .test(message);
}

function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function waitForProcess(child: ReturnType<typeof spawn>, name: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`${name} binary not found`));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stderr: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
}

async function withInstallLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  onWait: () => Promise<void>,
): Promise<T> {
  const started = Date.now();
  let notified = false;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!notified) {
        notified = true;
        await onWait();
      }
      if (Date.now() - started > 300_000) {
        throw new Error(`Timed out waiting for install lock ${lockDir}`);
      }
      await delay(250);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function sourceToolchainEnv(envPath: string, baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  await assertFile(envPath, `toolchain env file not found: ${envPath}`);
  const command = `set -a; . ${shellQuote(envPath)}; ${shellQuote(process.execPath)} -e 'process.stdout.write(JSON.stringify(process.env))'`;
  const child = spawn('/bin/bash', ['-c', command], {
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [result, stdout] = await waitForProcessWithStdout(child, 'bash');
  if (result.code !== 0) {
    throw new Error(`failed to source ${envPath}: ${result.stderr.trim()}`);
  }
  return JSON.parse(stdout) as NodeJS.ProcessEnv;
}

function waitForProcessWithStdout(child: ReturnType<typeof spawn>, name: string): Promise<[{ code: number; stderr: string }, string]> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`${name} binary not found`));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      resolve([
        {
          code: code ?? 1,
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        },
        Buffer.concat(stdoutChunks).toString('utf8'),
      ]);
    });
  });
}

function diffEnv(baseEnv: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): {
  pathPrefix: string;
  envOverlay: Record<string, string>;
} {
  const beforePath = baseEnv.PATH ?? '';
  const afterPath = env.PATH ?? '';
  let pathPrefix = '';
  if (afterPath !== beforePath) {
    if (beforePath && afterPath.endsWith(beforePath)) {
      pathPrefix = afterPath.slice(0, -beforePath.length).replace(/:$/, '');
    } else {
      pathPrefix = afterPath;
    }
  }

  const envOverlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'PATH' || value === undefined) continue;
    if (SHELL_ADDED_ENV_KEYS.has(key)) continue;
    if (baseEnv[key] !== value) {
      envOverlay[key] = value;
    }
  }

  return { pathPrefix, envOverlay };
}

async function assertDirectory(dir: string, message: string): Promise<void> {
  try {
    const stat = await fs.stat(dir);
    if (stat.isDirectory()) return;
  } catch {
    // handled below
  }
  throw new Error(message);
}

async function assertFile(file: string, message: string): Promise<void> {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) return;
  } catch {
    // handled below
  }
  throw new Error(message);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
