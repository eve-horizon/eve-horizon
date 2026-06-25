import { z } from 'zod';

const DURATION_PATTERN = /^(\d+)(s|m|h)$/;
const BYTE_SIZE_PATTERN = /^(\d+)(k|m|g)$/;

const DURATION_MULTIPLIERS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
};

const BYTE_SIZE_MULTIPLIERS: Record<string, number> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

export const DEFAULT_INGRESS_TIMEOUT = '300s';
export const DEFAULT_INGRESS_MAX_BODY_SIZE = '10m';

export function parseIngressDuration(value: string): number {
  const match = value.match(DURATION_PATTERN);
  if (!match) {
    throw new Error(`use a lowercase duration like "30s", "5m", or "30m"; got "${value}"`);
  }
  return Number(match[1]) * DURATION_MULTIPLIERS[match[2]];
}

export function parseIngressByteSize(value: string): number {
  const match = value.match(BYTE_SIZE_PATTERN);
  if (!match) {
    throw new Error(`use a lowercase size like "512k", "10m", or "1g"; got "${value}"`);
  }
  return Number(match[1]) * BYTE_SIZE_MULTIPLIERS[match[2]];
}

export function getIngressDurationValidationError(value: string): string | null {
  let seconds: number;
  try {
    seconds = parseIngressDuration(value);
  } catch (error) {
    return `timeout must ${error instanceof Error ? error.message : String(error)}`;
  }

  if (seconds < 1 || seconds > 1800) {
    return `timeout must be between 1s and 30m; got "${value}"; for longer work use Eve jobs`;
  }
  return null;
}

export function getIngressByteSizeValidationError(value: string): string | null {
  let bytes: number;
  try {
    bytes = parseIngressByteSize(value);
  } catch (error) {
    return `max_body_size must ${error instanceof Error ? error.message : String(error)}`;
  }

  if (bytes < 1024 || bytes > 1024 ** 3) {
    return `max_body_size must be between 1k and 1g; got "${value}"; for larger payloads use signed-URL upload to object storage`;
  }
  return null;
}

export const IngressDurationSchema = z.string().superRefine((value, ctx) => {
  const error = getIngressDurationValidationError(value);
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }
});

export const IngressByteSizeSchema = z.string().superRefine((value, ctx) => {
  const error = getIngressByteSizeValidationError(value);
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }
});
