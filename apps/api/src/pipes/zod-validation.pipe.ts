import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { ZodSchema, type ZodIssue } from 'zod';

/**
 * Check whether an error is a ZodError without relying on `instanceof`.
 *
 * `instanceof ZodError` can fail when Zod is resolved through multiple
 * module paths (ESM zod/v3 vs CJS zod), which happens with zod ≥3.25
 * dual-package builds.  A duck-type check on the shape avoids this.
 */
function isZodError(error: unknown): error is { name: string; errors: ZodIssue[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<string, unknown>).name === 'ZodError' &&
    Array.isArray((error as Record<string, unknown>).errors)
  );
}

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodSchema) {}

  transform(value: unknown) {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (isZodError(error)) {
        throw new BadRequestException({
          message: 'Validation failed',
          errors: error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
      }
      throw error;
    }
  }
}
