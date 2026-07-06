import { describe, expect, it } from 'vitest';
import { createSseFrameParser } from '../src/lib/client';
import type { SseFrame } from '../src/lib/client';

/**
 * Equivalence tests for the shared SSE frame parser (CLI-3).
 *
 * The CLI previously had four hand-rolled SSE parse styles:
 *  1. fs.ts        — split buffer on '\n\n'; data lines trimmed, joined '\n',
 *                    payload = joined.trim(); emitted when any data line seen.
 *  2. thread.ts    — frame regex /\r?\n\r?\n/; data lines trimStart, joined
 *                    '\n'; default event 'message'; skip frames w/o data.
 *  3. pipeline/job — line-based; event/data state reset per chunk; dispatch on
 *                    blank line when data non-empty (last data line wins);
 *                    trailing buffer flushed at stream end.
 *  4. local-mesh   — line-based like (3) but state persists across chunks and
 *                    no trailing flush.
 *
 * These reference implementations mirror the old code verbatim. Each test
 * feeds the same synthetic byte stream (in various chunkings) through the old
 * path and the new parser and asserts identical emitted (event, data) tuples,
 * proving the '\r?\n\r?\n' superset framing accepts what each caller
 * received before.
 */

type Emitted = { event: string; data: string };

// ── Reference: fs.ts streamFsEvents parse loop ─────────────────────────────
function fsStyle(chunks: string[]): Emitted[] {
  const out: Emitted[] = [];
  let buffer = '';
  let currentEvent = '';
  let currentData = '';

  for (const chunk of chunks) {
    buffer += chunk;
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const eventBlock of events) {
      const lines = eventBlock.split('\n');
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          currentData += `${line.slice(5).trim()}\n`;
        }
      }

      if (currentData) {
        out.push({ event: currentEvent, data: currentData.trim() });
      }

      currentEvent = '';
      currentData = '';
    }
  }
  return out;
}

// ── Reference: thread.ts SSE parse loop ────────────────────────────────────
function threadStyle(chunks: string[]): Emitted[] {
  const out: Emitted[] = [];
  let buffer = '';

  for (const chunk of chunks) {
    buffer += chunk;

    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) {
        break;
      }

      const rawEvent = buffer.slice(0, match.index).trim();
      buffer = buffer.slice(match.index + match[0].length);
      if (!rawEvent) {
        continue;
      }

      let eventType = 'message';
      const dataLines: string[] = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('event:')) {
          eventType = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart());
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      out.push({ event: eventType, data: dataLines.join('\n') });
    }
  }
  return out;
}

// ── Reference: pipeline.ts / job.ts line-based loop (state reset per chunk,
//    trailing buffer flushed at stream end) ─────────────────────────────────
function lineStyleWithFlush(chunks: string[]): Emitted[] {
  const out: Emitted[] = [];
  let buffer = '';

  for (const chunk of chunks) {
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    let currentEvent = '';
    let currentData = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentData = line.slice(5).trim();
      } else if (line === '' && currentData) {
        out.push({ event: currentEvent, data: currentData });
        currentEvent = '';
        currentData = '';
      }
    }
  }

  if (buffer.trim()) {
    const remainingLines = buffer.split('\n');
    let currentEvent = '';
    let currentData = '';

    for (const line of remainingLines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentData = line.slice(5).trim();
      }
    }

    if (currentData) {
      out.push({ event: currentEvent, data: currentData });
    }
  }
  return out;
}

// ── Reference: local-mesh.ts line-based loop (persistent state, no flush) ──
function lineStylePersistent(chunks: string[]): Emitted[] {
  const out: Emitted[] = [];
  let buffer = '';
  let eventType = '';
  let eventData = '';

  for (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        eventData = line.slice(5).trim();
      } else if (line === '' && eventData) {
        out.push({ event: eventType, data: eventData });
        eventType = '';
        eventData = '';
      }
    }
  }
  return out;
}

