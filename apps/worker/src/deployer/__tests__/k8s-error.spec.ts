import { describe, expect, it } from 'vitest';
import { K8sOperationError, isK8sConflict, isK8sNotFound, wrapK8sError } from '../k8s-error.js';

describe('wrapK8sError', () => {
  it('extracts status code, reason, and message from v0.22 (err.body) shape', () => {
    const raw = Object.assign(new Error('HTTP request failed'), {
      statusCode: 422,
      body: {
        kind: 'Status',
        reason: 'Invalid',
        message: 'Ingress.networking.k8s.io "limelee" is invalid: spec.rules[0].host: Invalid value',
      },
    });

    const wrapped = wrapK8sError(raw, 'replace', {
      kind: 'Ingress',
      name: 'limelee',
      namespace: 'eve-x-staging',
    });

    expect(wrapped).toBeInstanceOf(K8sOperationError);
    expect(wrapped.statusCode).toBe(422);
    expect(wrapped.reason).toBe('Invalid');
    expect(wrapped.operation).toBe('replace');
    expect(wrapped.resourceKind).toBe('Ingress');
    expect(wrapped.resourceName).toBe('limelee');
    expect(wrapped.namespace).toBe('eve-x-staging');
    expect(wrapped.message).toMatch(/K8s replace Ingress\/limelee \(422 Invalid\): Ingress\.networking\.k8s\.io.*Invalid value/);
    expect((wrapped as { cause?: unknown }).cause).toBe(raw);
  });

  it('extracts fields from v1.4 (err.response.body) shape', () => {
    const raw = Object.assign(new Error('HTTP request failed'), {
      response: {
        statusCode: 404,
        body: { kind: 'Status', reason: 'NotFound', message: 'deployments.apps "api" not found' },
      },
    });

    const wrapped = wrapK8sError(raw, 'read', { kind: 'Deployment', name: 'api' });

    expect(wrapped.statusCode).toBe(404);
    expect(wrapped.reason).toBe('NotFound');
    expect(wrapped.message).toContain('deployments.apps "api" not found');
  });

  it('handles string bodies from admission webhooks', () => {
    const raw = Object.assign(new Error('HTTP request failed'), {
      statusCode: 422,
      body: 'admission webhook "validate.nginx.ingress.kubernetes.io" denied the request: host "api.limelee.com" and path "/" is already defined in ingress eve-proj-prod/prod-api-cd',
    });

    const wrapped = wrapK8sError(raw, 'replace', { kind: 'Ingress', name: 'staging-api-cd' });

    expect(wrapped.statusCode).toBe(422);
    expect(wrapped.message).toContain('already defined in ingress eve-proj-prod/prod-api-cd');
  });

  it('handles JSON-encoded string bodies', () => {
    const raw = Object.assign(new Error('HTTP request failed'), {
      statusCode: 422,
      body: JSON.stringify({ kind: 'Status', reason: 'Invalid', message: 'parsed from string' }),
    });

    const wrapped = wrapK8sError(raw, 'create', { kind: 'Service', name: 'api' });

    expect(wrapped.reason).toBe('Invalid');
    expect(wrapped.message).toContain('parsed from string');
    expect(wrapped.body).toMatchObject({ reason: 'Invalid', message: 'parsed from string' });
  });

  it('handles Buffer bodies', () => {
    const raw = Object.assign(new Error('HTTP request failed'), {
      statusCode: 500,
      body: Buffer.from(JSON.stringify({ message: 'internal error', reason: 'InternalError' }), 'utf8'),
    });

    const wrapped = wrapK8sError(raw, 'read', { kind: 'Pod', name: 'x' });

    expect(wrapped.statusCode).toBe(500);
    expect(wrapped.message).toContain('internal error');
  });

  it('falls back to error.message when body lacks a message', () => {
    const raw = new Error('Connection refused');

    const wrapped = wrapK8sError(raw, 'list', { kind: 'Pod' });

    expect(wrapped.statusCode).toBeUndefined();
    expect(wrapped.message).toContain('Connection refused');
  });

  it('preserves the wrapper when called on an already-wrapped error', () => {
    const raw = Object.assign(new Error('HTTP request failed'), {
      statusCode: 422,
      body: { message: 'invalid' },
    });
    const wrapped = wrapK8sError(raw, 'replace', { kind: 'Ingress', name: 'x' });
    const rewrapped = wrapK8sError(wrapped, 'replace', { kind: 'Ingress', name: 'x' });

    expect(rewrapped).toBe(wrapped);
  });

  it('isK8sNotFound and isK8sConflict detect status codes in both shapes', () => {
    const v022 = Object.assign(new Error('x'), { statusCode: 404 });
    const v14 = Object.assign(new Error('x'), { response: { statusCode: 409 } });
    expect(isK8sNotFound(v022)).toBe(true);
    expect(isK8sNotFound(v14)).toBe(false);
    expect(isK8sConflict(v14)).toBe(true);
    expect(isK8sConflict(v022)).toBe(false);
  });

  it('returns false for non-errors on type guards', () => {
    expect(isK8sNotFound(null)).toBe(false);
    expect(isK8sNotFound(undefined)).toBe(false);
    expect(isK8sNotFound('oops')).toBe(false);
  });
});
