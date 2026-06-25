import { z } from 'zod';

export const TraceSpanSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable().optional(),
  name: z.string(),
  service: z.string().nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  error: z.boolean().optional(),
  fault: z.boolean().optional(),
  throttle: z.boolean().optional(),
  annotations: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  http: z.record(z.unknown()).optional(),
});

export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export const TraceQueryResponseSchema = z.object({
  project_id: z.string(),
  service: z.string().nullable().optional(),
  request_id: z.string().nullable().optional(),
  trace_id: z.string().nullable().optional(),
  route: z.string().nullable().optional(),
  since_seconds: z.number().nullable().optional(),
  error: z.boolean().optional(),
  p99: z.boolean().optional(),
  backend: z.string(),
  backend_available: z.boolean(),
  traces: z.array(z.object({
    trace_id: z.string(),
    duration_ms: z.number().nullable().optional(),
    response_time_ms: z.number().nullable().optional(),
    has_error: z.boolean().optional(),
    spans: z.array(TraceSpanSchema),
  })),
  summary: z.object({
    trace_count: z.number(),
    span_count: z.number(),
    p99_ms: z.number().nullable().optional(),
  }),
  warnings: z.array(z.string()).optional(),
});

export type TraceQueryResponse = z.infer<typeof TraceQueryResponseSchema>;
