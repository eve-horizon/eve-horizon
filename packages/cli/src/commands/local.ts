import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHmac, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { FlagValue } from '../lib/args';
import { getBooleanFlag, getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { outputJson } from '../lib/output';
import { handleLocalMesh } from './local-mesh';

const DEFAULT_CLUSTER_NAME = 'eve-local';
const DEFAULT_KUBE_CONTEXT = 'k3d-eve-local';
const MANAGED_BIN_DIR = join(homedir(), '.eve', 'bin');
const LOCAL_API_URL = 'http://api.eve.lvh.me';
const WATCH_INTERVAL_MS = 5000;
const K3D_VERSION = 'v5.7.5';
const KUBECTL_STABLE_URL = 'https://dl.k8s.io/release/stable.txt';
const LOCAL_STACK_ROOT = resolve(__dirname, '..', 'assets', 'local-k8s');
const LOCAL_STACK_OVERLAY = join(LOCAL_STACK_ROOT, 'overlays', 'local');
const LOCAL_STACK_BASE = join(LOCAL_STACK_ROOT, 'base');

type ManagedTool = 'k3d' | 'kubectl';

type ServiceDefinition = {
  id: string;
  workload: string;
  kind: 'deployment' | 'statefulset';
};

type ServiceStatus = {
  id: string;
  workload: string;
  kind: 'deployment' | 'statefulset';
  exists: boolean;
  desired: number;
  ready: number;
  healthy: boolean;
};

type LocalStatusReport = {
  cluster: {
    name: string;
    context: string;
    exists: boolean;
    running: boolean;
  };
  services: ServiceStatus[];
  api: {
    url: string;
    ok: boolean;
    status?: string;
    timestamp?: string;
    error?: string;
  };
  urls: {
    api: string;
    auth: string;
    mail: string;
    sso: string;
  };
};

type RunOptions = {
  cwd?: string;
  stdio?: 'pipe' | 'inherit';
  allowFailure?: boolean;
  timeoutMs?: number;
};

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type UpRuntimeOptions = {
  quiet: boolean;
  verbose: boolean;
};

type ImageDefinition = {
  component: string;
  remote: string;
  local: string;
};

const DEFAULT_PLATFORM_NAMESPACE = 'eve-horizon';
const CONFIGURED_REGISTRY = process.env.ECR_REGISTRY?.trim();
const CONFIGURED_NAMESPACE = process.env.ECR_NAMESPACE?.trim() || DEFAULT_PLATFORM_NAMESPACE;
const PLATFORM_IMAGE_REGISTRY = buildPlatformImageRegistry();

const SERVICE_DEFINITIONS: ServiceDefinition[] = [
  { id: 'api', workload: 'eve-api', kind: 'deployment' },
  { id: 'orchestrator', workload: 'eve-orchestrator', kind: 'deployment' },
  { id: 'worker', workload: 'eve-worker', kind: 'deployment' },
  { id: 'gateway', workload: 'eve-gateway', kind: 'deployment' },
  { id: 'agent-runtime', workload: 'eve-agent-runtime', kind: 'statefulset' },
  { id: 'auth', workload: 'supabase-auth', kind: 'deployment' },
  { id: 'mailpit', workload: 'mailpit', kind: 'deployment' },
  { id: 'sso', workload: 'eve-sso', kind: 'deployment' },
];

const PLATFORM_IMAGES: ImageDefinition[] = buildPlatformImages();

const LOG_TARGETS: Record<string, { resource: string; kind: 'deployment' | 'statefulset' }> = {
  api: { resource: 'eve-api', kind: 'deployment' },
  orchestrator: { resource: 'eve-orchestrator', kind: 'deployment' },
  worker: { resource: 'eve-worker', kind: 'deployment' },
  gateway: { resource: 'eve-gateway', kind: 'deployment' },
  'agent-runtime': { resource: 'eve-agent-runtime', kind: 'statefulset' },
  auth: { resource: 'supabase-auth', kind: 'deployment' },
  postgres: { resource: 'postgres', kind: 'statefulset' },
  mailpit: { resource: 'mailpit', kind: 'deployment' },
  sso: { resource: 'eve-sso', kind: 'deployment' },
};

export async function handleLocal(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'up':
      await handleUp(flags, json);
      return;
    case 'down':
      await handleDown(flags, json);
      return;
    case 'status':
      await handleStatus(flags, json);
      return;
    case 'reset':
      await handleReset(flags, json);
      return;
    case 'logs':
      handleLogs(positionals, flags);
      return;
    case 'health':
      await handleHealth(flags, json);
      return;
    case 'mesh':
      await handleLocalMesh(positionals, flags, context);
      return;
    default:
      throw new Error('Usage: eve local <up|down|status|reset|logs|health|mesh> [options]');
  }
}

