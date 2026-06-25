import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { getCorrelationHeaders, loadConfig } from '@eve/shared';
import type { HarnessInvocation, HarnessResult } from '@eve/shared';
import { buildToolchainRuntimeMeta, type ToolchainRuntimeMeta } from './toolchains';

const DEFAULT_NAMESPACE = 'eve';
const DEFAULT_WORKSPACE_SIZE = '10Gi';
const RUNNER_PORT = 4749;

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

interface RunnerEvent {
  id: string;
  type: string;
  payload_json: {
    attemptId: string;
    jobId: string;
    result?: HarnessResult;
    error?: string;
    exitCode?: number;
  };
}

async function pollForCompletion(
  projectId: string,
  attemptId: string,
  pollIntervalMs: number = 5000,
  timeoutMs: number = 1800000, // 30 min default
): Promise<HarnessResult> {
  const config = loadConfig();
  const startTime = Date.now();
  let pollCount = 0;
  let lastLoggedStatus = 0;

  // Use `since` to avoid fetching stale events from previous runs
  const since = new Date(startTime - 60_000).toISOString(); // 1 minute buffer
  const url = `${config.EVE_API_URL}/internal/projects/${projectId}/events?type=runner.completed,runner.failed&since=${encodeURIComponent(since)}&limit=50`;
  console.log(`[k8s-poll] Starting poll for attemptId=${attemptId} projectId=${projectId}`);
  console.log(`[k8s-poll] URL: ${url}`);
  console.log(`[k8s-poll] Has internal API key: ${!!config.EVE_INTERNAL_API_KEY}`);

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    try {
      const response = await fetch(url, {
        headers: {
          'x-eve-internal-token': config.EVE_INTERNAL_API_KEY!,
          ...getCorrelationHeaders(),
        },
      });

      if (response.ok) {
        const json = await response.json();
        const events = json.data || [];

        // Find event matching our attemptId
        const completionEvent = events.find((e: RunnerEvent) =>
          e.payload_json?.attemptId === attemptId &&
          (e.type === 'runner.completed' || e.type === 'runner.failed')
        );

        if (completionEvent) {
          console.log(`[k8s-poll] Found completion event after ${pollCount} polls (${Date.now() - startTime}ms): type=${completionEvent.type}`);
          if (completionEvent.type === 'runner.completed') {
            return completionEvent.payload_json.result!;
          } else {
            // runner.failed
            return {
              attemptId: attemptId as any,
              success: false,
              exitCode: completionEvent.payload_json.exitCode ?? 1,
              error: completionEvent.payload_json.error || 'Runner failed',
            };
          }
        }

        // Log periodically when no match found (every 30s)
        const elapsed = Date.now() - startTime;
        if (elapsed - lastLoggedStatus >= 30000) {
          lastLoggedStatus = elapsed;
          const attemptIds = events.map((e: RunnerEvent) => e.payload_json?.attemptId).filter(Boolean);
          console.log(`[k8s-poll] Poll #${pollCount} (${Math.round(elapsed / 1000)}s): ${events.length} events returned, none match attemptId=${attemptId}. Response key: ${Object.keys(json).join(',')}. Event attemptIds: [${attemptIds.join(', ')}]`);
        }
      } else {
        const body = await response.text().catch(() => '<unreadable>');
        // Log non-ok responses every time for the first 3, then every 30s
        if (pollCount <= 3 || Date.now() - startTime - lastLoggedStatus >= 30000) {
          lastLoggedStatus = Date.now() - startTime;
          console.error(`[k8s-poll] Poll #${pollCount}: HTTP ${response.status} ${response.statusText}. Body: ${body.slice(0, 500)}`);
        }
      }
    } catch (err) {
      console.warn(`[k8s-poll] Poll #${pollCount} exception: ${err instanceof Error ? err.message : String(err)}`);
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout
  console.error(`[k8s-poll] TIMEOUT after ${pollCount} polls (${timeoutMs}ms) for attemptId=${attemptId}`);
  return {
    attemptId: attemptId as any,
    success: false,
    exitCode: 1,
    error: `Runner timed out after ${timeoutMs}ms`,
  };
}

function execKubectl(args: string[], input?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
}

function normalizeNameRaw(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function buildK8sName(base: string, hash: string, limit = 63): string {
  const normalized = normalizeNameRaw(base);
  const suffix = `-${hash}`;
  const maxBase = Math.max(1, limit - suffix.length);
  const trimmed = normalized.slice(0, maxBase);
  return `${trimmed}${suffix}`.slice(0, limit);
}

function sanitizeLabelValue(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-_.]/g, '-');
  const trimmed = normalized.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
  const safe = trimmed.slice(0, 63);
  return safe || 'unknown';
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function pushOptionalEnv(entries: { name: string; value: string }[], name: string): void {
  const value = process.env[name];
  if (!value) return;
  entries.push({ name, value });
}

function pushPrefixedEnv(entries: { name: string; value: string }[], prefixes: string[]): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
    entries.push({ name: key, value });
  }
}

