import type { HarnessCanonicalName, HarnessName } from './registry.js';
import { resolveHarnessName } from './registry.js';

export type ReasoningCapability = {
  supported: boolean;
  levels?: string[];
  mode?: 'effort' | 'thinking_tokens' | 'level' | 'unknown';
  notes?: string;
};

export type HarnessCapability = {
  supports_model: boolean;
  model_notes?: string;
  model_examples?: string[];
  reasoning?: ReasoningCapability;
};

export const HARNESS_CAPABILITIES: Record<HarnessCanonicalName, HarnessCapability> = {
  mclaude: {
    supports_model: true,
    model_notes: 'Model override supported via CLAUDE_MODEL or --model. Opus 4.7 forms such as opus4.7 and opus-4-7 are normalized to Claude Code\'s opus alias.',
    model_examples: ['opus', 'opus4.7', 'opus-4-7', 'sonnet', 'haiku'],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'thinking_tokens',
      notes: 'Reasoning effort maps to thinking-token budget in adapter.',
    },
  },
  claude: {
    supports_model: true,
    model_notes: 'Model override supported via CLAUDE_MODEL or --model. Opus 4.7 forms such as opus4.7 and opus-4-7 are normalized to Claude Code\'s opus alias.',
    model_examples: ['opus', 'opus4.7', 'opus-4-7', 'sonnet', 'haiku'],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'thinking_tokens',
      notes: 'Reasoning effort maps to thinking-token budget in adapter.',
    },
  },
  zai: {
    supports_model: true,
    model_notes: 'Model override supported via ZAI_MODEL or --model.',
    model_examples: ['glm-5', 'glm-5-code', 'glm-4.7'],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'thinking_tokens',
      notes: 'Reasoning effort maps to thinking-token budget in adapter.',
    },
  },
  gemini: {
    supports_model: true,
    model_notes: 'Gemini CLI supports --model; thinking settings vary by model family.',
    model_examples: ['gemini-3', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'level',
      notes: 'Gemini 2.5 uses thinkingBudget tokens; Gemini 3 uses thinkingLevel enums.',
    },
  },
  code: {
    supports_model: true,
    model_notes: 'Model override supported via --model.',
    model_examples: ['gpt-5.5', 'gpt-5.2-codex', 'gpt-4.1'],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'effort',
      notes: 'Mapped directly to Code reasoning effort flag.',
    },
  },
  codex: {
    supports_model: true,
    model_notes: 'Model override supported via --model.',
    model_examples: ['gpt-5.5', 'gpt-5.2-codex', 'gpt-4.1'],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'effort',
      notes: 'Mapped to Codex model_reasoning_effort config override.',
    },
  },
  pi: {
    supports_model: true,
    model_notes: 'Use provider/model format (e.g., anthropic/claude-sonnet-4).',
    model_examples: [
      'anthropic/claude-opus-4-7',
      'anthropic/claude-sonnet-4',
      'openai/gpt-5.5',
      'openai/gpt-4o',
      'google/gemini-2.5-pro',
    ],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'level',
      notes: 'pi maps x-high to xhigh internally.',
    },
  },
};

export function getHarnessCapability(name: HarnessName): HarnessCapability | undefined {
  const canonical = resolveHarnessName(name);
  if (!canonical) return undefined;
  return HARNESS_CAPABILITIES[canonical];
}

export function listHarnessCapabilities(): Array<{ name: HarnessCanonicalName; capabilities: HarnessCapability }> {
  return Object.entries(HARNESS_CAPABILITIES).map(([name, capabilities]) => ({
    name: name as HarnessCanonicalName,
    capabilities,
  }));
}
