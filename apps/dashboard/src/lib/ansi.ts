// ANSI colour codes in log text, parsed into styled text segments.
//
// Log text is untrusted: it is rendered as React text nodes, never as HTML, so
// markup in a log line shows as typed. Only SGR codes (`ESC [ ... m`) are
// understood; the ones without a style here are dropped.

/** A run of log text with the Tailwind classes it renders with ('' if none). */
export interface AnsiSegment {
  text: string;
  className: string;
}

/** A segment after search highlighting. */
export interface LogTextPart extends AnsiSegment {
  highlighted: boolean;
}

const SGR = /\x1b\[([\d;]*)m/g;

const COLOURS: Record<number, string> = {
  31: 'text-red-400',
  32: 'text-green-400',
  33: 'text-yellow-400',
  34: 'text-blue-400',
  35: 'text-purple-400',
  36: 'text-cyan-400',
  90: 'text-gray-500',
};

/** The text without ANSI codes: what the user reads, searches and copies. */
export function stripAnsi(text: string): string {
  return text.replace(SGR, '');
}

/**
 * Split `text` at its ANSI codes. The segments' text, joined, is exactly
 * `stripAnsi(text)`.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let bold = false;
  let colour = '';
  let from = 0;

  const emit = (to: number) => {
    if (to > from) {
      segments.push({ text: text.slice(from, to), className: [bold ? 'font-bold' : '', colour].filter(Boolean).join(' ') });
    }
  };

  for (const match of text.matchAll(SGR)) {
    emit(match.index);
    from = match.index + match[0].length;
    for (const param of (match[1] ?? '').split(';')) {
      const code = Number(param || '0');
      if (code === 0) {
        bold = false;
        colour = '';
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        colour = '';
      } else if (COLOURS[code]) {
        colour = COLOURS[code];
      }
    }
  }
  emit(text.length);
  return segments;
}

/** [start, end) of every non-empty match of `regex` in `text`. */
export function matchRanges(text: string, regex: RegExp): Array<[number, number]> {
  const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(global)) {
    if (match[0].length > 0) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * Cut `segments` at the edges of `ranges` (sorted, non-overlapping offsets
 * into the joined segment text) and mark the parts inside a range.
 */
export function highlightRanges(segments: AnsiSegment[], ranges: Array<[number, number]>): LogTextPart[] {
  const parts: LogTextPart[] = [];
  let next = 0;
  let offset = 0;

  for (const segment of segments) {
    const end = offset + segment.text.length;
    let pos = offset;
    while (pos < end) {
      while (next < ranges.length && ranges[next]![1] <= pos) next += 1;
      const range = ranges[next];
      const highlighted = range !== undefined && range[0] <= pos;
      const stop = Math.min(end, highlighted ? range![1] : (range?.[0] ?? end));
      parts.push({ text: segment.text.slice(pos - offset, stop - offset), className: segment.className, highlighted });
      pos = stop;
    }
    offset = end;
  }
  return parts;
}
