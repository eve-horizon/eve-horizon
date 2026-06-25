import type { CliHarnessAdapter } from './types';
import { buildCodeCommand } from './code';

export const codexAdapter: CliHarnessAdapter = {
  name: 'codex',
  buildCommand: buildCodeCommand,
};
