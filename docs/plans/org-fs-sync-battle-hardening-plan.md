# Org Filesystem Sync Battle-Hardening Plan

> Status: In Progress (Phase 2-4 baseline implemented; Phase 0/1/5/6 hardening pending)
> Last Updated: 2026-02-14
> Purpose: Harden Eve's org-level persistent filesystem and deliver low-latency one-way/two-way sync for macOS users via the Eve CLI.

## Problem

We need a production-grade org filesystem that:

1. Survives node/pod/storage failures without data loss.
2. Supports user-managed sync from macOS through `eve` CLI.
3. Supports `two-way`, `push-only`, and `pull-only` sync modes.
4. Propagates updates in seconds, event-first (not periodic polling loops).
5. Optimizes wire usage for markdown-heavy workloads by shipping deltas/blocks, not full files when possible.

## Current State (What Exists Today)

1. Org filesystem exists as a PVC mounted in agent-runtime (`/org`) and symlinked into job workspaces as `.org`.
2. Base K8s manifest requests `ReadWriteMany` for org FS, but local overlay patches it to `ReadWriteOnce`.
3. Org document APIs are implemented and DB-backed (`org_documents`, `org_document_versions`) with search and version history.
4. Events exist for document mutations (`system.doc.created|updated|deleted`), but no dedicated org filesystem sync/event pipeline.
5. CLI has `eve docs` CRUD/search and `eve resources` resolution, but no watch/sync daemon experience.

## Design Decision

Use a hybrid architecture:

1. `Syncthing` as the file replication data plane.
2. Eve API as control/auth/policy/audit plane.
3. New org-fs event spine (`org_fs_events`) for durable ordering and replay.
4. Realtime delivery via Postgres `LISTEN/NOTIFY` + SSE/WebSocket fanout.

Why this choice:

1. Syncthing gives mature block-level sync, file watchers, conflict handling, and one-way/two-way folder modes.
2. Eve keeps tenancy, RBAC, enrollment, audit, and platform UX in one place.
3. Event spine gives replayable reliability instead of transient watcher-only behavior.

## Architecture (Target)

```text
macOS eve CLI + eve-syncd
  -> local watcher + Syncthing device
  -> secure relay/control (Eve API)
  -> org sync gateway (Syncthing sidecar in cluster)
  -> org PVC path (/org/<org_id>)

Control path:
  eve fs sync init/status/pause/resume -> Eve API

Event path:
  sync gateway + API mutations -> org_fs_events (DB)
  org_fs_events INSERT -> pg_notify('org_fs_events', ...)
  API stream service LISTEN -> SSE/WebSocket to CLI/UI

Metadata/search path:
  markdown updates -> org_documents projection/index refresh
```

## Scope

In scope:

1. Org filesystem hardening and sync reliability.
2. macOS CLI setup and lifecycle for sync clients.
3. Three sync modes: `two-way`, `push-only`, `pull-only`.
4. Event-first update visibility within seconds.
5. Markdown-first defaults and conflict ergonomics.

Out of scope (for this phase):

1. Windows/Linux desktop packaging.
2. Binary/media-first optimization profiles.
3. Cross-region active-active replication.

## Delivery Phases

### Phase 0: Preconditions and Baseline

Deliverables:

1. Confirm storage classes by environment and document RWX requirements.
2. Define SLOs and benchmark harness for sync lag and conflict rate.
3. Add explicit org FS ownership model (`/org/<org_id>` root partitioning).

Acceptance tests:

1. Load test baseline report exists with p50/p95 sync lag and throughput.
2. RWX capability matrix documented for local, staging, production.
3. Tenant path-isolation test proves no cross-org traversal.

### Phase 1: Storage and Data Safety Hardening

Deliverables:

1. Replace single default org PVC pattern with org-partitioned storage semantics.
2. Add quotas and guardrails (bytes, file count, max file size).
3. Add snapshot/restore runbooks and automated backup checks.
4. Add startup integrity checks (mount health, writable checks, low-space alarms).

Acceptance tests:

1. Simulated pod restart does not lose files.
2. Quota breach fails safely with actionable error.
3. Restore drill reproduces expected files and checksums.

### Phase 2: Sync Control Plane

Deliverables:

1. Device enrollment flow with short-lived link tokens.
2. Sync connection model per org + device + local root.
3. Direction mode support (`two-way|push-only|pull-only`).
4. Path policies (allowlist roots and ignore patterns).
5. Device revocation and token rotation.

Acceptance tests:

1. New Mac can enroll with one command and sync successfully.
2. Revoked device can no longer connect or mutate.
3. Mode changes take effect without full re-init.

### Phase 3: Event Spine and Realtime Streams

Deliverables:

1. `org_fs_events` table with ordered sequence and replay cursors.
2. Trigger-based `NOTIFY` and API stream service.
3. SSE endpoint for CLI (`--follow`) and WebSocket endpoint for dashboards.
4. Resume-from-cursor semantics for disconnect/reconnect.