// ── New parser, with per-caller event-default mapping ──────────────────────
function newParser(chunks: string[], opts: { flush?: boolean; eventDefault?: string } = {}): Emitted[] {
  const parser = createSseFrameParser();
  const frames: SseFrame[] = [];
  for (const chunk of chunks) {
    frames.push(...parser.push(chunk));
  }
  if (opts.flush) {
    const trailing = parser.flush();
    if (trailing) frames.push(trailing);
  }
  return frames.map((f) => ({ event: f.event ?? (opts.eventDefault ?? ''), data: f.data }));
}

// fs.ts trims the joined payload before dispatch.
function trimData(events: Emitted[]): Emitted[] {
  return events.map((e) => ({ event: e.event, data: e.data.trim() }));
}

// ── Synthetic streams ──────────────────────────────────────────────────────

const LOG_EVENT = 'event: log\ndata: {"sequence":1,"line":{"message":"hi"}}\n\n';
const COMPLETE_EVENT = 'event: complete\ndata: {"status":"succeeded","exit_code":0}\n\n';
const NO_EVENT_FIELD = 'data: {"seq":9}\n\n';
const HEARTBEAT_NO_DATA = 'event: heartbeat\n\n';
const COMMENT = ': ping\n\n';
const MULTI_DATA = 'event: snapshot\ndata: {"messages":\ndata: []}\n\n';

function chunkings(stream: string): string[][] {
  const whole = [stream];
  const bytes = stream.split('').map((c) => c);
  const pairs: string[] = [];
  for (let i = 0; i < stream.length; i += 7) {
    pairs.push(stream.slice(i, i + 7));
  }
  return [whole, pairs, bytes];
}

