import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  selectAvailableHarness,
  DEFAULT_HARNESS_PREFERENCE,
} from '@eve/shared';
import * as authModule from '@eve/shared/dist/harnesses/auth.js';

function mockAvailable(name: string) {
  return { available: true, reason: `using mock for ${name}`, instructions: [] };
}

function mockUnavailable(name: string, reason: string) {
  return { available: false, reason, instructions: [] };
}

describe('selectAvailableHarness', () => {
  let getHarnessAuthStatusSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getHarnessAuthStatusSpy = vi.spyOn(authModule, 'getHarnessAuthStatus');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('explicit harness selection', () => {
    it('uses explicit harness without fallback when specified', () => {
      // Explicit harness doesn't check auth - it returns immediately
      const result = selectAvailableHarness({ explicit: 'mclaude' });

      expect(result).toEqual({
        harness: 'mclaude',
        source: 'explicit',
        checked: ['mclaude'],
        unavailable: [],
      });
      // Auth is NOT checked for explicit harness
      expect(getHarnessAuthStatusSpy).not.toHaveBeenCalled();
    });

    it('returns explicit harness even if auth check would fail (no fallback)', () => {
      // Note: explicit harness doesn't check auth - it just returns the harness
      // Auth failure would happen at execution time
      const result = selectAvailableHarness({ explicit: 'zai' });

      expect(result.harness).toBe('zai');
      expect(result.source).toBe('explicit');
      expect(getHarnessAuthStatusSpy).not.toHaveBeenCalled();
    });

    it('throws error for unknown explicit harness', () => {
      expect(() => selectAvailableHarness({ explicit: 'unknown-harness' })).toThrow(
        'Unknown harness: unknown-harness'
      );
    });

    it('resolves harness alias (coder → code) for explicit harness', () => {
      const result = selectAvailableHarness({ explicit: 'coder' });

      expect(result.harness).toBe('code');
      expect(result.source).toBe('explicit');
    });
  });

  describe('preference order', () => {
    it('uses project preference when provided', () => {
      getHarnessAuthStatusSpy.mockImplementation((name) => {
        if (name === 'gemini') return mockAvailable('gemini');
        return mockUnavailable(name as string, 'not set');
      });

      const result = selectAvailableHarness({
        projectPreference: ['gemini', 'zai'],
        systemPreference: ['claude', 'codex'],
      });

      expect(result.harness).toBe('gemini');
      expect(result.source).toBe('project');
    });

    it('uses system preference when no project preference', () => {
      getHarnessAuthStatusSpy.mockImplementation((name) => {
        if (name === 'codex') return mockAvailable('codex');
        return mockUnavailable(name as string, 'not set');
      });

      const result = selectAvailableHarness({
        systemPreference: ['claude', 'codex'],
      });

      expect(result.harness).toBe('codex');
      expect(result.source).toBe('system');
    });

    it('uses default preference when no project or system preference', () => {
      getHarnessAuthStatusSpy.mockImplementation((name) => {
        if (name === 'zai') return mockAvailable('zai');
        return mockUnavailable(name as string, 'not set');
      });

      const result = selectAvailableHarness({});

      expect(result.harness).toBe('zai');
      expect(result.source).toBe('default');
    });

    it('default preference matches expected order', () => {
      expect(DEFAULT_HARNESS_PREFERENCE).toEqual(['zai', 'claude', 'codex', 'gemini']);
    });
  });

  describe('availability checking', () => {
    it('selects first available harness in preference order', () => {
      getHarnessAuthStatusSpy.mockImplementation((name) => {
        if (name === 'zai') return mockUnavailable('zai', 'Z_AI_API_KEY not set');
        if (name === 'claude') return mockUnavailable('claude', 'ANTHROPIC_API_KEY not set');
        if (name === 'codex') return mockAvailable('codex');
        return mockUnavailable(name as string, 'not set');
      });

      const result = selectAvailableHarness({});

      expect(result.harness).toBe('codex');
      expect(result.checked).toEqual(['zai', 'claude', 'codex']);
      expect(result.unavailable).toEqual([
        { name: 'zai', reason: 'Z_AI_API_KEY not set' },
        { name: 'claude', reason: 'ANTHROPIC_API_KEY not set' },
      ]);
    });

    it('tracks all checked harnesses and reasons for unavailable ones', () => {
      getHarnessAuthStatusSpy.mockImplementation((name) => {
        if (name === 'gemini') return mockAvailable('gemini');
        return mockUnavailable(name as string, `${name} credentials missing`);
      });

      const result = selectAvailableHarness({
        projectPreference: ['zai', 'claude', 'gemini'],
      });

      expect(result.harness).toBe('gemini');
      expect(result.checked).toEqual(['zai', 'claude', 'gemini']);
      expect(result.unavailable).toHaveLength(2);
      expect(result.unavailable[0]).toEqual({ name: 'zai', reason: 'zai credentials missing' });
      expect(result.unavailable[1]).toEqual({ name: 'claude', reason: 'claude credentials missing' });
    });

    it('skips unknown harness names in preference list', () => {
      getHarnessAuthStatusSpy.mockImplementation((name) => {
        if (name === 'codex') return mockAvailable('codex');
        return mockUnavailable(name as string, 'not set');
      });

      const result = selectAvailableHarness({
        projectPreference: ['unknown1', 'unknown2', 'codex'],
      });

      expect(result.harness).toBe('codex');
      expect(result.checked).toEqual(['codex']);
    });
  });

  describe('error handling', () => {
    it('throws helpful error when no harness has valid credentials', () => {
      getHarnessAuthStatusSpy.mockImplementation((name) => {
        const reasons: Record<string, string> = {
          zai: 'Z_AI_API_KEY not set',
          claude: 'ANTHROPIC_API_KEY not set',
          codex: 'OPENAI_API_KEY not set',
          gemini: 'GOOGLE_API_KEY not set',
        };
        return mockUnavailable(name as string, reasons[name as string] || 'not configured');
      });

      expect(() => selectAvailableHarness({})).toThrow(/No harness with valid credentials/);
    });

    it('includes checked harnesses in error message', () => {
      getHarnessAuthStatusSpy.mockImplementation((name) => {
        return mockUnavailable(name as string, 'no creds');
      });

      try {
        selectAvailableHarness({});
        expect.fail('should have thrown');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('Checked: zai, claude, codex, gemini');
        expect(msg).toContain("Run 'eve harness list'");
      }
    });

    it('throws error with correct harnesses when custom preference fails', () => {
      getHarnessAuthStatusSpy.mockImplementation((name) => mockUnavailable(name as string, 'no creds'));

      try {
        selectAvailableHarness({
          projectPreference: ['zai', 'gemini'],
        });
        expect.fail('should have thrown');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('Checked: zai, gemini');
      }
    });
  });

  describe('harness alias resolution', () => {
    it('resolves mclaude in preference list', () => {
      getHarnessAuthStatusSpy.mockReturnValue(mockAvailable('mclaude'));

      const result = selectAvailableHarness({
        projectPreference: ['mclaude'],
      });

      expect(result.harness).toBe('mclaude');
    });

    it('resolves coder alias to code in preference list', () => {
      getHarnessAuthStatusSpy.mockReturnValue(mockAvailable('code'));

      const result = selectAvailableHarness({
        projectPreference: ['coder'],
      });

      // coder resolves to code
      expect(result.harness).toBe('code');
    });
  });
});