function buildRunnerManifests(
  invocation: HarnessInvocation,
  namespace: string,
  pvcName: string,
  podName: string,
): string {
  const runnerImage = requiredEnv('EVE_RUNNER_IMAGE');
  const workspaceSize = optionalEnv('EVE_K8S_WORKSPACE_SIZE', DEFAULT_WORKSPACE_SIZE);
  const serviceAccount = process.env.EVE_RUNNER_SERVICE_ACCOUNT;
  const dbUrl = requiredEnv('DATABASE_URL');
  const jobLabel = sanitizeLabelValue(invocation.jobId);
  const attemptLabel = sanitizeLabelValue(invocation.attemptId);
  const envEntries: Array<{ name: string; value: string }> = [
    { name: 'DATABASE_URL', value: dbUrl },
    { name: 'WORKER_PORT', value: String(RUNNER_PORT) },
    { name: 'EVE_K8S_NAMESPACE', value: namespace },
    { name: 'EVE_RUN_AS_UID', value: '1000' },
    { name: 'EVE_RUN_AS_GID', value: '1000' },
    { name: 'EVE_WORKSPACE_ROOT', value: '/opt/eve/workspaces' },
    { name: 'EVE_CACHE_ROOT', value: '/opt/eve/cache' },
    { name: 'EVE_STATE_ROOT', value: '/opt/eve/state' },
    { name: 'EVE_TOOLCHAIN_ROOT', value: '/opt/eve/toolchains' },
  ];

  // Platform infra — needed for the runner pod to reach internal APIs
  pushOptionalEnv(envEntries, 'EVE_API_URL');
  pushOptionalEnv(envEntries, 'EVE_INTERNAL_API_KEY');
  pushOptionalEnv(envEntries, 'EVE_SECRETS_MASTER_KEY');
  pushOptionalEnv(envEntries, 'EVE_K8S_SERVICE_READY_TIMEOUT');
  // LLM provider keys and GitHub tokens are NOT forwarded from process.env.
  // They flow through Eve org/project-level secrets, resolved at runtime
  // inside the runner pod via the secrets API.
  pushPrefixedEnv(envEntries, ['EVE_WORKER_', 'EVE_HARNESS_']);

  // Build init containers for toolchain injection
  const toolchains = [...new Set(invocation.toolchains ?? [])];
  const toolchainImagePrefix = process.env.EVE_TOOLCHAIN_IMAGE_PREFIX ?? 'eve-horizon/toolchain-';
  const toolchainImageTag = process.env.EVE_TOOLCHAIN_IMAGE_TAG ?? 'local';

  const initContainers = toolchains.map(tc => ({
    name: `tc-${tc}`,
    image: `${toolchainImagePrefix}${tc}:${toolchainImageTag}`,
    imagePullPolicy: 'IfNotPresent' as const,
    command: ['sh', '-c', `cp -a /toolchain/. /opt/eve/toolchains/${tc}/`],
    volumeMounts: [{
      name: 'toolchains',
      mountPath: `/opt/eve/toolchains/${tc}`,
      subPath: tc,
    }],
  }));

  if (toolchains.length > 0) {
    const toolchainPaths = [...new Set(toolchains)].map(tc => `/opt/eve/toolchains/${tc}/bin`).join(':');
    envEntries.push({
      name: 'EVE_TOOLCHAIN_PATHS',
      value: toolchainPaths,
    });
  }

  // Build init containers for image-based app CLIs
  const appClis = invocation.appClis ?? [];
  for (const cli of appClis) {
    initContainers.push({
      name: `cli-${cli.name}`,
      image: cli.image,
      imagePullPolicy: 'IfNotPresent' as const,
      command: ['sh', '-c', `cp -a /cli/. /opt/eve/app-cli/${cli.name}/`],
      volumeMounts: [{
        name: 'app-cli',
        mountPath: `/opt/eve/app-cli/${cli.name}`,
        subPath: cli.name,
      }],
    });
  }

  if (appClis.length > 0) {
    const cliPaths = appClis.map(c => `/opt/eve/app-cli/${c.name}/bin`).join(':');
    envEntries.push({
      name: 'EVE_APP_CLI_PATHS',
      value: cliPaths,
    });
  }

  const manifest = {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: pvcName,
          namespace,
          labels: {
            'eve.type': 'runner',
            'eve.job_id': jobLabel,
            'eve.attempt_id': attemptLabel,
          },
          annotations: {
            'eve.job_id': invocation.jobId,
            'eve.attempt_id': invocation.attemptId,
          },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: {
            requests: {
              storage: workspaceSize,
            },
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: podName,
          namespace,
          labels: {
            'eve.type': 'runner',
            'eve.job_id': jobLabel,
            'eve.attempt_id': attemptLabel,
          },
          annotations: {
            'eve.job_id': invocation.jobId,
            'eve.attempt_id': invocation.attemptId,
          },
        },
        spec: {
          activeDeadlineSeconds: parseInt(process.env.EVE_K8S_ACTIVE_DEADLINE_SECONDS ?? '7200', 10),
          restartPolicy: 'Never',
          serviceAccountName: serviceAccount,
          securityContext: {
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: 'OnRootMismatch',
          },
          ...(initContainers.length > 0 ? { initContainers } : {}),
          containers: [
            {
              name: 'runner',
              image: runnerImage,
              env: envEntries,
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
              },
              resources: {
                requests: {
                  cpu: process.env.EVE_K8S_RUNNER_CPU_REQUEST ?? '100m',
                  memory: process.env.EVE_K8S_RUNNER_MEMORY_REQUEST ?? '256Mi',
                },
                limits: {
                  cpu: process.env.EVE_K8S_RUNNER_CPU_LIMIT ?? '2000m',
                  memory: process.env.EVE_K8S_RUNNER_MEMORY_LIMIT ?? '2Gi',
                },
              },
              readinessProbe: {
                httpGet: {
                  path: '/health',
                  port: RUNNER_PORT,
                },
                initialDelaySeconds: 5,
                periodSeconds: 2,
                failureThreshold: 15,
              },
              ports: [{ containerPort: RUNNER_PORT }],
              volumeMounts: [
                {
                  name: 'workspace',
                  mountPath: '/opt/eve/workspaces',
                },
                ...(toolchains.length > 0 ? [{
                  name: 'toolchains',
                  mountPath: '/opt/eve/toolchains',
                }] : []),
                ...(appClis.length > 0 ? [{
                  name: 'app-cli',
                  mountPath: '/opt/eve/app-cli',
                }] : []),
              ],
            },
          ],
          volumes: [
            {
              name: 'workspace',
              persistentVolumeClaim: { claimName: pvcName },
            },
            ...(toolchains.length > 0 ? [{ name: 'toolchains', emptyDir: {} }] : []),
            ...(appClis.length > 0 ? [{ name: 'app-cli', emptyDir: {} }] : []),
          ],
        },
      },
    ],
  };

  return JSON.stringify(manifest);
}

