# Observability

> Status: Current
> Last Updated: 2026-04-30

## Purpose

Define how correlation IDs, logs, and OTEL instrumentation work in Eve Horizon.

## Current (Implemented)

### Correlation IDs

- Header: `x-eve-correlation-id`
- If missing on inbound requests, a UUID is generated and echoed back in the response.
- Correlation IDs are propagated across API → Orchestrator → Worker → Runner via headers.

### Structured Logging

Services emit JSON logs with these standard fields:

- `timestamp`
- `level`
- `service`
- `message`
- `correlation_id`
- `trace_id`
- `job_id` (when available)
- `attempt_id` (when available)
- `event_id` (when available)

Job execution lifecycle events are also written to `execution_logs` with correlation fields
embedded in the lifecycle `meta` object.

Environment service logs are available through the API and CLI:

```bash
eve env logs <project> <env> <service> --tail 200
eve env logs <project> <env> <service> --follow --since 30
eve env logs <project> <env> <service> --grep req_01h...
eve env logs <project> <env> <service> --filter req_id=req_01h... --filter level=error
eve env logs <project> <env> <service> --filter req.path=/api/items --follow
```

`--filter` is repeatable and uses exact-match `k=v` checks against JSON log
fields. Dotted paths are supported for nested JSON objects. When a line is not
JSON, `--grep` still applies and filters fall back to matching filter values in
the raw line.

### Request-Level Diagnostics

Use request diagnostics when a single HTTP/API request needs a one-shot dump
across logs, deployment metadata, K8s events, optional audit logs, and traces:

```bash
eve env diagnose <project> <env> --request req_01h... --window 120 --json
```

The command returns a stable structure even when data is missing: `logs`,
`k8s_events`, `deploy`, `traces`, and optional `audit_log_entries`. Missing
logs or traces produce empty arrays and warnings instead of a 404.

Apps can opt into audit-log collection by declaring the audit table on a
service's `x-eve` block:

```yaml
services:
  api:
    x-eve:
      audit_log_table: audit_log
      request_id_column: request_id
```

`request_id_column` defaults to `request_id`.

### Execution Receipts + Cost Events

Attempts can persist an **execution receipt** that includes timing, token usage,
and cost breakdowns. Receipts are assembled from lifecycle events plus `llm.call`
usage events and stored on the attempt.

- `llm.call` events contain usage only (no content) and are emitted by harnesses
  after each provider call.
- Receipts are exposed via `GET /jobs/{job_id}/receipt` and the CLI
  (`eve job receipt`, `eve job compare`).
- `eve job follow` displays live cost totals when `llm.call` events stream.

### OpenTelemetry (OTEL)

OTEL is enabled when `OTEL_ENABLED=true` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
It uses the OTLP HTTP exporter and automatic Node.js instrumentation.

Supported env vars:

- `OTEL_ENABLED=true|false`
- `OTEL_DISABLED=true` (hard disable)
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`

Request trace lookup uses the configured X-Ray-compatible trace backend. Apps
that want `eve traces query --request-id <id>` to work must stamp `request_id`
as an annotation/attribute on the active span. Use the shared helper:

```ts
import { stampCurrentRequestId } from '@eve/shared';

stampCurrentRequestId(requestId);
```

Trace CLI examples:

```bash
eve traces query --project proj_xxx --request-id req_01h... --json
eve traces query --project proj_xxx --trace-id 1-abcdef...
eve traces query --project proj_xxx --service api --since 5m --error
eve traces query --project proj_xxx --service api --route "POST /api/items" --since 1h --p99
```

## Planned (Not Implemented)

- Service-level metrics dashboards for queue latency, job duration, and error rates.
- Correlation-aware log sampling rules per environment.
- Automated log shipping presets for managed cloud logging services.
