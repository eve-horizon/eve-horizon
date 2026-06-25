import { describe, expect, it } from 'vitest';
import { K8sOperationError, isK8sConflict, isK8sNotFound, wrapK8sError } from './k8s-error.js';

describe('apps/api wrapK8sError', () => {
  it('extracts fields from v1.4 client response shape', () => {
    // v1.4 object-style errors often carry response.statusCode + body/data
    const raw = Object.assign(new Error('HTTP request failed'), {
      response: {
        statusCode: 422,
        body: { kind: 'Status', reason: 'Invalid', message: 'Ingress spec.rules[0].host is invalid' },
      },
    });

    const wrapped = wrapK8sError(raw, 'replace', { kind: 'Ingress', name: 'vanity', namespace: 'eve-x' });

    expect(wrapped).toBeInstanceOf(K8sOperationError);
    expect(wrapped.statusCode).toBe(422);
    expect(wrapped.reason).toBe('Invalid');
    expect(wrapped.resourceKind).toBe('Ingress');
    expect(wrapped.resourceName).toBe('vanity');
    expect(wrapped.namespace).toBe('eve-x');
    expect(wrapped.message).toContain('spec.rules[0].host is invalid');
  });

  it('handles errors without response bodies', () => {
    const raw = new Error('Connection refused');
    const wrapped = wrapK8sError(raw, 'list', { kind: 'Pod', namespace: 'eve-x' });
    expect(wrapped.message).toContain('Connection refused');
    expect(wrapped.statusCode).toBeUndefined();
  });

  it('handles plain-text admission webhook bodies under response.body', () => {
    const raw = Object.assign(new Error('HTTP request failed'), {
      response: {
        statusCode: 422,
        body: 'admission webhook denied the request: host already defined',
      },
    });
    const wrapped = wrapK8sError(raw, 'replace', { kind: 'Ingress', name: 'api' });
    expect(wrapped.statusCode).toBe(422);
    expect(wrapped.message).toContain('host already defined');
  });

  it('type guards match both shapes', () => {
    const v022 = Object.assign(new Error('x'), { statusCode: 404 });
    const v14 = Object.assign(new Error('x'), { response: { statusCode: 409 } });
    expect(isK8sNotFound(v022)).toBe(true);
    expect(isK8sConflict(v14)).toBe(true);
  });
});
