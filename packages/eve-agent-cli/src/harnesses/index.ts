import type { CliHarnessAdapter, HarnessName } from './types';
import { claudeAdapter } from './claude-direct.js';
import { mclaudeAdapter } from './mclaude';
import { zaiAdapter } from './zai';
import { geminiAdapter } from './gemini';
import { codeAdapter } from './code';
import { codexAdapter } from './codex';
import { piCliAdapter } from './pi';

const adapters: CliHarnessAdapter[] = [
  claudeAdapter,
  mclaudeAdapter,
  zaiAdapter,
  geminiAdapter,
  codeAdapter,
  codexAdapter,
  piCliAdapter,
];

const registry = new Map<HarnessName, CliHarnessAdapter>();
for (const adapter of adapters) {
  registry.set(adapter.name, adapter);
  if (adapter.aliases) {
    for (const alias of adapter.aliases) {
      registry.set(alias, adapter);
    }
  }
}

export function resolveCliAdapter(name: HarnessName): CliHarnessAdapter | undefined {
  return registry.get(name);
}
