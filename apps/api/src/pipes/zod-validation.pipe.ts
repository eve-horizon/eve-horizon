import {
  PipeTransform,
  Injectable,
  BadRequestException,
  type ArgumentMetadata,
} from '@nestjs/common';
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

/** One failed check in a validation error response. */
export interface ValidationIssue {
  /** Dotted path to the offending field, `''` for the body itself. */
  path: string;
  message: string;
  /** Zod issue code, for example `too_big` or `invalid_type`. */
  code: string;
}

/**
 * The 400 a request gets when its body fails schema validation:
 * `{ statusCode, error, message: 'Validation failed', errors: [{ path, message, code }] }`.
 * `statusCode` and `error` match Nest's default error body; `message` and the
 * `path`/`message` of each issue are the original contract and must not change.
 */
export function validationFailedException(issues: readonly ZodIssue[]): BadRequestException {
  const errors: ValidationIssue[] = issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: 'Validation failed',
    errors,
  });
}

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodSchema) {}

  transform(value: unknown, metadata?: ArgumentMetadata) {
    // Only validate the request body. When applied at the method level via
    // @UsePipes, NestJS runs this pipe against every argument — including
    // custom param decorators like @CurrentUser()/@CorrelationId() (type
    // 'custom'), whose values must not be parsed against a body schema.
    // (@Req()-style native params are already excluded by NestJS.) This pipe
    // is only ever attached to bodies — never @Query/@Param — so restricting
    // to 'body' is safe and fixes method-level pipe + custom-param handlers.
    if (metadata && metadata.type !== 'body') {
      return value;
    }
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (isZodError(error)) {
        throw validationFailedException(error.errors);
      }
      throw error;
    }
  }
}
