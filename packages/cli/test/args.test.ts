import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/lib/args';

describe('parseArgs', () => {
  it('keeps repeated env override flags in first-seen order', () => {
    const { flags } = parseArgs([
      'job',
      'create',
      '--env-override',
      'A=1',
      '--env-override=B=2',
      '--env_override',
      'C=3',
    ]);

    expect(flags['env-override']).toEqual(['A=1', 'B=2']);
    expect(flags.env_override).toEqual('C=3');
  });

  it('keeps existing last-wins behaviour for non-repeatable flags', () => {
    const { flags } = parseArgs(['job', 'create', '--project', 'one', '--project', 'two']);

    expect(flags.project).toBe('two');
  });
});
