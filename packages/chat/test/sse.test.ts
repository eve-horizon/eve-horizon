import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../src/sse.js';

describe('parseSseStream', () => {
  it('parses event id, type, and JSON data', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: msg_1\nevent: message\ndata: {"body":"hi"}\n\n'));
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);

    expect(events).toEqual([
      { id: 'msg_1', event: 'message', data: { body: 'hi' } },
    ]);
  });
});
