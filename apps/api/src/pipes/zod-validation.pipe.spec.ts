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

  it('reports every issue with its path, message and code in the standard error body', () => {
    const pipe = new ZodValidationPipe(
      z.object({ slug: z.string().max(12), owner: z.object({ email: z.string().email() }) }),
    );
    let thrown: unknown;
    try {
      pipe.transform({ slug: 'manualtestorgx', owner: { email: 'nope' } }, bodyMeta);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    const exception = thrown as BadRequestException;
    expect(exception.getStatus()).toBe(400);
    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      errors: [
        { path: 'slug', message: 'String must contain at most 12 character(s)', code: 'too_big' },
        { path: 'owner.email', message: 'Invalid email', code: 'invalid_string' },
      ],
    });
  });

  it('uses an empty path for an issue with the body itself', () => {
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform('not an object', bodyMeta);
      expect.unreachable();
    } catch (error) {
      const body = (error as BadRequestException).getResponse() as { errors: Array<{ path: string; code: string }> };
      expect(body.errors).toEqual([expect.objectContaining({ path: '', code: 'invalid_type' })]);
    }
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
