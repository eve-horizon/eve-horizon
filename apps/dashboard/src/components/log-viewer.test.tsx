// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const history = vi.hoisted(() => ({ logs: [] as Array<{ sequence: number; text: string }> }));

vi.mock('@/lib/api', () => ({
  api: vi.fn(async () => ({ logs: history.logs })),
  createEventSource: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: string,
    ) {
      super(`API ${status}: ${body}`);
    }
  },
}));

import { LogViewer } from './log-viewer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let container: HTMLDivElement;
let root: Root;

async function renderLog(lines: string[]): Promise<HTMLDivElement> {
  history.logs = lines.map((text, i) => ({ sequence: i + 1, text }));
  await act(async () => {
    root.render(<LogViewer jobId="job-1" />);
  });
  return container;
}

async function typeSearch(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  if (!input) throw new Error('search input not rendered');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('LogViewer line rendering', () => {
  it('shows markup in a log line as text, not as elements', async () => {
    const view = await renderLog(['<a href="/docs" title="Docs">docs</a>', 'before <i>y</i> after']);

    expect(view.querySelector('a')).toBeNull();
    expect(view.querySelector('i')).toBeNull();
    expect(view.textContent).toContain('<a href="/docs" title="Docs">docs</a>');
    expect(view.textContent).toContain('before <i>y</i> after');
  });

  it('keeps ANSI colours while showing markup inside them as text', async () => {
    const view = await renderLog(['\x1b[31m<u class="note">red</u>\x1b[0m tail', '\x1b[1m\x1b[32m<b>ok</b>\x1b[0m']);

    expect(view.querySelector('u')).toBeNull();
    expect(view.querySelector('b')).toBeNull();
    expect(view.querySelector('.text-red-400')?.textContent).toBe('<u class="note">red</u>');
    const green = view.querySelector('.text-green-400');
    expect(green?.textContent).toBe('<b>ok</b>');
    expect(green?.className).toContain('font-bold');
    expect(view.textContent).not.toContain('\x1b');
  });

  it('highlights search matches inside text that contains markup characters', async () => {
    await renderLog(['if a < b && c > d then <tag>']);
    await typeSearch('<tag>');

    const highlighted = Array.from(container.querySelectorAll('span'))
      .filter((el) => el.className.includes('bg-[var(--amber)]'))
      .map((el) => el.textContent);
    expect(highlighted).toEqual(['<tag>']);
    expect(container.querySelector('tag')).toBeNull();
    expect(container.textContent).toContain('if a < b && c > d then <tag>');
  });
});
