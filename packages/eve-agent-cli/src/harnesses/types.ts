export type { HarnessName, PermissionPolicy } from '@eve/shared';
import type { HarnessName, PermissionPolicy } from '@eve/shared';

export type CliContext = {
  harness: HarnessName;
  prompt: string;
  permission: PermissionPolicy;
  variant?: string;
  model?: string;
  reasoning?: string;
  env: Record<string, string | undefined>;
  workspace: string;
};

export type HarnessCommand = {
  binary: string;
  args: string[];
  env: Record<string, string | undefined>;
};

export type CliHarnessAdapter = {
  name: HarnessName;
  /** Additional distinct harness names served by this adapter's builder (branching on ctx.harness). */
  names?: HarnessName[];
  aliases?: HarnessName[];
  buildCommand(ctx: CliContext): { command: HarnessCommand; warnings: string[] };
};
