/**
 * API-side K8s error wrapper. Mirrors apps/worker/src/deployer/k8s-error.ts but
 * targets `@kubernetes/client-node@1.4.x` which exposes the response body on
 * different fields (`response.body` shapes vary; object-style APIs often throw
 * errors with `response.statusCode` + `body`/`data`).
 *
 * The helper is permissive on both shapes so the API and worker can agree on
 * what a wrapped K8s error looks like, and callers can render the same
 * statusCode / reason / message fields whether an error bubbled from the worker
 * or from an API-owned K8s read.
 */

export interface K8sResourceRef {
  kind?: string;
  name?: string;
  namespace?: string;
}

export interface K8sErrorFields {
  statusCode?: number;
  reason?: string;
  operation: string;
  resourceKind?: string;
  resourceName?: string;
  namespace?: string;
  body?: unknown;
}

export class K8sOperationError extends Error {
  readonly statusCode?: number;
  readonly reason?: string;
  readonly operation: string;
  readonly resourceKind?: string;
  readonly resourceName?: string;
  readonly namespace?: string;
  readonly body?: unknown;

  constructor(message: string, fields: K8sErrorFields, options?: { cause?: unknown }) {
    super(message);
    this.name = 'K8sOperationError';
    this.statusCode = fields.statusCode;
    this.reason = fields.reason;
    this.operation = fields.operation;
    this.resourceKind = fields.resourceKind;
    this.resourceName = fields.resourceName;
    this.namespace = fields.namespace;
    this.body = fields.body;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isK8sNotFound(error: unknown): boolean {
  return extractStatusCode(error) === 404;
}

export function isK8sConflict(error: unknown): boolean {
  return extractStatusCode(error) === 409;
}

export function wrapK8sError(
  error: unknown,
  operation: string,
  resource: K8sResourceRef = {},
): K8sOperationError {
  if (error instanceof K8sOperationError) {
    return error;
  }

  const statusCode = extractStatusCode(error);
  const rawBody = extractBody(error);
  const parsedBody = normaliseBody(rawBody);
  const reason = extractReason(parsedBody) ?? extractStatusText(error);
  const apiMessage = extractApiMessage(parsedBody);
  const fallback = error instanceof Error ? error.message : String(error);

  const resourceLabel = resource.kind
    ? resource.name
      ? `${resource.kind}/${resource.name}`
      : resource.kind
    : 'resource';

  const statusPart =
    statusCode || reason
      ? ` (${[statusCode, reason].filter(Boolean).join(' ').trim()})`
      : '';

  const detail = apiMessage ?? (typeof rawBody === 'string' && rawBody ? rawBody : fallback);
  const message = `K8s ${operation} ${resourceLabel}${statusPart}: ${detail}`.trim();

  return new K8sOperationError(
    message,
    {
      statusCode,
      reason,
      operation,
      resourceKind: resource.kind,
      resourceName: resource.name,
      namespace: resource.namespace,
      body: parsedBody ?? rawBody,
    },
    { cause: error },
  );
}

function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  const direct = typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (direct) return direct;
  const responseObj = e.response as Record<string, unknown> | undefined;
  if (responseObj) {
    const rsc = typeof responseObj.statusCode === 'number' ? (responseObj.statusCode as number) : undefined;
    if (rsc) return rsc;
    const rstatus = typeof responseObj.status === 'number' ? (responseObj.status as number) : undefined;
    if (rstatus) return rstatus;
  }
  const code = typeof e.code === 'number' ? (e.code as number) : undefined;
  return code;
}

function extractStatusText(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  const responseObj = e.response as Record<string, unknown> | undefined;
  if (responseObj && typeof responseObj.statusMessage === 'string') {
    return responseObj.statusMessage as string;
  }
  return undefined;
}

function extractBody(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  if (e.body !== undefined && e.body !== null) return e.body;
  const responseObj = e.response as Record<string, unknown> | undefined;
  if (responseObj) {
    if (responseObj.body !== undefined && responseObj.body !== null) return responseObj.body;
    if (typeof responseObj.data !== 'undefined' && responseObj.data !== null) return responseObj.data;
    if (typeof responseObj.text === 'string') return responseObj.text;
  }
  return undefined;
}

function normaliseBody(body: unknown): unknown {
  if (body == null) return body;
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      return body.toString('utf8');
    }
  }
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return body;
      }
    }
    return body;
  }
  return body;
}

function extractReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.reason === 'string') return b.reason as string;
  return undefined;
}

function extractApiMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.message === 'string' && b.message) return b.message as string;
  const details = b.details as Record<string, unknown> | undefined;
  if (details && typeof details.name === 'string') {
    return `details.name=${details.name}`;
  }
  return undefined;
}
