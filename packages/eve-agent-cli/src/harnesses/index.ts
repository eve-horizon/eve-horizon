import type { CliHarnessAdapter, HarnessName } from './types';
import { claudeAdapter, mclaudeAdapter, zaiAdapter } from './claude';
import { geminiAdapter } from './gemini';
import { codeAdapter } from './code';
import { piCliAdapter } from './pi';

const adapters: CliHarnessAdapter[] = [
  claudeAdapter,
  mclaudeAdapter,
  zaiAdapter,
  geminiAdapter,
  codeAdapter,
  piCliAdapter,
];

const registry = new Map<HarnessName, CliHarnessAdapter>();
for (const adapter of adapters) {
  for (const name of [adapter.name, ...(adapter.names ?? []), ...(adapter.aliases ?? [])]) {
    registry.set(name, adapter);
  }
}

export function resolveCliAdapter(name: HarnessName): CliHarnessAdapter | undefined {
  return registry.get(name);
}
