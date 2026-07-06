import { describe, it, expect } from 'vitest';
import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const schema = z.object({ org_id: z.string(), name: z.string().min(1) });
const bodyMeta: ArgumentMetadata = { type: 'body' };
const customMeta: ArgumentMetadata = { type: 'custom' };

describe('ZodValidationPipe', () => {
  it('validates and returns the body', () => {
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({ org_id: 'org_x', name: 'n' }, bodyMeta)).toEqual({
      org_id: 'org_x',
      name: 'n',
    });
  });

  it('throws a 400 with field paths on invalid body', () => {
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({}, bodyMeta)).toThrow(BadRequestException);
  });

  // Regression: a method-level @UsePipes(ZodValidationPipe) runs against every
  // argument, including @CurrentUser()/@CorrelationId() custom params. Those
  // must pass through untouched, not be parsed against the body schema.
  it('passes custom param values through without validating them', () => {
    const pipe = new ZodValidationPipe(schema);
    const authUser = { user_id: 'user_1', is_admin: true };
    expect(pipe.transform(authUser, customMeta)).toBe(authUser);
    expect(pipe.transform(undefined, customMeta)).toBeUndefined();
  });

  it('validates body when no metadata is supplied (defensive default)', () => {
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });
});
