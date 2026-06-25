export interface RawSseEvent {
  event: string;
  data: unknown;
  id?: string;
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<RawSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        const separator = buffer.match(/\r?\n\r?\n/);
        buffer = buffer.slice(boundary + (separator?.[0].length ?? 2));
        const event = parseSseEvent(raw);
        if (event) yield event;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseSseEvent(raw: string): RawSseEvent | null {
  if (!raw.trim()) return null;
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    if (line.startsWith('id:')) id = line.slice('id:'.length).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }

  const text = dataLines.join('\n');
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return { event, data, ...(id ? { id } : {}) };
}