async function handleUp(flags: Record<string, FlagValue>, json: boolean): Promise<void> {
  const skipDeploy = getBooleanFlag(flags, ['skip-deploy']) ?? false;
  const skipHealth = getBooleanFlag(flags, ['skip-health']) ?? false;
  const verbose = getBooleanFlag(flags, ['verbose']) ?? false;
  const timeoutSeconds = parseTimeoutSeconds(flags, 300);
  const requestedVersion = getStringFlag(flags, ['version']) ?? 'latest';

  const runtimeOptions: UpRuntimeOptions = {
    quiet: json,
    verbose,
  };

  ensureTool('docker', 'Install Docker Desktop.');
  assertDockerRunning();

  await ensureManagedTool('k3d', runtimeOptions);
  await ensureManagedTool('kubectl', runtimeOptions);
  assertLocalAssetsPresent();

  await ensureClusterReady(runtimeOptions);

  let deployedVersion: string | null = null;
  if (!skipDeploy) {
    const kubectl = requireToolPath('kubectl', "Run 'eve local up' again to auto-install managed tools.");
    const marker = readManagerMarker(kubectl);
    if (marker && marker !== 'cli') {
      throw new Error(
        `This local stack is managed by './bin/eh k8s deploy' (marker: ${marker}).\n` +
          "'eve local up' would overwrite source-built images with released registry images.\n\n" +
          'To switch to CLI management: eve local reset --force\n' +
          'To continue with repo scripts: ./bin/eh k8s deploy',
      );
    }

    deployedVersion = await resolveRequestedVersion(requestedVersion, runtimeOptions);
    await importPlatformImages(deployedVersion, runtimeOptions);
    applyLocalManifests(runtimeOptions);
    writeManagerMarker(kubectl, runtimeOptions);
    waitForStatefulSetRollout('postgres', Math.max(timeoutSeconds, 180), runtimeOptions);
    runDbMigration(Math.max(timeoutSeconds, 180), runtimeOptions);
    generateAuthSecrets(runtimeOptions);
    runAuthBootstrap(Math.max(timeoutSeconds, 120), runtimeOptions);
    restartAndWaitRollouts(Math.max(timeoutSeconds, 180), runtimeOptions);
  }

  let api = await probeApiHealth(LOCAL_API_URL);
  if (!skipHealth) {
    api = await waitForApiHealth(LOCAL_API_URL, timeoutSeconds);
  }

  const result = {
    cluster: DEFAULT_CLUSTER_NAME,
    context: DEFAULT_KUBE_CONTEXT,
    version: deployedVersion,
    skip_deploy: skipDeploy,
    skip_health: skipHealth,
    api,
    urls: {
      api: LOCAL_API_URL,
      auth: 'http://auth.eve.lvh.me',
      mail: 'http://mail.eve.lvh.me',
      sso: 'http://sso.eve.lvh.me',
    },
  };

  if (json) {
    outputJson(result, true);
    return;
  }

  console.log('');
  console.log('Local Eve stack is ready:');
  console.log(`  API:   ${result.urls.api}`);
  console.log(`  Auth:  ${result.urls.auth}`);
  console.log(`  Mail:  ${result.urls.mail}`);
  console.log(`  SSO:   ${result.urls.sso}`);
  console.log('');
  console.log('Next steps:');
  console.log(`  export EVE_API_URL=${LOCAL_API_URL}`);
  console.log('  eve org ensure "my-org" --slug my-org');
}

async function handleDown(flags: Record<string, FlagValue>, json: boolean): Promise<void> {
  const destroy = getBooleanFlag(flags, ['destroy']) ?? false;
  const force = getBooleanFlag(flags, ['force']) ?? false;

  if (destroy && !force) {
    const confirmed = await confirm('Destroy local cluster and all persisted data? [y/N] ');
    if (!confirmed) {
      throw new Error('Aborted.');
    }
  }

  const k3d = findExecutable('k3d');
  if (!k3d) {
    outputJson(
      { stopped: false, reason: 'k3d_missing', cluster: DEFAULT_CLUSTER_NAME },
      json,
      "k3d is not installed. Run 'eve local up' first.",
    );
    return;
  }

  if (destroy) {
    const cluster = getClusterSnapshot();
    if (!cluster.exists) {
      outputJson({ destroyed: false, reason: 'cluster_not_found', cluster: DEFAULT_CLUSTER_NAME }, json, 'Cluster not found. Nothing to destroy.');
      return;
    }
    run(k3d, ['cluster', 'delete', DEFAULT_CLUSTER_NAME]);
    outputJson({ destroyed: true, cluster: DEFAULT_CLUSTER_NAME }, json, `Destroyed cluster '${DEFAULT_CLUSTER_NAME}'.`);
    return;
  }

  const cluster = getClusterSnapshot();
  if (!cluster.exists) {
    outputJson({ stopped: false, reason: 'cluster_not_found', cluster: DEFAULT_CLUSTER_NAME }, json, 'Cluster not found. Nothing to stop.');
    return;
  }
  if (!cluster.running) {
    outputJson({ stopped: true, already_stopped: true, cluster: DEFAULT_CLUSTER_NAME }, json, `Cluster '${DEFAULT_CLUSTER_NAME}' is already stopped.`);
    return;
  }
  run(k3d, ['cluster', 'stop', DEFAULT_CLUSTER_NAME]);

  outputJson(
    { stopped: true, cluster: DEFAULT_CLUSTER_NAME, context: DEFAULT_KUBE_CONTEXT },
    json,
    `Stopped cluster '${DEFAULT_CLUSTER_NAME}' (state preserved).`,
  );
}

async function handleReset(flags: Record<string, FlagValue>, json: boolean): Promise<void> {
  const force = getBooleanFlag(flags, ['force']) ?? false;
  if (!force) {
    const confirmed = await confirm('Reset local stack (destroy + recreate)? [y/N] ');
    if (!confirmed) {
      throw new Error('Aborted.');
    }
  }

  await handleDown({ ...flags, destroy: true, force: true }, false);
  await handleUp({ ...flags, 'skip-deploy': false }, false);

  if (json) {
    outputJson({ reset: true, cluster: DEFAULT_CLUSTER_NAME }, true);
  }
}

async function handleStatus(flags: Record<string, FlagValue>, json: boolean): Promise<void> {
  const watch = getBooleanFlag(flags, ['watch']) ?? false;
  do {
    const report = await collectStatus();
    if (json) {
      outputJson(report, true);
    } else {
      if (watch) {
        process.stdout.write('\x1Bc');
      }
      renderStatus(report);
    }
    if (!watch) return;
    await sleep(WATCH_INTERVAL_MS);
  } while (true);
}

async function handleHealth(_flags: Record<string, FlagValue>, json: boolean): Promise<void> {
  const report = await collectStatus();
  const unhealthyServices = report.services.filter((service) => !service.healthy);
  const healthy = report.cluster.running && report.api.ok && unhealthyServices.length === 0;

  const payload = {
    healthy,
    cluster: report.cluster,
    api: report.api,
    unhealthy_services: unhealthyServices.map((service) => service.id),
  };

  if (json) {
    outputJson(payload, true);
  } else {
    const icon = healthy ? 'OK' : 'FAIL';
    console.log(`${icon} Local stack health: ${healthy ? 'healthy' : 'unhealthy'}`);
    console.log(`  Cluster: ${report.cluster.exists ? (report.cluster.running ? 'running' : 'stopped') : 'missing'}`);
    console.log(`  API: ${report.api.ok ? `ok (${report.api.status ?? 'ok'})` : `unreachable (${report.api.error ?? 'unknown'})`}`);
    if (unhealthyServices.length > 0) {
      console.log(`  Services: unhealthy -> ${unhealthyServices.map((service) => service.id).join(', ')}`);
    }
  }

  if (!healthy) {
    process.exitCode = 1;
  }
}

