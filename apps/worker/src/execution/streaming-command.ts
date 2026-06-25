import { spawn } from 'child_process';

type StreamName = 'stdout' | 'stderr';

export interface StreamingCommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
  durationMs: number;
}

export interface StreamingCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  attemptId: string;
  timeoutMs: number;
  timeoutCode: 'script_timeout' | 'action_run_timeout';
  appendLog: (attemptId: string, type: string, content: Record<string, unknown>) => Promise<void>;
  outputCapBytes?: number;
  tailBytes?: number;
  killGraceMs?: number;
  flushLineCount?: number;
  flushIntervalMs?: number;
}

interface StreamState {
  buffered: string;
  pending: string[];
  tail: string;
  storedBytes: number;
  capWarningEmitted: boolean;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sliceToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString('utf8');
}

function trimToLastBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= maxBytes) return text;
  return buffer.subarray(buffer.byteLength - maxBytes).toString('utf8');
}

export async function runStreamingCommand(options: StreamingCommandOptions): Promise<StreamingCommandResult> {
  const startedAt = Date.now();
  const outputCapBytes =
    options.outputCapBytes ?? readPositiveInt(process.env.EVE_SCRIPT_OUTPUT_CAP_BYTES, 10 * 1024 * 1024);
  const tailBytes = options.tailBytes ?? 4 * 1024;
  const killGraceMs = options.killGraceMs ?? 5_000;
  const flushLineCount = options.flushLineCount ?? 32;
  const flushIntervalMs = options.flushIntervalMs ?? 500;
  const timeoutSeconds = Math.ceil(options.timeoutMs / 1000);
  const maxBufferedLineBytes = Math.max(1, Math.min(outputCapBytes, 64 * 1024));

  const streams: Record<StreamName, StreamState> = {
    stdout: { buffered: '', pending: [], tail: '', storedBytes: 0, capWarningEmitted: false },
    stderr: { buffered: '', pending: [], tail: '', storedBytes: 0, capWarningEmitted: false },
  };

  let flushChain = Promise.resolve();
  let timedOut = false;
  let timeoutLogged = false;
  let termTimer: NodeJS.Timeout | undefined;

  const enqueueLog = (type: string, content: Record<string, unknown>): void => {
    flushChain = flushChain
      .then(() => options.appendLog(options.attemptId, type, content))
      .catch((err) => {
        console.error('[streaming-command] Failed to append log:', err);
      });
  };

  const emitCapWarning = (stream: StreamName): void => {
    const state = streams[stream];
    if (state.capWarningEmitted) return;
    state.capWarningEmitted = true;
    enqueueLog('warning', {
      code: 'output_truncated',
      stream,
      cap_bytes: outputCapBytes,
      message: `Output cap reached for ${stream}; additional output will be drained but not stored`,
      timestamp: new Date().toISOString(),
    });
  };

  const flushPending = (): void => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const state = streams[stream];
      if (state.pending.length === 0) continue;
      const text = state.pending.join('');
      state.pending = [];
      enqueueLog('output', {
        stream,
        text,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const appendStreamText = (stream: StreamName, text: string): void => {
    if (!text) return;
    const state = streams[stream];

    if (state.storedBytes >= outputCapBytes) {
      emitCapWarning(stream);
      return;
    }

    const remainingBytes = outputCapBytes - state.storedBytes;
    const accepted = sliceToBytes(text, remainingBytes);
    if (accepted) {
      state.storedBytes += Buffer.byteLength(accepted);
      state.tail = trimToLastBytes(state.tail + accepted, tailBytes);
      state.pending.push(accepted);
    }

    if (Buffer.byteLength(text) > Buffer.byteLength(accepted)) {
      state.storedBytes = outputCapBytes;
      emitCapWarning(stream);
    }

    if (state.pending.length >= flushLineCount) {
      flushPending();
    }
  };

  const onChunk = (stream: StreamName, chunk: Buffer): void => {
    const state = streams[stream];
    state.buffered += chunk.toString('utf8');

    let newlineIndex = state.buffered.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = state.buffered.slice(0, newlineIndex + 1);
      state.buffered = state.buffered.slice(newlineIndex + 1);
      appendStreamText(stream, line);
      newlineIndex = state.buffered.indexOf('\n');
    }

    if (Buffer.byteLength(state.buffered) >= maxBufferedLineBytes) {
      appendStreamText(stream, state.buffered);
      state.buffered = '';
      flushPending();
    }
  };

  return new Promise<StreamingCommandResult>((resolve) => {
    // Job execution should depend only on the explicit environment supplied here.
    const child = spawn('bash', ['--noprofile', '--norc', '-c', options.command], {
      cwd: options.cwd,
      env: options.env,
    });

    const flushInterval = setInterval(flushPending, flushIntervalMs);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (!timeoutLogged) {
        timeoutLogged = true;
        enqueueLog('error', {
          code: options.timeoutCode,
          timeout_seconds: timeoutSeconds,
          duration_ms: Date.now() - startedAt,
          message: `Command timed out after ${timeoutSeconds}s`,
          timestamp: new Date().toISOString(),
        });
      }
      child.kill('SIGTERM');
      termTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, killGraceMs);
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => onChunk('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => onChunk('stderr', chunk));

    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      clearInterval(flushInterval);
      if (termTimer) clearTimeout(termTimer);
      for (const stream of ['stdout', 'stderr'] as const) {
        appendStreamText(stream, streams[stream].buffered);
        streams[stream].buffered = '';
      }
      flushPending();
      void flushChain.finally(() => {
        resolve({
          success: false,
          exitCode: 1,
          stdout: streams.stdout.tail,
          stderr: streams.stderr.tail,
          error: error.message,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      clearInterval(flushInterval);
      if (termTimer) clearTimeout(termTimer);

      for (const stream of ['stdout', 'stderr'] as const) {
        appendStreamText(stream, streams[stream].buffered);
        streams[stream].buffered = '';
      }
      flushPending();

      void flushChain.finally(() => {
        const exitCode = timedOut ? 124 : code ?? (signal ? 1 : 0);
        const success = !timedOut && exitCode === 0;
        const timeoutError = `${options.timeoutCode}: Command timed out after ${timeoutSeconds}s`;
        const processError = `Command failed with exit code ${exitCode}`;
        resolve({
          success,
          exitCode,
          stdout: streams.stdout.tail,
          stderr: streams.stderr.tail,
          error: success ? undefined : timedOut ? timeoutError : processError,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  });
}
