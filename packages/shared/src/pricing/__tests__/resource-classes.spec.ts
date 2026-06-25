import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RATE_CARD_EFFECTIVE_AT,
  DEFAULT_RATE_CARD_NAME,
  DEFAULT_RATE_CARD_V1,
  DEFAULT_RATE_CARD_VERSION,
} from '../default-rate-card.js';
import {
  DEFAULT_RESOURCE_CLASS_NAME,
  DEFAULT_RESOURCE_CLASSES_V1,
  getResourceClassSpec,
  parseResourceClassesV1,
  resolveResourceClassName,
} from '../resource-classes.js';
import { assembleAttemptReceiptV2 } from '../receipt/assemble-attempt-receipt.js';

describe('resource classes', () => {
  it('parses resource_classes system setting JSON (sanitizes invalid entries)', () => {
    const raw = JSON.stringify({
      'job.c1': { vcpu: 1, memory_gib: 2, k8s: { cpu_request: '1', cpu_limit: '2', mem_request: '2Gi', mem_limit: '4Gi' } },
      'bad.nope': { vcpu: 0, memory_gib: 2 },
    });
    const parsed = parseResourceClassesV1(raw);
    expect(parsed).toBeTruthy();
    expect(parsed?.['job.c1']?.vcpu).toBe(1);
    expect(parsed?.['bad.nope']).toBeUndefined();
  });

  it('resolves resource_class name with precedence: job hints > manifest defaults > fallback', () => {
    expect(resolveResourceClassName({
      job_hints: { resource_class: 'job.c2' },
      manifest_defaults: { resource_class: 'job.c1' },
      fallback: DEFAULT_RESOURCE_CLASS_NAME,
    })).toBe('job.c2');

    expect(resolveResourceClassName({
      job_hints: null,
      manifest_defaults: { resource_class: 'job.c2' },
      fallback: DEFAULT_RESOURCE_CLASS_NAME,
    })).toBe('job.c2');

    expect(resolveResourceClassName({
      job_hints: null,
      manifest_defaults: null,
      fallback: DEFAULT_RESOURCE_CLASS_NAME,
    })).toBe(DEFAULT_RESOURCE_CLASS_NAME);
  });

  it('computes receipt compute usage from requested vcpu/mem and billable time', () => {
    const spec = getResourceClassSpec(DEFAULT_RESOURCE_CLASSES_V1, 'job.c1');
    expect(spec).toBeTruthy();

    const now = new Date('2026-02-09T00:00:00.000Z');
    const started = new Date(now.getTime() + 1_000);
    const execStarted = new Date(now.getTime() + 2_000);
    const ended = new Date(now.getTime() + 12_000); // 10s billable

    const { receipt } = assembleAttemptReceiptV2({
      job: {
        id: 'job_x',
        project_id: 'proj_x',
        created_at: now,
        ready_at: now,
        defer_until: null,
        phase: 'done',
        hints: { resource_class: 'job.c1' },
      },
      attempt: {
        id: 'att_x',
        job_id: 'job_x',
        started_at: started,
        execution_started_at: execStarted,
        ended_at: ended,
        duration_ms: null,
        runtime_meta: { runtime: 'local' },
      },
      org_id: 'org_x',
      logs: [],
      resource_class: {
        name: 'job.c1',
        requested_vcpu: spec!.vcpu,
        requested_memory_gib: spec!.memory_gib,
      },
      pricing: {
        rate_card: {
          name: DEFAULT_RATE_CARD_NAME,
          version: DEFAULT_RATE_CARD_VERSION,
          effective_at: DEFAULT_RATE_CARD_EFFECTIVE_AT,
          rates: DEFAULT_RATE_CARD_V1,
        },
        markup_pct: 0,
        billing_currency: 'usd',
        fx: null,
      },
    });

    expect(receipt.timing.billable_ms).toBe(10_000);
    expect(receipt.compute.resource_class).toBe('job.c1');
    expect(receipt.compute.requested.vcpu).toBe(1);
    expect(receipt.compute.requested.memory_gib).toBe(2);
    expect(receipt.compute.usage.vcpu_seconds).toBe(10);
    expect(receipt.compute.usage.memory_gib_seconds).toBe(20);

    // Compute rates exist in the default rate card; compute cost should be > 0 for 10s.
    expect(Number(receipt.base_cost_usd.compute_usd.amount)).toBeGreaterThan(0);
  });
});

