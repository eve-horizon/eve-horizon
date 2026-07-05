import { BadRequestException } from '@nestjs/common';

/** Parse a boolean query param: true/1/yes/y/on (case-insensitive). */
export function parseBoolean(value?: string): boolean {
  if (!value) return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

/** Parse an optional ISO date query param; 400 on garbage. */
export function parseOptionalDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }
  return d;
}
