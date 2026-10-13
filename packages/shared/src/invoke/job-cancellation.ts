import { execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

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

type ProcessIdentity = { pid: number; parent: number; group: number; birth: string };

function linuxProcess(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, parent: Number(fields[1]), group: Number(fields[2]), birth: fields[19] };
  } catch { return undefined; } // Processes can exit during enumeration.
}

function processSnapshot(): Map<number, ProcessIdentity> {
  const processes = new Map<number, ProcessIdentity>();
  try {
    if (process.platform === 'linux') {
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const entry = linuxProcess(Number(name));
        if (entry) processes.set(entry.pid, entry);
      }
    } else if (process.platform !== 'win32') {
      const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 1_000 });
      for (const line of output.trim().split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (match) processes.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), birth: match[4] });
      }
    }
  } catch (error) { console.warn('[cancellation] Could not inspect process tree:', error); }
  return processes;
}

/** Spawn a detached POSIX group; track descendants too because tools can create new groups. */
export function bindProcessCancellation(child: ChildProcess, signal?: AbortSignal, graceMs = 5_000): () => Promise<void> {
  if (!signal) return async () => {};
  const root = child.pid;
  const identity = root && (process.platform === 'linux' ? linuxProcess(root) : processSnapshot().get(root));
  let termination: Promise<void> | undefined;
  const members = new Map<number, ProcessIdentity>();
  if (identity) members.set(identity.pid, identity);

  const collect = (snapshot: Map<number, ProcessIdentity>): void => {
    if (!root) return;
    const currentRoot = snapshot.get(root);
    if (identity && currentRoot && identity.birth !== currentRoot.birth) return;
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of snapshot.values()) {
        if (members.get(entry.pid)?.birth === entry.birth) continue;
        const parent = members.get(entry.parent);
        const currentParent = snapshot.get(entry.parent);
        if (entry.group === root || (parent && currentParent?.birth === parent.birth)) {
          members.set(entry.pid, entry); changed = true;
        }
      }
    }
  };
  const send = (name: NodeJS.Signals, snapshot: Map<number, ProcessIdentity>): void => {
    if (!root) return;
    const signalPid = (pid: number): void => {
      try { process.kill(pid, name); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.warn('[cancellation] Process termination failed:', error);
      }
    };
    const currentRoot = snapshot.get(root);
    // A live original group reserves its PGID. Reject a recycled leader PID.
    if (!identity || !currentRoot || currentRoot.birth === identity.birth) {
      if (process.platform === 'win32') child.kill(name);
      else signalPid(-root);
    }
    for (const member of members.values()) {
      const current = snapshot.get(member.pid);
      // Match process identity and cover tools that escaped the original group.
      if (current?.birth === member.birth && current.group !== root) signalPid(member.pid);
    }
  };
  const cancel = (): void => {
    if (termination) return;
    const snapshot = processSnapshot();
    collect(snapshot);
    send('SIGTERM', snapshot);
    termination = new Promise<void>((resolve) => {
      // Capture children created while a surviving process handles SIGTERM.
      const census = setInterval(() => { collect(processSnapshot()); }, Math.min(100, graceMs));
      setTimeout(() => {
        clearInterval(census);
        const final = processSnapshot();
        collect(final);
        send('SIGKILL', final);
        resolve();
      }, graceMs);
    });
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return async () => {
    signal?.removeEventListener('abort', cancel);
    await termination;
  };
}
