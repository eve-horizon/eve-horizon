export type { HarnessName, PermissionPolicy } from '@eve/shared';
import type { HarnessName, PermissionPolicy } from '@eve/shared';

export type CliContext = {
  harness: HarnessName;
  prompt: string;
  permission: PermissionPolicy;
  variant?: string;
  configDirResolved?: boolean;
  model?: string;
  reasoning?: string;
  env: Record<string, string | undefined>;
  workspace: string;
};

export type HarnessCommand = {
  binary: string;
  args: string[];
  env: Record<string, string | undefined>;
  /**
   * Written to the harness's stdin. Harnesses that read their prompt from
   * stdin get it here, off the command line that `ps` shows to every process
   * on the pod.
   */
  stdin?: string;
};

export type CliHarnessAdapter = {
  name: HarnessName;
  /** Additional distinct harness names served by this adapter's builder (branching on ctx.harness). */
  names?: HarnessName[];
  aliases?: HarnessName[];
  buildCommand(ctx: CliContext): { command: HarnessCommand; warnings: string[] };
};