function handleLogs(positionals: string[], flags: Record<string, FlagValue>): void {
  const kubectl = findExecutable('kubectl');
  if (!kubectl) {
    throw new Error("kubectl is not installed. Run 'eve local up' first.");
  }

  const cluster = getClusterSnapshot();
  if (!cluster.running) {
    throw new Error(`Cluster '${DEFAULT_CLUSTER_NAME}' is not running. Start it with: eve local up`);
  }

  const service = positionals[0];
  const follow = getBooleanFlag(flags, ['follow', 'f']) ?? false;
  const tail = getStringFlag(flags, ['tail']) ?? '50';
  const since = getStringFlag(flags, ['since']);

  const args = ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'logs'];

  if (service) {
    const target = LOG_TARGETS[service];
    if (!target) {
      const names = Object.keys(LOG_TARGETS).join(', ');
      throw new Error(`Unknown service '${service}'. Supported services: ${names}`);
    }
    args.push(`${target.kind}/${target.resource}`);
  } else {
    args.push('-l', 'app.kubernetes.io/name in (eve-api,eve-orchestrator,eve-worker,eve-gateway,eve-agent-runtime,supabase-auth,eve-sso,mailpit,postgres)');
    args.push('--all-containers=true');
  }

  args.push('--tail', tail);
  if (since) {
    args.push('--since', since);
  }
  if (follow) {
    args.push('-f');
  }

  run(kubectl, args, { stdio: 'inherit' });
}

async function collectStatus(): Promise<LocalStatusReport> {
  const cluster = getClusterSnapshot();
  const services = getServiceStatuses(cluster.running);
  const api = await probeApiHealth(LOCAL_API_URL);

  return {
    cluster: {
      name: DEFAULT_CLUSTER_NAME,
      context: DEFAULT_KUBE_CONTEXT,
      exists: cluster.exists,
      running: cluster.running,
    },
    services,
    api,
    urls: {
      api: LOCAL_API_URL,
      auth: 'http://auth.eve.lvh.me',
      mail: 'http://mail.eve.lvh.me',
      sso: 'http://sso.eve.lvh.me',
    },
  };
}

function renderStatus(report: LocalStatusReport): void {
  const healthyServices = report.services.filter((service) => service.healthy).length;
  const totalServices = report.services.length;
  const clusterStatus = report.cluster.exists
    ? (report.cluster.running ? 'running' : 'stopped')
    : 'missing';

  console.log('Local Eve Environment');
  console.log('─────────────────────');
  console.log(`Cluster:    ${report.cluster.name} (${clusterStatus})`);
  console.log(`Context:    ${report.cluster.context}`);
  console.log(`API Health: ${report.api.ok ? `ok (${report.api.status ?? 'ok'})` : `unreachable (${report.api.error ?? 'unknown'})`}`);
  console.log('');
  console.log(`Services (${healthyServices}/${totalServices} healthy):`);
  for (const service of report.services) {
    const icon = service.healthy ? 'OK' : 'FAIL';
    const ready = `${service.ready}/${service.desired}`;
    const name = service.id.padEnd(13);
    const workload = `${service.kind}/${service.workload}`;
    console.log(`  ${icon} ${name} ${ready.padEnd(5)} ${workload}`);
  }
  console.log('');
  console.log('URLs:');
  console.log(`  API:   ${report.urls.api}`);
  console.log(`  Auth:  ${report.urls.auth}`);
  console.log(`  Mail:  ${report.urls.mail}`);
  console.log(`  SSO:   ${report.urls.sso}`);
}

function getServiceStatuses(clusterRunning: boolean): ServiceStatus[] {
  if (!clusterRunning) {
    return SERVICE_DEFINITIONS.map((service) => ({
      id: service.id,
      workload: service.workload,
      kind: service.kind,
      exists: false,
      desired: 0,
      ready: 0,
      healthy: false,
    }));
  }

  const kubectl = findExecutable('kubectl');
  if (!kubectl) {
    return SERVICE_DEFINITIONS.map((service) => ({
      id: service.id,
      workload: service.workload,
      kind: service.kind,
      exists: false,
      desired: 0,
      ready: 0,
      healthy: false,
    }));
  }

  const raw = run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'get', 'deployments,statefulsets', '-o', 'json'],
    { stdio: 'pipe', allowFailure: true },
  );

  if (raw.status !== 0) {
    return SERVICE_DEFINITIONS.map((service) => ({
      id: service.id,
      workload: service.workload,
      kind: service.kind,
      exists: false,
      desired: 0,
      ready: 0,
      healthy: false,
    }));
  }

  let parsed: { items?: Array<Record<string, unknown>> } = {};
  try {
    parsed = JSON.parse(raw.stdout) as { items?: Array<Record<string, unknown>> };
  } catch {
    return SERVICE_DEFINITIONS.map((service) => ({
      id: service.id,
      workload: service.workload,
      kind: service.kind,
      exists: false,
      desired: 0,
      ready: 0,
      healthy: false,
    }));
  }

  const deployments = new Map<string, Record<string, unknown>>();
  const statefulsets = new Map<string, Record<string, unknown>>();

  for (const item of parsed.items ?? []) {
    const kind = String(item.kind ?? '').toLowerCase();
    const metadata = (item.metadata ?? {}) as Record<string, unknown>;
    const name = String(metadata.name ?? '');
    if (!name) continue;
    if (kind === 'deployment') {
      deployments.set(name, item);
    } else if (kind === 'statefulset') {
      statefulsets.set(name, item);
    }
  }

  return SERVICE_DEFINITIONS.map((service) => {
    const source = service.kind === 'deployment'
      ? deployments.get(service.workload)
      : statefulsets.get(service.workload);

    if (!source) {
      return {
        id: service.id,
        workload: service.workload,
        kind: service.kind,
        exists: false,
        desired: 0,
        ready: 0,
        healthy: false,
      };
    }

    const spec = (source.spec ?? {}) as Record<string, unknown>;
    const status = (source.status ?? {}) as Record<string, unknown>;

    const desired = Number(spec.replicas ?? status.replicas ?? 1);
    const ready = Number(status.readyReplicas ?? 0);
    const healthy = desired > 0 && ready >= desired;

    return {
      id: service.id,
      workload: service.workload,
      kind: service.kind,
      exists: true,
      desired: Number.isFinite(desired) ? desired : 0,
      ready: Number.isFinite(ready) ? ready : 0,
      healthy,
    };
  });
}

