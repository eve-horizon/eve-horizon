import { describe, expect, it, vi } from 'vitest';
import { errorMessage } from '../errors.js';
import { readPositiveTimeoutSeconds, waitFor } from '../timing.js';
import { parseWorkerUrlMapping } from '../worker-routing.js';

describe('errorMessage', () => {
  it('extracts Error messages and stringifies everything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

describe('readPositiveTimeoutSeconds', () => {
  it('accepts positive finite numbers', () => {
    expect(readPositiveTimeoutSeconds(30)).toBe(30);
    expect(readPositiveTimeoutSeconds(0.5)).toBe(0.5);
  });

  it('accepts positive numeric strings', () => {
    expect(readPositiveTimeoutSeconds('45')).toBe(45);
    expect(readPositiveTimeoutSeconds(' 1.5 ')).toBe(1.5);
  });

  it('rejects zero, negatives, non-numerics, and infinities', () => {
    expect(readPositiveTimeoutSeconds(0)).toBeNull();
    expect(readPositiveTimeoutSeconds(-5)).toBeNull();
    expect(readPositiveTimeoutSeconds('abc')).toBeNull();
    expect(readPositiveTimeoutSeconds('-3')).toBeNull();
    expect(readPositiveTimeoutSeconds(Infinity)).toBeNull();
    expect(readPositiveTimeoutSeconds(null)).toBeNull();
  });
});

describe('waitFor', () => {
  it('resolves with the first truthy predicate value', async () => {
    let calls = 0;
    const result = await waitFor(
      async () => (++calls >= 3 ? 'ready' : false),
      { timeoutMs: 5000, intervalMs: 1 },
    );
    expect(result).toBe('ready');
    expect(calls).toBe(3);
  });

  it('throws with the label after the timeout elapses', async () => {
    await expect(
      waitFor(async () => false, { timeoutMs: 5, intervalMs: 1, label: 'widget readiness' }),
    ).rejects.toThrow('waiting for widget readiness');
  });

  it('invokes onTick between polls', async () => {
    const onTick = vi.fn();
    let calls = 0;
    await waitFor(async () => ++calls >= 2, { timeoutMs: 5000, intervalMs: 1, onTick });
    expect(onTick).toHaveBeenCalledTimes(1);
  });
});

describe('parseWorkerUrlMapping', () => {
  it('parses comma-separated name=url pairs', () => {
    const map = parseWorkerUrlMapping('default-worker=http://w:1, gpu=http://g:2');
    expect(map.get('default-worker')).toBe('http://w:1');
    expect(map.get('gpu')).toBe('http://g:2');
  });

  it('drops malformed entries and handles empty input', () => {
    expect(parseWorkerUrlMapping('').size).toBe(0);
    const map = parseWorkerUrlMapping('bare,=nourl,name=, ok=http://x');
    expect(map.size).toBe(1);
    expect(map.get('ok')).toBe('http://x');
  });
});
