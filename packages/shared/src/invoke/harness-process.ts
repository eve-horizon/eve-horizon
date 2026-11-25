/**
 * Launching the harness proxy (eve-agent-cli) for an agent job.
 *
 * A process's arguments are readable by every process on the host through
 * `ps` and `/proc/<pid>/cmdline`, including other jobs' harnesses on a shared
 * agent-runtime pod. The prompt carries job context and untrusted input, so it
 * never goes on a command line: it is written to the harness's stdin.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EVE_HARNESS_CONFIG_RESOLVED } from '../harnesses/config.js';

export interface EveAgentCliArgsOptions {
  harness: string;
  permission: string;
  workspace: string;
  variant?: string;
  model?: string;
  reasoning?: string;
}

/** eve-agent-cli arguments. The prompt is not one of them; see {@link spawnHarnessProcess}. */
export function buildEveAgentCliArgs(options: EveAgentCliArgsOptions): string[] {
  const args = [
    '--harness', options.harness,
    '--permission', options.permission,
    '--output-format', 'stream-json',
    '--workspace', options.workspace,
  ];
  if (options.variant) args.push('--variant', options.variant);
  if (options.model) args.push('--model', options.model);
  if (options.reasoning) args.push('--reasoning', options.reasoning);
  return args;
}

/** Spawn a harness process and write its prompt to stdin. */
export function spawnHarnessProcess(
  binary: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    prompt: string;
    detached?: boolean;
  },
): ChildProcessWithoutNullStreams {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    // The runtime adapter has already selected any config directory it passes.
    env: { ...options.env, [EVE_HARNESS_CONFIG_RESOLVED]: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: options.detached ?? false,
  });
  // A harness that exits before reading its prompt closes the pipe (EPIPE);
  // its exit code reports the failure, so the write error is not an error here.
  child.stdin.on('error', () => {});
  child.stdin.end(options.prompt);
  return child;
}
