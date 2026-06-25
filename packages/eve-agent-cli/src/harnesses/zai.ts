import type { CliHarnessAdapter } from './types';
import { buildClaudeCommand } from './claude';

export const zaiAdapter: CliHarnessAdapter = {
  name: 'zai',
  buildCommand: buildClaudeCommand,
};
