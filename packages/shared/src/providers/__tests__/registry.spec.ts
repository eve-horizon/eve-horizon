import { describe, expect, it } from 'vitest';
import {
  PROVIDER_REGISTRY,
  getProvider,
  getProviderForHarness,
  getProviderByEnvVar,
  inferProviderName,
  deriveHarnessEnvMap,
  listProviders,
} from '../registry.js';
import { toProviderJson } from '../types.js';

// ---------------------------------------------------------------------------
// Registry structure
// ---------------------------------------------------------------------------

describe('PROVIDER_REGISTRY', () => {
  it('contains the initial 5 providers', () => {
    const names = PROVIDER_REGISTRY.map((p) => p.name);
    expect(names).toEqual(['anthropic', 'openai', 'google', 'zai', 'gmicloud']);
  });

  it('every provider has required fields', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.name).toBeTruthy();
      expect(p.display_name).toBeTruthy();
      expect(p.api_compatibility).toBeTruthy();
      expect(p.base_url).toMatch(/^https:\/\//);
      expect(p.auth.header).toBeTruthy();
      expect(p.auth.env_vars.length).toBeGreaterThan(0);
      expect(p.harnesses.primary).toBeTruthy();
      expect(p.harnesses.all.length).toBeGreaterThan(0);
      expect(p.harnesses.env_map.apiKey).toBeTruthy();
      expect(p.harnesses.env_map.baseUrl).toBeTruthy();
      expect(p.normalization.strip_patterns.length).toBeGreaterThan(0);
    }
  });

  it('listProviders returns all entries', () => {
    expect(listProviders()).toEqual(PROVIDER_REGISTRY);
  });
});

// ---------------------------------------------------------------------------
// getProvider
// ---------------------------------------------------------------------------

describe('getProvider', () => {
  it('returns provider by exact name', () => {
    expect(getProvider('anthropic')?.name).toBe('anthropic');
    expect(getProvider('openai')?.name).toBe('openai');
    expect(getProvider('gmicloud')?.name).toBe('gmicloud');
  });

  it('normalizes whitespace and case', () => {
    expect(getProvider(' Anthropic ')?.name).toBe('anthropic');
    expect(getProvider('OPENAI')?.name).toBe('openai');
  });

  it('returns undefined for unknown provider', () => {
    expect(getProvider('unknown')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getProviderForHarness
// ---------------------------------------------------------------------------

describe('getProviderForHarness', () => {
  it('maps mclaude → anthropic', () => {
    expect(getProviderForHarness('mclaude')?.name).toBe('anthropic');
  });

  it('maps claude → anthropic', () => {
    expect(getProviderForHarness('claude')?.name).toBe('anthropic');
  });

  it('maps code → openai', () => {
    expect(getProviderForHarness('code')?.name).toBe('openai');
  });

  it('maps codex → openai', () => {
    expect(getProviderForHarness('codex')?.name).toBe('openai');
  });

  it('maps gemini → google', () => {
    expect(getProviderForHarness('gemini')?.name).toBe('google');
  });

  it('maps zai → zai', () => {
    expect(getProviderForHarness('zai')?.name).toBe('zai');
  });

  it('returns undefined for unknown harness', () => {
    expect(getProviderForHarness('nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getProviderByEnvVar
// ---------------------------------------------------------------------------

describe('getProviderByEnvVar', () => {
  it('maps ANTHROPIC_API_KEY → anthropic', () => {
    expect(getProviderByEnvVar('ANTHROPIC_API_KEY')?.name).toBe('anthropic');
  });

  it('maps OPENAI_API_KEY → openai', () => {
    expect(getProviderByEnvVar('OPENAI_API_KEY')?.name).toBe('openai');
  });

  it('maps Z_AI_API_KEY → zai', () => {
    expect(getProviderByEnvVar('Z_AI_API_KEY')?.name).toBe('zai');
  });

  it('maps GOOGLE_API_KEY → google', () => {
    expect(getProviderByEnvVar('GOOGLE_API_KEY')?.name).toBe('google');
  });
});

// ---------------------------------------------------------------------------
// inferProviderName — must match old inferProviderFromHarness behavior exactly
// ---------------------------------------------------------------------------

describe('inferProviderName', () => {
  it('matches old behavior: claude variants → anthropic', () => {
    expect(inferProviderName('mclaude')).toBe('anthropic');
    expect(inferProviderName('claude')).toBe('anthropic');
  });

  it('matches old behavior: gemini → google', () => {
    expect(inferProviderName('gemini')).toBe('google');
  });

  it('matches old behavior: zai → zai', () => {
    expect(inferProviderName('zai')).toBe('zai');
  });

  it('matches old behavior: code/codex/coder → openai', () => {
    expect(inferProviderName('code')).toBe('openai');
    expect(inferProviderName('codex')).toBe('openai');
    expect(inferProviderName('coder')).toBe('openai');
  });

  it('matches old behavior: null/undefined → unknown', () => {
    expect(inferProviderName(null)).toBe('unknown');
    expect(inferProviderName(undefined)).toBe('unknown');
    expect(inferProviderName('')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// deriveHarnessEnvMap — must match old HARNESS_ENV_MAP exactly
// ---------------------------------------------------------------------------

describe('deriveHarnessEnvMap', () => {
  const map = deriveHarnessEnvMap();

  it('produces the same entries as the old hardcoded map', () => {
    expect(map['code']).toEqual({ apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' });
    expect(map['codex']).toEqual({ apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' });
    expect(map['claude']).toEqual({ apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' });
    expect(map['mclaude']).toEqual({ apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' });
    expect(map['zai']).toEqual({ apiKey: 'Z_AI_API_KEY', baseUrl: 'Z_AI_BASE_URL' });
    expect(map['gemini']).toEqual({ apiKey: 'GOOGLE_API_KEY', baseUrl: 'GOOGLE_BASE_URL' });
  });
});

// ---------------------------------------------------------------------------
// toProviderJson
// ---------------------------------------------------------------------------

describe('toProviderJson', () => {
  it('serializes RegExp patterns to source strings', () => {
    const anthropic = getProvider('anthropic')!;
    const json = toProviderJson(anthropic);
    expect(json.normalization.strip_patterns).toEqual(['-\\d{8}$']);
  });

  it('preserves all other fields', () => {
    const openai = getProvider('openai')!;
    const json = toProviderJson(openai);
    expect(json.name).toBe('openai');
    expect(json.display_name).toBe('OpenAI');
    expect(json.auth.env_vars).toContain('OPENAI_API_KEY');
  });
});
