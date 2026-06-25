import { describe, expect, it } from 'vitest';
import {
  IngressByteSizeSchema,
  IngressDurationSchema,
  parseIngressByteSize,
  parseIngressDuration,
} from '../ingress-units.js';

describe('ingress unit parsing', () => {
  it('parses duration strings into seconds', () => {
    expect(parseIngressDuration('1s')).toBe(1);
    expect(parseIngressDuration('30s')).toBe(30);
    expect(parseIngressDuration('5m')).toBe(300);
    expect(parseIngressDuration('30m')).toBe(1800);
  });

  it('validates duration strings and bounds', () => {
    expect(IngressDurationSchema.safeParse('1s').success).toBe(true);
    expect(IngressDurationSchema.safeParse('1800s').success).toBe(true);
    expect(IngressDurationSchema.safeParse('0s').success).toBe(false);
    expect(IngressDurationSchema.safeParse('1801s').success).toBe(false);
    expect(IngressDurationSchema.safeParse('1h').success).toBe(false);
    expect(IngressDurationSchema.safeParse('30S').success).toBe(false);
  });

  it('parses byte size strings into bytes', () => {
    expect(parseIngressByteSize('1k')).toBe(1024);
    expect(parseIngressByteSize('10m')).toBe(10 * 1024 ** 2);
    expect(parseIngressByteSize('1g')).toBe(1024 ** 3);
  });

  it('validates byte size strings and bounds', () => {
    expect(IngressByteSizeSchema.safeParse('1k').success).toBe(true);
    expect(IngressByteSizeSchema.safeParse('1g').success).toBe(true);
    expect(IngressByteSizeSchema.safeParse('0k').success).toBe(false);
    expect(IngressByteSizeSchema.safeParse('1025m').success).toBe(false);
    expect(IngressByteSizeSchema.safeParse('1023b').success).toBe(false);
    expect(IngressByteSizeSchema.safeParse('1g+1').success).toBe(false);
  });
});
