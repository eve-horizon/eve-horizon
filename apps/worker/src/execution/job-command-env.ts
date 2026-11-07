/**
 * The environment a job command (pipeline script step, action `run` command)
 * starts with when the worker runs it in-process.
 *
 * It is an allowlist. The worker's own environment carries DATABASE_URL, the
 * internal API key, the secrets master key, storage and cloud credentials and
 * Kubernetes service discovery; none of that is job code's business. Job code
 * reaches Eve through EVE_API_URL with its own scoped EVE_JOB_TOKEN, and gets
 * project secrets only through declared env_overrides.
 */

/**
 * Worker env keys a job command may inherit. Everything else stays in the worker,
 * including KUBERNETES_SERVICE_HOST/PORT: a script should not silently act with
 * the worker's in-cluster identity.
 */
export const JOB_COMMAND_INHERITED_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'USER',
  'SHELL',
  'TMPDIR',
  // Egress settings, so commands work behind a proxy or private CA.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'EVE_API_URL',
  'EVE_PUBLIC_API_URL',
  'EVE_TOOLCHAIN_INIT_MOUNTED',
  'EVE_RUNTIME_IMAGE_DIGEST',
] as const;

export interface JobCommandEnvContext {
  /** HOME for the command. Defaults to the worker's HOME. */
  home?: string;
  jobId?: string;
  projectId?: string;
  attemptId?: string;
  runId?: string;
  envName?: string | null;
  envNamespace?: string | null;
  jobToken?: string;
}

export function buildJobCommandEnv(
  context: JobCommandEnvContext,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of JOB_COMMAND_INHERITED_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  const job: Record<string, string | null | undefined> = {
    HOME: context.home ?? source.HOME,
    EVE_JOB_ID: context.jobId,
    EVE_PROJECT_ID: context.projectId,
    EVE_ATTEMPT_ID: context.attemptId,
    EVE_RUN_ID: context.runId,
    EVE_ENV_NAME: context.envName,
    EVE_ENV_NAMESPACE: context.envNamespace,
    EVE_JOB_TOKEN: context.jobToken,
  };
  for (const [key, value] of Object.entries(job)) {
    if (value) env[key] = value;
  }
  return env;
}
