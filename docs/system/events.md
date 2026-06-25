# Events (Event Spine)

> Status: Current
> Last Updated: 2026-05-15
> Purpose: Document the event spine, event sources, and routing behavior.

## Current (Implemented)

### Event Model

Events are stored in Postgres and keyed by TypeID (`evt_xxx`). Core fields:

- `type`: namespaced event type (e.g., `github.push`, `cron.tick`)
- `source`: `github` | `slack` | `cron` | `manual` | `app` | `app_link` | `system` | `runner` | `chat` | `auth`
- `status`: `pending` → `processing` → `completed` / `failed`
- `payload_json`: event-specific payload (optional)
- `env_name`, `ref_sha`, `ref_branch`: optional context
- `actor_type` / `actor_id`: user/system/app attribution
- `dedupe_key`: optional idempotency key

### API Endpoints

```
POST /projects/{project_id}/events
GET  /projects/{project_id}/events
GET  /projects/{project_id}/events/{event_id}

# internal (runner -> api)
POST /internal/projects/{project_id}/events
```

### GitHub Webhooks

```
POST /integrations/github/events/{project_id}
```

The API verifies webhook signatures, normalizes `push` and `pull_request` events,
and stores the full payload in `payload_json`.

### Slack Webhooks

```
POST /integrations/slack/events
```

Slack Events are handled by the **Gateway** service (not the API). The gateway
verifies signatures, handles URL verification, resolves `team_id -> org_id`,
and forwards normalized events into chat routing/dispatch (creating jobs and
threads as needed).

### System Failure Events

The orchestrator emits system events on job and pipeline failures:

- `system.job.failed`
- `system.pipeline.failed`

### Document Events

Org document mutations emit system events (stored in the event spine):

- `system.doc.created`
- `system.doc.updated`
- `system.doc.deleted`

Payload includes: `org_id`, `project_id`, `doc_id`, `doc_version_id`, `path`,
`version`, `content_hash`, `mutation_id`, `request_id`, and `metadata`.

### Webhook Events

Org and project webhooks can subscribe to event types emitted by the API. The
webhook system stores deliveries and supports replay of failed or filtered
deliveries via the webhook replay API.

When an event is created, the webhook service finds matching subscriptions and
enqueues deliveries using the event payload as a CloudEvents `data` object.

### Resource Hydration Events

Worker hydration emits provisioning events when `resource_refs` are resolved:

- `system.resource.hydration.started`
- `system.resource.hydration.completed`
- `system.resource.hydration.failed`

Payload includes: `job_id`, `attempt_id`, `resolved_count`,
`missing_optional_count`, `failed_required_count`, and per-resource status.

### Runner Events

Runner pods emit lifecycle events for worker coordination:

- `runner.started`
- `runner.progress`
- `runner.completed`
- `runner.failed`

Payload (camelCase):
- `attemptId`, `jobId`
- `message`, `percentage` (progress)
- `result` (completed)
- `error`, `exitCode` (failed)

System failure events include:
- `job_id` / `attempt_id` (job failure)
- `run_id` / `pipeline_name` (pipeline failure)
- `error_message`
- `error_code` (taxonomy seed for remediation)
- `exit_code` (when available)

### LLM Usage Events

Harnesses emit `llm.call` events after each provider call. These events contain
usage-only metadata (token counts, model identifiers) and are used for receipts
and live cost tracking. No prompt or response content is included.

### App-Link Events

Producer projects can export event feeds through `x-eve.app_links.exports`.
When a matching producer event is processed, the orchestrator queues an
`app_link_event_deliveries` row and inserts a consumer-side event with
`source: app_link`, the original event `type`, and dedupe key
`app_link:<subscription_id>:<source_event_id>`.

The consumer event payload includes `producer_event_id`, `producer_project_id`,
`producer_env_name`, `producer_export_name`, `link_alias`, and `original`.
Consumers can trigger workflows from app-link deliveries with:

```yaml
trigger:
  app_link:
    alias: observation
    type: app.observation.created
```

### Orchestrator Event Router

The orchestrator polls pending events every 5 seconds, matches manifest triggers,
and creates pipeline runs or workflow jobs when triggers match.

**Claiming mechanics:** Events are claimed in batches using
`FOR UPDATE SKIP LOCKED`, so multiple orchestrator instances can safely
process the queue without double-claiming.

### Deduplication

Events can include a `dedupe_key` to prevent duplicate inserts. The API checks
for existing events with the same key before creating a new record.

### CLI

```bash
eve event list [project] [--type] [--source] [--status]
eve event show <event_id>
eve event emit --type=<type> --source=<source> [--payload <json>]
```

## Planned (Not Implemented)

- Manifest-driven cron scheduling and event emission
- Stronger dedupe/idempotency semantics
