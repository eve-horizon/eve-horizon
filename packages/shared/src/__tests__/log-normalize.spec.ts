import { describe, it, expect } from 'vitest';
import { normalizeLogLine, renderLogText } from '../log-normalize';

describe('log-normalize', () => {
  // ── normalizeLogLine ─────────────────────────────────────────────────────

  describe('normalizeLogLine', () => {
    it('passes through plain log lines as-is', () => {
      const result = normalizeLogLine({ type: 'assistant', message: 'hello' });
      expect(result.type).toBe('assistant');
      expect(result.message).toBe('hello');
    });

    it('normalizes Codex agent_message events', () => {
      const result = normalizeLogLine({
        kind: 'assistant',
        raw: {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'I will fix the bug.' },
        },
      });
      expect(result.type).toBe('assistant');
      expect(result.message).toBe('I will fix the bug.');
    });

    it('normalizes Codex command_execution started events', () => {
      const result = normalizeLogLine({
        kind: 'tool_use',
        raw: {
          type: 'item.started',
          item: { type: 'command_execution', command: 'npm test' },
        },
      });
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('bash');
      expect(result.toolInput).toBe('npm test');
    });

    it('normalizes Codex command_execution completed events', () => {
      const result = normalizeLogLine({
        kind: 'tool_result',
        raw: {
          type: 'item.completed',
          item: { type: 'command_execution', command: 'npm test', exit_code: 0, status: 'completed' },
        },
      });
      expect(result.type).toBe('tool_result');
      expect(result.tool).toBe('bash');
      expect(result.message).toBe('exit 0');
    });

    it('normalizes Codex file_change events', () => {
      const result = normalizeLogLine({
        kind: 'tool_use',
        raw: {
          type: 'item.completed',
          item: {
            type: 'file_change',
            changes: [
              { kind: 'edit', path: '/repo/src/lib/utils.ts' },
            ],
          },
        },
      });
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('file_change');
      expect(result.toolInput).toBe('edit: src/lib/utils.ts');
    });

    it('skips turn.completed events', () => {
      const result = normalizeLogLine({
        kind: 'turn',
        raw: { type: 'turn.completed' },
      });
      expect(result.type).toBe('skip');
    });

    it('normalizes Claude-style assistant events inside wrapper', () => {
      const result = normalizeLogLine({
        kind: 'assistant',
        raw: {
          type: 'assistant',
          message: { content: [{ text: 'hello' }, { text: 'world' }] },
        },
      });
      expect(result.type).toBe('assistant');
      expect(result.message).toBe('hello\nworld');
    });
  });

  // ── renderLogText ──────────────────────────────────────────────────────

  describe('renderLogText', () => {
    it('renders lifecycle start events', () => {
      expect(renderLogText({
        type: 'lifecycle_runner_start',
        line: { phase: 'runner', action: 'start' },
      })).toBe('Starting Runner...');
    });

    it('renders lifecycle end events with duration', () => {
      expect(renderLogText({
        type: 'lifecycle_harness_end',
        line: { phase: 'harness', action: 'end', success: true, duration_ms: 10437 },
      })).toBe('Harness completed (10.4s)');
    });

    it('renders lifecycle failure events', () => {
      expect(renderLogText({
        type: 'lifecycle_harness_end',
        line: { phase: 'harness', action: 'end', success: false, duration_ms: 500 },
      })).toBe('Harness failed (500ms)');
    });

    it('renders system completed events', () => {
      expect(renderLogText({
        type: 'system',
        line: { event: 'completed', exitCode: 0 },
      })).toBe('Job completed (exit code 0)');
    });

    it('returns null for system events without completed', () => {
      expect(renderLogText({
        type: 'system',
        line: { event: 'something_else' },
      })).toBeNull();
    });

    it('renders LLM call events', () => {
      const text = renderLogText({
        type: 'llm.call',
        line: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          source: 'byok',
          usage: { input_tokens: 29166, output_tokens: 639 },
        },
      });
      expect(text).toContain('LLM call');
      expect(text).toContain('(BYOK)');
      expect(text).toContain('29,166 in');
      expect(text).toContain('639 out');
    });

    it('renders Claude Code assistant transcript events', () => {
      expect(renderLogText({
        type: 'event',
        line: {
          raw: {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Implementing the feature now.' },
              ],
            },
          },
        },
      })).toBe('Implementing the feature now.');
    });

    it('renders assistant + tool_use combined events', () => {
      const text = renderLogText({
        type: 'event',
        line: {
          raw: {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Let me read the file.' },
                { type: 'tool_use', name: 'Read', input: { file_path: '/src/index.ts' } },
              ],
            },
          },
        },
      });
      expect(text).toBe('Let me read the file.\n> Read /src/index.ts');
    });

    it('renders tool_result from user events', () => {
      const text = renderLogText({
        type: 'event',
        line: {
          raw: {
            type: 'user',
            message: {
              content: [
                { type: 'tool_result', content: 'File written successfully', is_error: false },
              ],
            },
          },
        },
      });
      expect(text).toBe('  File written successfully');
    });

    it('renders Codex agent messages via normalizeLogLine fallback', () => {
      expect(renderLogText({
        type: 'event',
        line: {
          kind: 'assistant',
          raw: {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'I will fix the bug now.' },
          },
        },
      })).toBe('I will fix the bug now.');
    });

    it('renders Codex tool use via normalizeLogLine fallback', () => {
      const text = renderLogText({
        type: 'event',
        line: {
          kind: 'tool_use',
          raw: {
            type: 'item.started',
            item: { type: 'command_execution', command: 'npm test' },
          },
        },
      });
      expect(text).toBe('> bash npm test');
    });

    it('returns null for empty/unknown payloads', () => {
      expect(renderLogText({ type: 'unknown' })).toBeNull();
    });

    it('returns null for skip events', () => {
      expect(renderLogText({
        type: 'event',
        line: {
          kind: 'turn',
          raw: { type: 'turn.completed' },
        },
      })).toBeNull();
    });
  });
});