describe('createSseFrameParser framing superset', () => {
  it('matches fs.ts parsing for LF-framed streams', () => {
    const stream = LOG_EVENT + NO_EVENT_FIELD + HEARTBEAT_NO_DATA + COMMENT + COMPLETE_EVENT;
    for (const chunks of chunkings(stream)) {
      expect(trimData(newParser(chunks))).toEqual(fsStyle(chunks.join('').split(/(?<=\n\n)/)));
    }
  });

  it('matches fs.ts multi-data-line accumulation', () => {
    const chunks = [MULTI_DATA];
    expect(trimData(newParser(chunks))).toEqual(fsStyle(chunks));
    expect(newParser(chunks)).toEqual([{ event: 'snapshot', data: '{"messages":\n[]}' }]);
  });

  it('matches thread.ts parsing for LF and CRLF streams', () => {
    const lf = 'event: snapshot\ndata: {"messages":[]}\n\n' + 'data: {"body":"x"}\n\n' + HEARTBEAT_NO_DATA;
    const crlf = lf.replace(/\n/g, '\r\n');
    for (const stream of [lf, crlf]) {
      for (const chunks of chunkings(stream)) {
        expect(newParser(chunks, { eventDefault: 'message' })).toEqual(threadStyle(chunks));
      }
    }
  });

  it('matches thread.ts multi-data-line join', () => {
    const chunks = [MULTI_DATA];
    expect(newParser(chunks, { eventDefault: 'message' })).toEqual(threadStyle(chunks));
  });

  it('matches pipeline/job line-based parsing for frame-aligned chunks', () => {
    // The legacy line-based parsers reset event/data state per chunk, so they
    // are only well-defined when chunks align with frame boundaries. The new
    // parser must produce the same output there (and additionally be
    // chunking-invariant, verified separately below).
    const frameAligned = [LOG_EVENT, NO_EVENT_FIELD, HEARTBEAT_NO_DATA + COMMENT, COMPLETE_EVENT];
    expect(newParser(frameAligned, { flush: true })).toEqual(lineStyleWithFlush(frameAligned));
  });

  it('never flushes trailing data for well-formed streams (parity with pipeline/job)', () => {
    // Servers terminate every frame with a blank line, so for well-formed
    // streams the trailing flush is a no-op in both old and new paths.
    // (Parity with the legacy line-based parser only holds for frame-aligned
    // chunks — its per-chunk state reset loses frames split across chunks.)
    const stream = LOG_EVENT + COMPLETE_EVENT;
    const frameAlignedChunkings = [[stream], [LOG_EVENT, COMPLETE_EVENT]];
    for (const chunks of frameAlignedChunkings) {
      expect(newParser(chunks, { flush: true })).toEqual(lineStyleWithFlush(chunks));
      expect(newParser(chunks, { flush: true })).toEqual(newParser(chunks));
    }
    // The new parser's flush stays a no-op under ANY chunking.
    for (const chunks of chunkings(stream)) {
      expect(newParser(chunks, { flush: true })).toEqual(newParser([stream]));
    }
  });

  it('flushes a truncated trailing frame deterministically (documented difference)', () => {
    // Stream cut mid-frame (no closing blank line). The legacy pipeline/job
    // flush was chunking-DEPENDENT: the `event:` line's state was discarded at
    // chunk boundaries, so it emitted ('', <last data line>) — or nothing at
    // all if the cut ended in a newline. The new parser deterministically
    // emits the fully parsed trailing frame regardless of chunk boundaries.
    const chunks = [LOG_EVENT, 'event: complete\ndata: {"status":"succeeded"}'];
    expect(lineStyleWithFlush(chunks)).toEqual([
      { event: 'log', data: '{"sequence":1,"line":{"message":"hi"}}' },
      { event: '', data: '{"status":"succeeded"}' }, // event type lost by old parser
    ]);
    expect(newParser(chunks, { flush: true })).toEqual([
      { event: 'log', data: '{"sequence":1,"line":{"message":"hi"}}' },
      { event: 'complete', data: '{"status":"succeeded"}' }, // event type preserved
    ]);

    // Old parser silently dropped a truncated frame whose last line ended in
    // '\n'; the new parser still emits it.
    const chunks2 = [LOG_EVENT, 'data: {"tail":true}\n'];
    expect(lineStyleWithFlush(chunks2)).toEqual([
      { event: 'log', data: '{"sequence":1,"line":{"message":"hi"}}' },
    ]);
    expect(newParser(chunks2, { flush: true })).toEqual([
      { event: 'log', data: '{"sequence":1,"line":{"message":"hi"}}' },
      { event: '', data: '{"tail":true}' },
    ]);
  });

  it('matches local-mesh persistent line-based parsing without flush', () => {
    const frameAligned = [LOG_EVENT, 'event: pod_changed\ndata: {"pod":"a"}\n\n', HEARTBEAT_NO_DATA];
    expect(newParser(frameAligned)).toEqual(lineStylePersistent(frameAligned));
    // local-mesh keeps state across chunks, so mid-frame splits are also
    // well-defined for it; the new parser must agree.
    const split = ['event: log\nda', 'ta: {"line":"x"}\n', '\n'];
    expect(newParser(split)).toEqual(lineStylePersistent(split));
    // No trailing flush: a cut-off frame is dropped by both.
    const cut = [LOG_EVENT, 'data: {"dropped":true}'];
    expect(newParser(cut)).toEqual(lineStylePersistent(cut));
  });

  it('is invariant to chunk boundaries', () => {
    const stream = LOG_EVENT + COMMENT + NO_EVENT_FIELD + MULTI_DATA + HEARTBEAT_NO_DATA + COMPLETE_EVENT;
    const expected = newParser([stream]);
    for (const chunks of chunkings(stream)) {
      expect(newParser(chunks)).toEqual(expected);
    }
  });

  it('accepts mixed LF/CRLF separators via the \\r?\\n\\r?\\n superset', () => {
    const stream = 'event: log\r\ndata: {"a":1}\r\n\n' + 'data: {"b":2}\n\r\n';
    expect(newParser([stream])).toEqual([
      { event: 'log', data: '{"a":1}' },
      { event: '', data: '{"b":2}' },
    ]);
  });

  it('drops frames without data lines and reports absent event as undefined', () => {
    const parser = createSseFrameParser();
    expect(parser.push('event: heartbeat\n\nid: 4\n\n: comment\n\n')).toEqual([]);
    const frames = parser.push('data: x\n\n');
    expect(frames).toEqual([{ event: undefined, data: 'x' }]);
  });
});
