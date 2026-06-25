import type { HarnessName } from '../registry.js';
import type { HarnessAdapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { mclaudeAdapter } from './mclaude.js';
import { zaiAdapter } from './zai.js';
import { geminiAdapter } from './gemini.js';
import { codeAdapter } from './code.js';
import { codexAdapter } from './codex.js';
import { piAdapter } from './pi.js';

const adapters: HarnessAdapter[] = [
  claudeAdapter,
  mclaudeAdapter,
  zaiAdapter,
  geminiAdapter,
  codeAdapter,
  codexAdapter,
  piAdapter,
];

const registry = new Map<HarnessName, HarnessAdapter>();
for (const adapter of adapters) {
  registry.set(adapter.name, adapter);
  if (adapter.aliases) {
    for (const alias of adapter.aliases) {
      registry.set(alias, adapter);
    }
  }
}

export function resolveHarnessAdapter(name: HarnessName): HarnessAdapter | undefined {
  return registry.get(name);
}
