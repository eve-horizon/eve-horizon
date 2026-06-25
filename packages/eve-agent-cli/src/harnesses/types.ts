export type HarnessName =
  | 'claude'
  | 'mclaude'
  | 'zai'
  | 'gemini'
  | 'code'
  | 'coder'
  | 'codex'
  | 'pi';

export type PermissionPolicy = 'default' | 'auto_edit' | 'never' | 'yolo';

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
  aliases?: HarnessName[];
  buildCommand(ctx: CliContext): { command: HarnessCommand; warnings: string[] };
};