async function ensureManagedTool(tool: ManagedTool, runtimeOptions: UpRuntimeOptions): Promise<void> {
  if (findExecutable(tool)) {
    return;
  }

  mkdirSync(MANAGED_BIN_DIR, { recursive: true });

  if (tool === 'k3d') {
    printProgress(runtimeOptions, `Installing k3d ${K3D_VERSION} into ${MANAGED_BIN_DIR}...`);
    await installK3dBinary();
  } else {
    printProgress(runtimeOptions, `Installing kubectl into ${MANAGED_BIN_DIR}...`);
    await installKubectlBinary();
  }

  if (!findExecutable(tool)) {
    throw new Error(`Failed to install ${tool} into ${MANAGED_BIN_DIR}.`);
  }
}

async function installK3dBinary(): Promise<void> {
  const platform = normalizePlatform(process.platform);
  const arch = normalizeArch(process.arch);
  const url = `https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/k3d-${platform}-${arch}`;
  await downloadBinary(url, join(MANAGED_BIN_DIR, 'k3d'));
}

async function installKubectlBinary(): Promise<void> {
  const platform = normalizePlatform(process.platform);
  const arch = normalizeArch(process.arch);
  const stable = (await fetchText(KUBECTL_STABLE_URL)).trim();
  if (!/^v\d+\.\d+\.\d+$/.test(stable)) {
    throw new Error(`Unexpected kubectl stable release format: '${stable}'`);
  }

  const binaryUrl = `https://dl.k8s.io/release/${stable}/bin/${platform}/${arch}/kubectl`;
  const checksumUrl = `${binaryUrl}.sha256`;

  const [binary, checksumText] = await Promise.all([
    downloadBytes(binaryUrl),
    fetchText(checksumUrl),
  ]);

  const expectedChecksum = checksumText.trim();
  const actualChecksum = createHash('sha256').update(binary).digest('hex');
  if (expectedChecksum !== actualChecksum) {
    throw new Error(`kubectl checksum verification failed (expected ${expectedChecksum}, got ${actualChecksum}).`);
  }

  writeExecutable(join(MANAGED_BIN_DIR, 'kubectl'), binary);
}

function normalizePlatform(platform: string): 'darwin' | 'linux' {
  if (platform === 'darwin' || platform === 'linux') {
    return platform;
  }
  throw new Error(`Unsupported platform '${platform}'. 'eve local up' currently supports macOS and Linux.`);
}

function normalizeArch(arch: string): 'amd64' | 'arm64' {
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`Unsupported CPU architecture '${arch}'.`);
}

async function downloadBinary(url: string, destination: string): Promise<void> {
  const bytes = await downloadBytes(url);
  writeExecutable(destination, bytes);
}

async function downloadBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'eve-cli-local-stack',
      Accept: '*/*',
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'eve-cli-local-stack',
        Accept: 'application/json,text/plain,*/*',
        ...(headers ?? {}),
      },
    });

    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = parseInt(response.headers.get('retry-after') ?? '', 10);
      const delay = (retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }

    return response.text();
  }
  throw new Error(`Request failed after ${maxRetries} retries for ${url}`);
}

function writeExecutable(destination: string, bytes: Buffer): void {
  const tempPath = `${destination}.tmp-${Date.now()}-${process.pid}`;
  writeFileSync(tempPath, bytes);
  chmodSync(tempPath, 0o755);
  renameSync(tempPath, destination);
}

async function ensureClusterReady(runtimeOptions: UpRuntimeOptions): Promise<void> {
  const k3d = requireToolPath('k3d', "Run 'eve local up' again to auto-install managed tools.");
  const cluster = getClusterSnapshot();

  if (!cluster.exists) {
    printProgress(runtimeOptions, `Creating cluster '${DEFAULT_CLUSTER_NAME}'...`);
    run(
      k3d,
      [
        'cluster', 'create', DEFAULT_CLUSTER_NAME,
        '--api-port', '127.0.0.1:6443',
        '-p', '80:80@loadbalancer',
        '-p', '443:443@loadbalancer',
      ],
      { stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe' },
    );
  } else if (!cluster.running) {
    printProgress(runtimeOptions, `Starting cluster '${DEFAULT_CLUSTER_NAME}'...`);
    run(k3d, ['cluster', 'start', DEFAULT_CLUSTER_NAME], {
      stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe',
    });
  } else {
    printProgress(runtimeOptions, `Cluster '${DEFAULT_CLUSTER_NAME}' is already running.`);
  }

  trySelectLocalContext();
  await ensureClusterConnectivity(runtimeOptions);
}

async function ensureClusterConnectivity(runtimeOptions: UpRuntimeOptions): Promise<void> {
  const kubectl = requireToolPath('kubectl', "Run 'eve local up' again to auto-install managed tools.");
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const probe = run(kubectl, ['--context', DEFAULT_KUBE_CONTEXT, 'get', 'nodes'], {
      stdio: 'pipe',
      allowFailure: true,
    });

    if (probe.status === 0) {
      return;
    }

    const errorText = `${probe.stderr}\n${probe.stdout}`;
    if (!errorText.includes('EOF')) {
      throw new Error(`Cannot connect to local cluster: ${probe.stderr.trim() || probe.stdout.trim()}`);
    }

    printProgress(runtimeOptions, `Cluster API returned EOF (attempt ${attempt}/${maxAttempts}); restarting load balancer...`);
    run('docker', [`restart`, `k3d-${DEFAULT_CLUSTER_NAME}-serverlb`], { allowFailure: true, stdio: 'pipe' });
    await sleep(2000);
  }

  throw new Error(`Failed to connect to cluster '${DEFAULT_CLUSTER_NAME}' after retrying load balancer restart.`);
}

async function resolveRequestedVersion(requestedVersion: string, runtimeOptions: UpRuntimeOptions): Promise<string> {
  if (requestedVersion === 'latest') {
    const version = await resolveLatestPlatformVersion();
    printProgress(runtimeOptions, `Resolved platform version: ${version}`);
    return version;
  }

  const normalized = normalizeVersion(requestedVersion);
  if (!normalized) {
    throw new Error(`Invalid --version value '${requestedVersion}'. Use a semantic version like '0.1.50' or 'latest'.`);
  }
  return normalized;
}