Acceptance tests:

1. End-to-end update appears on remote client within target SLO under nominal load.
2. Stream reconnect resumes from last cursor without duplicate side effects.
3. Outage replay catches all missed events in order.

### Phase 4: CLI UX (`eve fs sync ...`)

Deliverables:

1. `eve fs sync init` bootstraps device + local daemon.
2. `eve fs sync status` shows mode, lag, peer state, backlog.
3. `eve fs sync logs --follow` streams org fs events.
4. `eve fs sync pause|resume|disconnect` operational controls.
5. `eve fs sync conflicts` and `eve fs sync doctor` diagnostics.

Acceptance tests:

1. Non-expert setup succeeds in < 5 minutes on clean macOS machine.
2. CLI status reflects actual backend/peer health in real time.
3. Doctor identifies common failures (auth, connectivity, permission, disk).

### Phase 5: Markdown-Optimized Conflict and Diff Workflow

Deliverables:

1. Default include profile for markdown/text/yaml paths.
2. Conflict policy:
   1. automatic non-overlapping merge when safe
   2. conflict artifact creation when unsafe
3. Server-side diff summaries for markdown conflicts.
4. Optional API patch route for markdown semantic updates where applicable.

Acceptance tests:

1. Concurrent edits on different sections auto-merge correctly.
2. True conflicts are surfaced clearly and recoverable.
3. Median bytes transferred per markdown edit stays within target envelope.

### Phase 6: Battle-Hardening, Chaos, and Launch Gates

Deliverables:

1. Chaos tests: network partitions, delayed reconnects, storage pressure, pod churn.
2. Security tests: replay attacks, token reuse, path traversal, cross-org access attempts.
3. Observability: dashboards, alerts, on-call runbook, SLO alerts.
4. Canary rollout by org with rollback switch.

Acceptance tests:

1. No cross-org read/write found in security test suite.
2. Canary orgs meet SLO for 7 consecutive days.
3. Rollback can disable sync plane without data corruption.

## SLOs and Launch Gates

Initial SLOs:

1. Update visibility: 95% of connected-peer changes visible within 5 seconds.
2. Durability: zero acknowledged-write loss across single pod restarts.
3. Availability: 99.9% monthly sync-control API uptime.
4. Conflict rate: < 1% of markdown mutations become unresolved conflicts.

Launch gates:

1. All phase acceptance tests green.
2. Backup/restore drill signed off.
3. Security review signed off.
4. Canary burn-in complete.

## Risks and Mitigations

1. RWX storage variability across environments.
   Mitigation: explicit storage-class contract and conformance checks.
2. Watcher edge cases dropping local events.
   Mitigation: event spine + periodic reconciler safety net.
3. Conflict overload in high-collaboration docs.
   Mitigation: markdown merge strategy + conflict triage CLI.
4. Long-tail operational complexity.
   Mitigation: `eve fs sync doctor`, structured error codes, clear runbooks.

## Recommended Open-Source Components

1. Syncthing (primary sync data plane).
2. PostgreSQL LISTEN/NOTIFY (realtime event fanout).
3. Existing Eve API/CLI as control and auth surface.

Optional fallback:

1. Mutagen (if specific environments need alternate transport behavior), but not default.

## Open Questions + Recommendations (Resolved)

1. **RWX/RWO by environment**
   Recommendation: keep local on `ReadWriteOnce` (single gateway writer) and require `ReadWriteMany` for staging/production before multi-device rollout.
2. **Permission split timing (`orgs:*` vs `orgfs:*`)**
   Recommendation: ship with `orgs:read|write` now, add `orgfs:*` only when non-sync org operations need stricter separation.
3. **Primary data-plane transport**
   Recommendation: standardize on Syncthing for GA; keep Mutagen as a documented contingency only, not dual-default.
4. **Enrollment token lifecycle**
   Recommendation: use short-lived one-time tokens (10 minutes), persisted server-side, and invalidate on consume/expiry.
5. **Event stream contract**
   Recommendation: keep strict per-org `seq` cursor semantics and SSE resume via `after_seq`; allow heartbeat checkpoints when idle.
6. **Migration numbering drift from draft**
   Recommendation: use next real migration slots in repo (`00059_org_fs_sync.sql`, `00060_org_fs_events_notify.sql`) instead of draft placeholders.

## References

1. Syncthing docs: https://docs.syncthing.net/users/syncing.html
2. Syncthing folder modes: https://docs.syncthing.net/users/foldertypes.html
3. Syncthing versioning: https://docs.syncthing.net/users/versioning.html
4. Postgres NOTIFY/LISTEN: https://www.postgresql.org/docs/current/sql-notify.html
5. Kubernetes persistent volumes: https://kubernetes.io/docs/concepts/storage/persistent-volumes/
