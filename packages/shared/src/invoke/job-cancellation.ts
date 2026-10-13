import type { ChildProcess } from 'node:child_process';

export const JOB_CANCELLED = 'job_cancelled: Job was cancelled';

export interface JobCancellationMonitor {
  signal: AbortSignal;
  check: () => Promise<void>;
  stop: () => void;
}

/** Poll independently of log traffic, including a final check before publishing results. */
export async function watchJobCancellation(
  readPhase: () => Promise<string | undefined>,
  intervalMs = 2_000,
): Promise<JobCancellationMonitor> {
  const controller = new AbortController();
  let stopped = false;
  let pending: Promise<void> | undefined;
  const check = (): Promise<void> => {
    if (stopped || controller.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      if (await readPhase() === 'cancelled' && !stopped) {
        controller.abort(new Error(JOB_CANCELLED));
      }
    })().catch((error) => {
      console.warn('[cancellation] Job status check failed:', error instanceof Error ? error.message : String(error));
    }).finally(() => { pending = undefined; });
    return pending;
  };
  await check();
  const timer = setInterval(() => { void check(); }, intervalMs);
  timer.unref();
  return { signal: controller.signal, check, stop: () => { stopped = true; clearInterval(timer); } };
}

/** The caller must spawn a detached process group on POSIX. Never signal our own group. */
export function bindProcessCancellation(child: ChildProcess, signal?: AbortSignal, graceMs = 5_000): () => Promise<void> {
  let termination: Promise<void> | undefined;
  const send = (name: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.warn('[cancellation] Process termination failed:', error);
      }
    }
  };
  const cancel = (): void => {
    if (termination) return;
    send('SIGTERM');
    // Keep escalation alive even if the shell exits first: descendants may ignore TERM.
    termination = new Promise<void>((resolve) => {
      setTimeout(() => { send('SIGKILL'); resolve(); }, graceMs);
    });
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return async () => {
    signal?.removeEventListener('abort', cancel);
    await termination;
  };
}