async function resolveLatestPlatformVersion(): Promise<string> {
  const semverSets = await Promise.all(
    PLATFORM_IMAGES.map(async (image) => {
      const tags = await fetchRegistryTags(image.remote);
      return new Set(
        tags
          .map((tag) => normalizeVersion(tag))
          .filter((value): value is string => Boolean(value)),
      );
    }),
  );

  if (semverSets.length === 0) {
    throw new Error('No platform images configured for local stack deployment.');
  }

  let intersection = new Set<string>(semverSets[0]);
  for (const set of semverSets.slice(1)) {
    intersection = new Set(Array.from(intersection).filter((version) => set.has(version)));
  }

  const candidates = Array.from(intersection);

  if (candidates.length === 0) {
    throw new Error(
      'Unable to resolve a common platform version from configured registry tags. Re-run with --version <x.y.z>.',
    );
  }

  candidates.sort(compareSemverDesc);
  return candidates[0];
}

async function fetchRegistryTags(imageRef: string): Promise<string[]> {
  const slashIndex = imageRef.indexOf('/');
  if (slashIndex < 0) {
    throw new Error(`Invalid image reference '${imageRef}'.`);
  }

  const registry = imageRef.slice(0, slashIndex);
  const repository = imageRef.slice(slashIndex + 1);
  const url = `https://${registry}/v2/${repository}/tags/list?n=200`;
  const token = await fetchRegistryBearerToken(registry, repository);
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const tagsPayload = await fetchText(url, headers);
  return (JSON.parse(tagsPayload) as { tags?: string[] }).tags ?? [];
}

/**
 * Implements Docker Registry v2 token authentication.
 *
 * Public registries (e.g. ECR Public) require the standard v2 auth flow:
 *   1. Probe the /v2/ endpoint — registry returns 401 with a WWW-Authenticate header
 *   2. Parse the Bearer challenge to extract realm, service, and scope
 *   3. Exchange those parameters at the token endpoint for a bearer token
 *
 * Returns the bearer token string, or undefined if no auth challenge is presented
 * (e.g. when the registry allows truly anonymous access).
 */
