import { HttpException } from '@nestjs/common';
import type { ApiErrorDetail, ApiErrorResponse } from '@eve/shared';

export type ApiErrorOptions = {
  hint?: string;
  details?: Record<string, unknown>;
  requestId?: string | null;
};

export function buildApiError(
  status: number,
  code: string,
  message: string,
  options: ApiErrorOptions = {},
): HttpException {
  const error: ApiErrorDetail = {
    code,
    message,
    ...(options.hint ? { hint: options.hint } : {}),
    ...(options.details ? { details: options.details } : {}),
  };

  const payload: ApiErrorResponse = {
    error,
    ...(options.requestId ? { request_id: options.requestId } : {}),
  };

  return new HttpException(payload, status);
}
