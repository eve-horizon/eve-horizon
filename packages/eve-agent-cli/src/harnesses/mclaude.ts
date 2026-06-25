import type { CliHarnessAdapter } from './types';
import { buildClaudeCommand } from './claude';

export const mclaudeAdapter: CliHarnessAdapter = {
  name: 'mclaude',
  buildCommand: buildClaudeCommand,
};