async function fetchRegistryBearerToken(registry: string, repository: string): Promise<string | undefined> {
  const probeUrl = `https://${registry}/v2/`;
  const probeResponse = await fetch(probeUrl, {
    headers: { 'User-Agent': 'eve-cli-local-stack' },
  });

  if (probeResponse.ok) {
    // Registry did not challenge us — no token needed.
    return undefined;
  }

  if (probeResponse.status !== 401) {
    throw new Error(`Registry probe failed (${probeResponse.status}) for ${probeUrl}`);
  }

  const wwwAuth = probeResponse.headers.get('www-authenticate') ?? '';
  const challenge = parseWwwAuthenticate(wwwAuth);

  if (!challenge.realm) {
    throw new Error(`Registry returned 401 without a Bearer realm in WWW-Authenticate header: ${wwwAuth}`);
  }

  const tokenUrl = new URL(challenge.realm);
  if (challenge.service) {
    tokenUrl.searchParams.set('service', challenge.service);
  }
  // Request repository-scoped pull access rather than the generic scope from the challenge.
  tokenUrl.searchParams.set('scope', `repository:${repository}:pull`);

  const tokenResponse = await fetch(tokenUrl.toString(), {
    headers: { 'User-Agent': 'eve-cli-local-stack' },
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed (${tokenResponse.status}) at ${tokenUrl.toString()}`);
  }

  const tokenData = (await tokenResponse.json()) as { token?: string; access_token?: string };
  // The spec uses "token"; some registries return "access_token" instead.
  return tokenData.token ?? tokenData.access_token;
}

/**
 * Parses a `WWW-Authenticate: Bearer realm="...",service="...",scope="..."` header value
 * into its constituent key-value pairs.
 */
function parseWwwAuthenticate(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Strip the "Bearer " prefix if present.
  const body = header.replace(/^Bearer\s+/i, '');
  // Match key="value" pairs (values may be unquoted).
  const pattern = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

function normalizeVersion(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (candidate.startsWith('release-v')) {
    candidate = candidate.slice('release-v'.length);
  } else if (candidate.startsWith('v')) {
    candidate = candidate.slice(1);
  }

  return /^\d+\.\d+\.\d+$/.test(candidate) ? candidate : null;
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10));
  const pb = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

async function importPlatformImages(version: string, runtimeOptions: UpRuntimeOptions): Promise<void> {
  const docker = requireToolPath('docker', 'Install Docker Desktop.');
  const k3d = requireToolPath('k3d', "Run 'eve local up' again to auto-install managed tools.");
  const stdio = runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe';

  ensureDockerRegistryAuth(docker, runtimeOptions);

  for (const image of PLATFORM_IMAGES) {
    const remoteTag = `${image.remote}:${version}`;
    printProgress(runtimeOptions, `Pulling image ${remoteTag}...`);
    const pull = pullImageWithRetry(docker, remoteTag, stdio, runtimeOptions);
    if (pull.status !== 0) {
      const pullOutput = `${pull.stderr}\n${pull.stdout}`.toLowerCase();
      const isAuthError = pullOutput.includes('403') || pullOutput.includes('401') || pullOutput.includes('unauthorized');
      const hint = isAuthError
        ? 'This is likely an ECR authentication issue. Run: aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws'
        : `Ensure image availability/access at ${image.remote} and the version exists. Try: eve local up --version <x.y.z>`;
      throw new Error(`Failed to pull ${remoteTag}. ${hint}`);
    }

    run(docker, ['tag', remoteTag, image.local], { stdio });
    printProgress(runtimeOptions, `Importing image ${image.component} into k3d...`);
    importImageViaTar(docker, k3d, image.local, image.component, stdio);
  }
}

function importImageViaTar(
  docker: string,
  k3d: string,
  imageTag: string,
  component: string,
  stdio: 'pipe' | 'inherit',
): void {
  const tarPath = join(tmpdir(), `eve-local-${component}-${Date.now()}-${process.pid}.tar`);
  try {
    run(docker, ['image', 'save', '--platform', 'linux/amd64', imageTag, '-o', tarPath], { stdio });
    run(k3d, ['image', 'import', '--mode', 'direct', tarPath, '-c', DEFAULT_CLUSTER_NAME], { stdio });
  } finally {
    if (existsSync(tarPath)) {
      unlinkSync(tarPath);
    }
  }
}

function pullImageWithRetry(
  docker: string,
  remoteTag: string,
  stdio: 'pipe' | 'inherit',
  runtimeOptions: UpRuntimeOptions,
): RunResult {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pull = run(docker, ['pull', '--platform', 'linux/amd64', remoteTag], {
      stdio,
      allowFailure: true,
      timeoutMs: 7 * 60 * 1000,
    });
    if (pull.status === 0) {
      return pull;
    }

    const combined = `${pull.stderr}\n${pull.stdout}`.toLowerCase();
    const retryable = (
      combined.includes('unexpected eof') ||
      combined.includes('short read') ||
      combined.includes('i/o timeout') ||
      combined.includes('timed out') ||
      combined.includes('403 forbidden') ||
      combined.includes('toomanyrequests')
    );
    if (!retryable || attempt === maxAttempts) {
      return pull;
    }

    printProgress(runtimeOptions, `Pull failed for ${remoteTag} (attempt ${attempt}/${maxAttempts}). Retrying...`);
  }

  return { status: 1, stdout: '', stderr: 'pull retry exhausted' };
}

/**
 * Ensures the Docker daemon is authenticated to the platform image registry.
 *
 * ECR Public rate-limits anonymous pulls (1/s, 10/min per IP) and can return
 * 403 Forbidden when limits are hit or stale credentials exist in Docker's
 * credential store. Authenticated pulls have much higher limits.
 *
 * Uses `aws ecr-public get-login-password` when available. If the AWS CLI
 * is not installed we proceed without auth — pulls may still succeed at low
 * volume but will fail under rate limits.
 */
function ensureDockerRegistryAuth(docker: string, runtimeOptions: UpRuntimeOptions): void {
  const registry = PLATFORM_IMAGE_REGISTRY.split('/')[0];
  if (!registry || !registry.includes('ecr.aws')) {
    return;
  }

  printProgress(runtimeOptions, 'Authenticating Docker to ECR public registry...');

  if (dockerLoginViaAwsCli(docker, registry)) {
    printProgress(runtimeOptions, 'Docker registry auth succeeded.');
    return;
  }

  printProgress(
    runtimeOptions,
    'Warning: could not authenticate to ECR. Pulls may hit rate limits.\n' +
    '  Install AWS CLI and configure credentials to avoid this: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
  );
}

function dockerLoginViaAwsCli(docker: string, registry: string): boolean {
  const aws = findExecutable('aws');
  if (!aws) {
    return false;
  }

  const token = run(aws, ['ecr-public', 'get-login-password', '--region', 'us-east-1'], {
    stdio: 'pipe',
    allowFailure: true,
    timeoutMs: 15_000,
  });
  if (token.status !== 0 || !token.stdout.trim()) {
    return false;
  }

  const login = spawnSync(docker, ['login', '--username', 'AWS', '--password-stdin', registry], {
    input: token.stdout.trim(),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return login.status === 0;
}

function applyLocalManifests(runtimeOptions: UpRuntimeOptions): void {
  const kubectl = requireToolPath('kubectl', "Run 'eve local up' again to auto-install managed tools.");
  printProgress(runtimeOptions, 'Applying local Kubernetes manifests...');
  run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, 'apply', '-k', LOCAL_STACK_OVERLAY],
    { stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe' },
  );
}

function buildPlatformImageRegistry(): string {
  if (CONFIGURED_REGISTRY) {
    return `${CONFIGURED_REGISTRY}/${CONFIGURED_NAMESPACE}`;
  }
  return `public.ecr.aws/w7c4v0w3/${DEFAULT_PLATFORM_NAMESPACE}`;
}

function buildPlatformImages(): ImageDefinition[] {
  return [
    { component: 'api', remote: `${PLATFORM_IMAGE_REGISTRY}/api`, local: 'eve-horizon/api:local' },
    { component: 'orchestrator', remote: `${PLATFORM_IMAGE_REGISTRY}/orchestrator`, local: 'eve-horizon/orchestrator:local' },
    { component: 'worker', remote: `${PLATFORM_IMAGE_REGISTRY}/worker`, local: 'eve-horizon/worker:local' },
    { component: 'gateway', remote: `${PLATFORM_IMAGE_REGISTRY}/gateway`, local: 'eve-horizon/gateway:local' },
    { component: 'agent-runtime', remote: `${PLATFORM_IMAGE_REGISTRY}/agent-runtime`, local: 'eve-horizon/agent-runtime:local' },
    { component: 'sso', remote: `${PLATFORM_IMAGE_REGISTRY}/sso`, local: 'eve-horizon/sso:local' },
  ];
}

function readManagerMarker(kubectl: string): string {
  const result = run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, 'get', 'namespace', 'eve', '-o', 'jsonpath={.metadata.annotations.eve-managed-by}'],
    { stdio: 'pipe', allowFailure: true },
  );
  return result.status === 0 ? result.stdout.trim() : '';
}

function writeManagerMarker(kubectl: string, runtimeOptions: UpRuntimeOptions): void {
  run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, 'annotate', 'namespace', 'eve', 'eve-managed-by=cli', '--overwrite'],
    { stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe', allowFailure: true },
  );
}

function runDbMigration(timeoutSeconds: number, runtimeOptions: UpRuntimeOptions): void {
  const kubectl = requireToolPath('kubectl', "Run 'eve local up' again to auto-install managed tools.");
  const migrateJobPath = join(LOCAL_STACK_BASE, 'db-migrate-job.yaml');

  printProgress(runtimeOptions, 'Running database migrations...');
  run(kubectl, ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'delete', 'job/eve-db-migrate', '--ignore-not-found'], {
    stdio: 'pipe',
    allowFailure: true,
  });
  run(kubectl, ['--context', DEFAULT_KUBE_CONTEXT, 'apply', '-f', migrateJobPath], {
    stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe',
  });

  const wait = run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'wait', '--for=condition=complete', 'job/eve-db-migrate', timeoutArg(timeoutSeconds)],
    {
      stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe',
      allowFailure: true,
    },
  );

  if (wait.status !== 0) {
    run(kubectl, ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'logs', 'job/eve-db-migrate'], { stdio: 'inherit', allowFailure: true });
    throw new Error('Database migration failed. Inspect job logs above.');
  }
}

function generateAuthSecrets(runtimeOptions: UpRuntimeOptions): void {
  const kubectl = requireToolPath('kubectl', "Run 'eve local up' again to auto-install managed tools.");

  printProgress(runtimeOptions, 'Generating auth secrets...');
  const existingJwtSecret = readSecretValue(kubectl, 'SUPABASE_JWT_SECRET');
  const existingAdminPassword = readSecretValue(kubectl, 'EVE_AUTH_ADMIN_PASSWORD');
  const existingAuthPrivateKey = readSecretValue(kubectl, 'EVE_AUTH_PRIVATE_KEY');
  const existingAuthPublicKey = readSecretValue(kubectl, 'EVE_AUTH_PUBLIC_KEY');
  const existingInternalApiKey = readSecretValue(kubectl, 'EVE_INTERNAL_API_KEY');
  const existingSecretsMasterKey = readSecretValue(kubectl, 'EVE_SECRETS_MASTER_KEY');
  const existingBootstrapToken = readSecretValue(kubectl, 'EVE_BOOTSTRAP_TOKEN');

  const jwtSecret = existingJwtSecret || randomBytes(32).toString('hex');
  const adminPassword = existingAdminPassword || randomBytes(24).toString('base64url').slice(0, 32);
  const dbUrl = `postgres://eve_auth_admin:${adminPassword}@postgres.eve.svc.cluster.local:5432/eve?sslmode=disable`;

  let authPrivateKey = existingAuthPrivateKey;
  let authPublicKey = existingAuthPublicKey;
  if (!authPrivateKey || !authPublicKey) {
    const keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    authPrivateKey = keyPair.privateKey;
    authPublicKey = keyPair.publicKey;
  }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 10 * 365 * 24 * 60 * 60;
  const serviceKey = generateHs256Jwt({ role: 'service_role', iss: 'supabase', iat, exp }, jwtSecret);
  const anonKey = generateHs256Jwt({ role: 'anon', iss: 'supabase', iat, exp }, jwtSecret);

  const stringData: Record<string, string> = {
    EVE_INTERNAL_API_KEY: existingInternalApiKey || randomBytes(24).toString('hex'),
    EVE_SECRETS_MASTER_KEY: existingSecretsMasterKey || randomBytes(32).toString('hex'),
    EVE_BOOTSTRAP_TOKEN: existingBootstrapToken || randomBytes(24).toString('hex'),
    SUPABASE_JWT_SECRET: jwtSecret,
    EVE_AUTH_ADMIN_PASSWORD: adminPassword,
    SUPABASE_AUTH_DATABASE_URL: dbUrl,
    SUPABASE_AUTH_SERVICE_KEY: serviceKey,
    SUPABASE_ANON_KEY: anonKey,
    EVE_AUTH_PRIVATE_KEY: authPrivateKey,
    EVE_AUTH_PUBLIC_KEY: authPublicKey,
  };

  const optionalKeys = [
    'EVE_GITHUB_WEBHOOK_SECRET',
    'EVE_GATEWAY_PROJECT_ID',
  ];

  for (const key of optionalKeys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      stringData[key] = value;
    }
  }

  const patchPayload = JSON.stringify({ stringData });
  run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'patch', 'secret', 'eve-app', '--type', 'merge', '-p', patchPayload],
    { stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe' },
  );
}

