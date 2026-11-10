import { describe, expect, it } from 'vitest';
import { highlightRanges, matchRanges, parseAnsi, stripAnsi } from './ansi';

describe('parseAnsi', () => {
  it('styles text between codes and joins back to the stripped text', () => {
    const text = 'a \x1b[31mred\x1b[0m b \x1b[1;32mbold green\x1b[39m bold\x1b[22m plain';
    expect(parseAnsi(text)).toEqual([
      { text: 'a ', className: '' },
      { text: 'red', className: 'text-red-400' },
      { text: ' b ', className: '' },
      { text: 'bold green', className: 'font-bold text-green-400' },
      { text: ' bold', className: 'font-bold' },
      { text: ' plain', className: '' },
    ]);
    expect(parseAnsi(text).map((s) => s.text).join('')).toBe(stripAnsi(text));
  });

  it('drops codes it has no style for, and treats an empty code as a reset', () => {
    expect(parseAnsi('\x1b[4m\x1b[33mx\x1b[my')).toEqual([
      { text: 'x', className: 'text-yellow-400' },
      { text: 'y', className: '' },
    ]);
  });

  it('keeps markup as plain text', () => {
    expect(parseAnsi('\x1b[31m<script>alert(1)</script>')).toEqual([
      { text: '<script>alert(1)</script>', className: 'text-red-400' },
    ]);
  });
});

describe('search highlighting', () => {
  it('finds every non-empty match', () => {
    expect(matchRanges('abcabc', /b/i)).toEqual([[1, 2], [4, 5]]);
    expect(matchRanges('abc', /x*/)).toEqual([]);
  });

  it('cuts styled segments at match edges, across segment boundaries', () => {
    const segments = parseAnsi('ab\x1b[31mcd\x1b[0mef');
    expect(highlightRanges(segments, matchRanges('abcdef', /bcde/))).toEqual([
      { text: 'a', className: '', highlighted: false },
      { text: 'b', className: '', highlighted: true },
      { text: 'cd', className: 'text-red-400', highlighted: true },
      { text: 'e', className: '', highlighted: true },
      { text: 'f', className: '', highlighted: false },
    ]);
  });

  it('leaves segments whole when nothing matches', () => {
    const segments = parseAnsi('\x1b[32mok\x1b[0m done');
    expect(highlightRanges(segments, [])).toEqual(segments.map((s) => ({ ...s, highlighted: false })));
  });
});