async function waitForPodReady(namespace: string, podName: string): Promise<void> {
  const timeout = optionalEnv('EVE_K8S_POD_READY_TIMEOUT', '60s');
  const result = await execKubectl([
    'wait',
    `--namespace=${namespace}`,
    `--for=condition=Ready`,
    `pod/${podName}`,
    `--timeout=${timeout}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed waiting for runner pod: ${result.stderr || result.stdout}`);
  }
}

async function getPodIp(namespace: string, podName: string): Promise<string> {
  const result = await execKubectl([
    'get',
    'pod',
    podName,
    `--namespace=${namespace}`,
    '-o',
    'jsonpath={.status.podIP}',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get runner pod IP: ${result.stderr || result.stdout}`);
  }
  const ip = result.stdout.trim();
  if (!ip) {
    throw new Error('Runner pod has no IP yet');
  }
  return ip;
}

async function waitForRunner(port: number, ip: string): Promise<void> {
  const attempts = parseInt(optionalEnv('EVE_K8S_RUNNER_RETRIES', '20'), 10);
  const delayMs = parseInt(optionalEnv('EVE_K8S_RUNNER_RETRY_DELAY_MS', '1000'), 10);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`http://${ip}:${port}/health`, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Runner not ready after ${attempts} attempts`);
}

async function deleteResources(namespace: string, pvcName: string, podName: string): Promise<void> {
  try {
    await execKubectl(['delete', 'pod', podName, `--namespace=${namespace}`, '--ignore-not-found=true', '--wait=false']);
  } catch (err) {
    console.error(`Failed to delete pod ${podName}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await execKubectl(['delete', 'pvc', pvcName, `--namespace=${namespace}`, '--ignore-not-found=true', '--wait=false']);
  } catch (err) {
    console.error(`Failed to delete PVC ${pvcName}: ${err instanceof Error ? err.message : err}`);
  }
}

type LifecycleLogger = (
  phase: 'runner',
  action: 'start' | 'end' | 'log',
  meta: Record<string, unknown>,
  opts?: { duration_ms?: number; success?: boolean; error?: string; [key: string]: unknown }
) => Promise<void>;

export async function runInvocationInK8s(
  invocation: HarnessInvocation,
  onPodCreated?: (runtimeMeta: { runtime: string; pod_name: string; namespace: string; toolchains?: ToolchainRuntimeMeta }) => Promise<void>,
  logLifecycle?: LifecycleLogger
): Promise<HarnessResult> {
  const namespace = optionalEnv('EVE_K8S_NAMESPACE', DEFAULT_NAMESPACE);
  const rawAttempt = normalizeNameRaw(invocation.attemptId);
  const attemptHash = shortHash(invocation.attemptId);
  const pvcName = buildK8sName(`eve-ws-${rawAttempt}`, attemptHash);
  const podName = buildK8sName(`eve-runner-${rawAttempt}`, attemptHash);

  const workspacePath = `/opt/eve/workspaces/${invocation.attemptId}`;
  const k8sInvocation: HarnessInvocation = {
    ...invocation,
    workspacePath,
  };
  const toolchains = [...new Set(k8sInvocation.toolchains ?? [])];

  const manifest = buildRunnerManifests(k8sInvocation, namespace, pvcName, podName);

  const startTime = Date.now();
  if (logLifecycle) {
    await logLifecycle('runner', 'start', { pod_name: podName, namespace });
  }

  const applyResult = await execKubectl(['apply', '-f', '-'], manifest);
  if (applyResult.exitCode !== 0) {
    await deleteResources(namespace, pvcName, podName);
    if (logLifecycle) {
      await logLifecycle('runner', 'end', { pod_name: podName, namespace }, {
        duration_ms: Date.now() - startTime,
        success: false,
        error: `Failed to apply runner manifests: ${applyResult.stderr || applyResult.stdout}`,
      });
    }
    throw new Error(`Failed to apply runner manifests: ${applyResult.stderr || applyResult.stdout}`);
  }

  try {
    // Notify caller about pod creation with runtime metadata
    if (onPodCreated) {
      await onPodCreated({
        runtime: 'k8s',
        pod_name: podName,
        namespace,
        ...(toolchains.length > 0
          ? {
              toolchains: buildToolchainRuntimeMeta({
                executionMode: 'runner',
                requested: toolchains,
                resolved: toolchains,
                missing: [],
                source: 'init_container',
              }),
            }
          : {}),
      });
    }

    await waitForPodReady(namespace, podName);

    if (logLifecycle) {
      await logLifecycle('runner', 'end', { pod_name: podName, namespace }, {
        duration_ms: Date.now() - startTime,
        success: true,
      });
    }

    const podIp = await getPodIp(namespace, podName);
    await waitForRunner(RUNNER_PORT, podIp);

    // Submit job (returns 202 immediately)
    const submitResponse = await fetch(`http://${podIp}:${RUNNER_PORT}/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getCorrelationHeaders(),
      },
      body: JSON.stringify(k8sInvocation),
    });

    if (!submitResponse.ok) {
      const body = await submitResponse.text();
      throw new Error(`Runner invoke submit failed: ${submitResponse.status} ${body}`);
    }

    const submitResult = await submitResponse.json();
    if (!submitResult.accepted) {
      throw new Error(`Runner rejected job: ${submitResult.error || 'unknown'}`);
    }

    // Poll for completion
    const pollTimeout = parseInt(optionalEnv('EVE_K8S_POLL_TIMEOUT_MS', '1800000'), 10);
    const pollInterval = parseInt(optionalEnv('EVE_K8S_POLL_INTERVAL_MS', '5000'), 10);
    return await pollForCompletion(
      invocation.projectId,
      invocation.attemptId,
      pollInterval,
      pollTimeout,
    );
  } catch (err) {
    if (logLifecycle) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await logLifecycle('runner', 'end', { pod_name: podName, namespace }, {
        duration_ms: Date.now() - startTime,
        success: false,
        error: errorMessage,
      });
    }
    throw err;
  } finally {
    await deleteResources(namespace, pvcName, podName);
  }
}