function readSecretValue(kubectl: string, key: string): string {
  const result = run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'get', 'secret', 'eve-app', '-o', `jsonpath={.data.${key}}`],
    { stdio: 'pipe', allowFailure: true },
  );

  if (result.status !== 0) {
    return '';
  }

  const encoded = result.stdout.trim();
  if (!encoded) {
    return '';
  }

  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function runAuthBootstrap(timeoutSeconds: number, runtimeOptions: UpRuntimeOptions): void {
  const kubectl = requireToolPath('kubectl', "Run 'eve local up' again to auto-install managed tools.");
  const bootstrapJobPath = join(LOCAL_STACK_BASE, 'auth-bootstrap-job.yaml');

  printProgress(runtimeOptions, 'Bootstrapping auth database role...');
  run(kubectl, ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'delete', 'job/auth-db-bootstrap', '--ignore-not-found'], {
    stdio: 'pipe',
    allowFailure: true,
  });
  run(kubectl, ['--context', DEFAULT_KUBE_CONTEXT, 'apply', '-f', bootstrapJobPath], {
    stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe',
  });

  const wait = run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'wait', '--for=condition=complete', 'job/auth-db-bootstrap', timeoutArg(timeoutSeconds)],
    {
      stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe',
      allowFailure: true,
    },
  );

  if (wait.status !== 0) {
    run(kubectl, ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'logs', 'job/auth-db-bootstrap'], { stdio: 'inherit', allowFailure: true });
    throw new Error('Auth bootstrap failed. Inspect job logs above.');
  }
}

function restartAndWaitRollouts(timeoutSeconds: number, runtimeOptions: UpRuntimeOptions): void {
  const kubectl = requireToolPath('kubectl', "Run 'eve local up' again to auto-install managed tools.");

  printProgress(runtimeOptions, 'Restarting and waiting for service rollouts...');
  run(
    kubectl,
    [
      '--context', DEFAULT_KUBE_CONTEXT,
      '-n', 'eve',
      'rollout', 'restart',
      'deployment/eve-api',
      'deployment/eve-orchestrator',
      'deployment/eve-worker',
      'deployment/eve-gateway',
      'deployment/supabase-auth',
      'deployment/mailpit',
      'deployment/eve-sso',
    ],
    { stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe' },
  );

  run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'rollout', 'restart', 'statefulset/eve-agent-runtime'],
    { stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe' },
  );

  const workloads: Array<{ kind: 'deployment' | 'statefulset'; name: string }> = [
    { kind: 'deployment', name: 'eve-api' },
    { kind: 'deployment', name: 'eve-orchestrator' },
    { kind: 'deployment', name: 'eve-worker' },
    { kind: 'deployment', name: 'eve-gateway' },
    { kind: 'deployment', name: 'supabase-auth' },
    { kind: 'deployment', name: 'mailpit' },
    { kind: 'deployment', name: 'eve-sso' },
    { kind: 'statefulset', name: 'eve-agent-runtime' },
  ];

  for (const workload of workloads) {
    const status = run(
      kubectl,
      ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'rollout', 'status', `${workload.kind}/${workload.name}`, timeoutArg(timeoutSeconds)],
      {
        stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe',
        allowFailure: true,
      },
    );

    if (status.status !== 0) {
      throw new Error(`Rollout failed for ${workload.kind}/${workload.name}. Run 'eve local status' and inspect service logs with 'eve local logs <service>'.`);
    }
  }
}

function waitForStatefulSetRollout(name: string, timeoutSeconds: number, runtimeOptions: UpRuntimeOptions): void {
  const kubectl = requireToolPath('kubectl', "Run 'eve local up' again to auto-install managed tools.");
  const status = run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, '-n', 'eve', 'rollout', 'status', `statefulset/${name}`, timeoutArg(timeoutSeconds)],
    {
      stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe',
      allowFailure: true,
    },
  );

  if (status.status !== 0) {
    throw new Error(`StatefulSet '${name}' did not become ready in ${timeoutSeconds}s.`);
  }
}

function timeoutArg(timeoutSeconds: number): string {
  return `--timeout=${Math.max(timeoutSeconds, 1)}s`;
}

function generateHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const headerBase64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${headerBase64}.${payloadBase64}`)
    .digest('base64url');
  return `${headerBase64}.${payloadBase64}.${signature}`;
}

function assertLocalAssetsPresent(): void {
  const files = [
    LOCAL_STACK_OVERLAY,
    LOCAL_STACK_BASE,
    join(LOCAL_STACK_OVERLAY, 'kustomization.yaml'),
    join(LOCAL_STACK_BASE, 'db-migrate-job.yaml'),
    join(LOCAL_STACK_BASE, 'auth-bootstrap-job.yaml'),
  ];

  for (const file of files) {
    if (!existsSync(file)) {
      throw new Error(
        `Missing local stack assets at ${file}. ` +
        'Reinstall the CLI or ensure package assets were published.',
      );
    }
  }
}

async function waitForApiHealth(url: string, timeoutSeconds: number): Promise<LocalStatusReport['api']> {
  const deadline = Date.now() + Math.max(timeoutSeconds, 1) * 1000;
  let latest = await probeApiHealth(url);
  while (!latest.ok && Date.now() < deadline) {
    await sleep(2000);
    latest = await probeApiHealth(url);
  }
  if (!latest.ok) {
    throw new Error(`Local API did not become healthy within ${timeoutSeconds}s (${latest.error ?? 'unknown error'}).`);
  }
  return latest;
}

async function probeApiHealth(url: string): Promise<LocalStatusReport['api']> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    if (!response.ok) {
      return {
        url,
        ok: false,
        error: `HTTP ${response.status}`,
      };
    }
    const payload = await response.json() as { status?: string; timestamp?: string };
    return {
      url,
      ok: payload.status === 'ok' || payload.status === 'healthy',
      status: payload.status,
      timestamp: payload.timestamp,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      url,
      ok: false,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getClusterSnapshot(): { exists: boolean; running: boolean } {
  const k3d = findExecutable('k3d');
  if (!k3d) {
    return { exists: false, running: false };
  }

  const result = run(k3d, ['cluster', 'list', '-o', 'json'], {
    stdio: 'pipe',
    allowFailure: true,
  });
  if (result.status !== 0) {
    return { exists: false, running: false };
  }

  try {
    const payload = JSON.parse(result.stdout) as Array<{
      name?: string;
      serversRunning?: number;
      serversCount?: number;
    }>;
    const cluster = payload.find((item) => item.name === DEFAULT_CLUSTER_NAME);
    if (!cluster) {
      return { exists: false, running: false };
    }
    const serversRunning = Number(cluster.serversRunning ?? 0);
    const serversCount = Number(cluster.serversCount ?? 0);
    return {
      exists: true,
      running: serversCount > 0 && serversRunning >= serversCount,
    };
  } catch {
    return { exists: false, running: false };
  }
}

function parseTimeoutSeconds(flags: Record<string, FlagValue>, defaultValue: number): number {
  const raw = getStringFlag(flags, ['timeout']);
  if (!raw) return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid --timeout value: ${raw}`);
  }
  return value;
}

function run(command: string, args: string[], options: RunOptions = {}): RunResult {
  const env = { ...process.env };
  if (existsSync(MANAGED_BIN_DIR)) {
    env.PATH = `${MANAGED_BIN_DIR}:${env.PATH ?? ''}`;
  }

  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env,
    timeout: options.timeoutMs,
  });

  const status = result.status ?? 1;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (status !== 0 && !options.allowFailure) {
    const message = stderr.trim() || stdout.trim() || `${command} exited with status ${status}`;
    throw new Error(message);
  }

  return { status, stdout, stderr };
}

function findExecutable(name: string): string | undefined {
  const managed = join(MANAGED_BIN_DIR, name);
  if (existsSync(managed)) {
    return managed;
  }
  const found = spawnSync('which', [name], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (found.status === 0 && found.stdout.trim()) {
    return found.stdout.trim();
  }
  return undefined;
}

function ensureTool(name: string, installHint: string): void {
  if (!findExecutable(name)) {
    throw new Error(`Missing required tool '${name}'. ${installHint}`);
  }
}

function requireToolPath(name: string, hint: string): string {
  const path = findExecutable(name);
  if (!path) {
    throw new Error(`Missing required tool '${name}'. ${hint}`);
  }
  return path;
}

function assertDockerRunning(): void {
  const docker = findExecutable('docker');
  if (!docker) {
    throw new Error("Missing required tool 'docker'. Install Docker Desktop.");
  }
  const result = run(docker, ['info'], { stdio: 'pipe', allowFailure: true });
  if (result.status !== 0) {
    throw new Error('Docker daemon is not reachable. Start Docker Desktop and retry.');
  }
}

function trySelectLocalContext(): void {
  const kubectl = findExecutable('kubectl');
  if (!kubectl) {
    return;
  }

  const exists = run(
    kubectl,
    ['config', 'get-contexts', DEFAULT_KUBE_CONTEXT],
    { stdio: 'pipe', allowFailure: true },
  );
  if (exists.status !== 0) {
    return;
  }

  run(
    kubectl,
    ['config', 'use-context', DEFAULT_KUBE_CONTEXT],
    { stdio: 'pipe', allowFailure: true },
  );
}

function printProgress(runtimeOptions: UpRuntimeOptions, message: string): void {
  if (!runtimeOptions.quiet) {
    console.log(message);
  }
}

async function confirm(promptText: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(promptText);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
