# nostrworld.com: Agentic PaaS for Sovereign Agents

> Status: Idea (Vision)
> Last Updated: 2026-02-09
>
> Related:
> - `docs/ideas/nostr-integration.md` (Nostr, DVMs, wallets, relays)
> - `docs/system/deployment.md` (Eve on Kubernetes)
> - `docs/system/events.md` (event spine)
> - `docs/system/job-cli.md` (jobs as execution unit)
> - `docs/system/manifest.md` (services/envs/pipelines)
> - `docs/system/chat-gateway.md` (gateway pattern for external protocols)

## Thesis

Build `nostrworld.com`: a managed, multi-tenant Eve Horizon deployment on a "real" Kubernetes cluster (GKE as the reference) that exposes an agent-native PaaS.

Nostrworld is not "a web app for humans".

Nostrworld is:
- A cloud expansion slot for agents running anywhere (OpenClaw, local, other clouds).
- A Nostr-native control plane (identity and command transport are signed Nostr events).
- A Bitcoin-native billing plane (agents pay, autonomously, from self-custodied wallets).
- A Kubernetes-backed execution plane (jobs, pipelines, and persistent services with isolation).

Put bluntly: "AWS for agents" but with keys and payments that agents can actually hold and move.

## What Makes This Different

Traditional PaaS assumes:
- Human accounts and API keys.
- Credit cards and monthly invoices.
- Interactive UIs.
- Vendor-locked identity.

Nostrworld assumes:
- Every customer is a keypair.
- Every request can be signed.
- Every resource can be metered and paid for in sats.
- Every agent can roam between providers without losing identity or wallet.

Eve already has the right core primitives (jobs, pipelines, environments, runner pods, event spine). Nostrworld is packaging plus a thin protocol and billing layer that makes those primitives consumable by autonomous agents.

## Product Surface (Agent-First)

Nostrworld exposes three "control interfaces" to the same Eve API:
- Nostr control plane: signed events in/out via relays (agent-native).
- HTTP control plane: REST calls authenticated by NIP-98 signatures (tooling-native).
- Optional CLI: standard `eve` CLI pointed at `EVE_API_URL` (developer-friendly).

The agent does not need a browser. A browser is optional for observability.

## The Core Primitives Nostrworld Sells

Everything below maps to an Eve primitive or a small extension of one.

### 1) Jobs (Ephemeral Compute)

Single-shot execution in isolated runner pods.
- Inputs: prompt, repo ref, manifest, env, secrets references.
- Output: logs (stream), artifacts (optional), result JSON.
- Billing: CPU+memory-time for runner pods, plus storage for workspace and artifacts.

This is the "DVM compute layer" when bridged to NIP-90.

### 2) Pipelines (Deterministic Job Graphs)

Repeatable multi-step execution defined in `.eve/manifest.yaml`.
- Inputs: ref sha, env, parameters.
- Output: step outputs, releases, deployments.
- Billing: sum of job billing; optional premium for "priority scheduling".

### 3) Environments (Persistent Namespaces)

Long-lived namespaces with ingress, quotas, and resource accounting.
- Services deployed from `.eve/manifest.yaml` (Compose-style `services` + `x-eve`).
- Billing: reserved CPU/memory (requests) and provisioned storage (PVC GB-hours).

### 4) Managed Data (Optional, But Crucial)

For agents, "database space" must be first-class and metered.

Nostrworld should offer at least one managed option:
- Postgres database per org or per env (backed by Cloud SQL or in-cluster operator).
- Optional: object storage bucket (GCS) for artifacts.

Billing is explicit:
- DB: allocated storage GB-month and instance tier (or compute units).
- Object storage: GB-month and egress.

### 5) Agent Runtime (Warm, Persistent Execution)

Eve already has an agent runtime concept (warm pods + heartbeats). Nostrworld turns it into a product:
- A persistent agent "presence" that can receive Nostr events and launch jobs.
- A place to host "control agents" that supervise environments and budgets.

Billing: reserved CPU/memory for warm pods plus execution for jobs they spawn.

## System Architecture (How It Fits Into Eve)

Eve today:
```
Client -> API -> Orchestrator -> Worker -> Runner Pods
```

Nostrworld adds:
- A Nostr Gateway (parallel to Slack gateway) as an event source and outbound sink.
- A Billing/Metering service that reads usage and enforces budgets.
- A Lightning/Cashu connector to receive payments and settle balances.

Proposed high-level:
```
External Agent (OpenClaw, local, etc)
  -> Nostr relays (control messages) or HTTP (NIP-98)
    -> Nostrworld Gateway
      -> Eve API (source of truth)
        -> Postgres (event spine + billing ledger)
        -> Orchestrator (claims events/jobs)
          -> Worker (expands pipelines, deploys envs, runs jobs)
            -> GKE (runner pods + per-env namespaces)
```

The key design choice: Nostrworld does not bypass the Eve API.

Nostr is an input/output transport and identity layer. Eve remains the control plane for execution.

## Identity: "Account = Nostr Pubkey"

Nostrworld should treat a Nostr pubkey as the primary identifier:
- First contact: "create account" can be implicit on first paid action.
- Auth: every request is signed, either as a Nostr event or via NIP-98 for HTTP.
- Membership: orgs can optionally add multiple pubkeys (agent teams) later.

This maps cleanly to Eve's existing model:
- `external_identities`: add a `nostr` provider.
- `org_memberships`: grant roles to pubkeys.
- `agents`: can be bound to pubkeys for "who spoke" attribution.

## Keys: Nostrworld Must Not Own Them

"Control of their own nostr keys" means:
- Nostrworld never requires an agent to upload its private key (nsec).
- Nostrworld verifies signatures and issues scoped, revocable capabilities.
- For workloads that must publish to Nostr, prefer NIP-46 remote signing.

Minimal policy:
- Inbound: verify signatures always.
- Outbound: either sign with a platform key (for system replies) or request a signature from the agent's remote signer when acting "as the agent".

## Wallets: Billing Without Custody

"Control of their own bitcoin wallets" means:
- Nostrworld never needs to hold user funds.
- Agents bring a wallet and pay invoices directly.

The simplest workable model:
- Prepay balance: org maintains a sats balance by paying Lightning invoices.
- Meter usage continuously and decrement the balance.
- Enforce budgets: stop/scale down workloads when balance is exhausted.

Payment connectors:
- NIP-47 (Wallet Connect): agent can pay automatically.
- LN invoices and/or Lightning Address for funding.
- Optional Cashu (NIP-60/61) for high-frequency micropayments.

This is compatible with `docs/ideas/nostr-integration.md` but the product emphasis is different:
Nostrworld is selling resources (compute, storage), not only "answers".

### Paywall: L402 for Resource-Creating Operations

Nostrworld should treat "create a billable thing" as a paywalled operation:
- Create job, claim job, run pipeline, deploy env, provision DB, increase quota.

L402 gives a clean flow:
1. Agent requests operation (Nostr event or HTTP call).
1. Nostrworld replies with a `402 Payment Required` (HTTP) or a Nostr response containing an invoice.
1. Agent pays using its own wallet (ideally NIP-47 automation).
1. Agent retries with proof-of-payment; server issues a scoped capability for that operation.

Key property: payment becomes a protocol step, not a billing department.

## Metering: What We Measure and How We Charge

Metering must be:
- Deterministic enough to trust.
- Cheap enough to run continuously.
- Hard to game.

### Bill by Requested Resources, Not "Actual CPU"

Kubernetes makes "actual CPU" noisy and adversarial. For a PaaS, billing by resource requests is simpler and fair:
- Persistent services: bill by requested CPU/memory over time (reserved capacity).
- Jobs: bill by requested CPU/memory multiplied by runtime.
- Storage: bill by provisioned PVC size over time.

This also aligns with quota enforcement, because quotas are defined in terms of requests/limits.

### First-Class Usage Records

Nostrworld should write usage as a ledger, not as "best effort metrics":
- `usage_events`: timestamped records for chargeable events.
- `balances`: current balance derived from payments minus charges.
- `limits`: per-org budgets and hard caps.

Usage sources:
- Job attempts: `started_at`, `finished_at`, runner resource class.
- Deployments: declared resource requests in the manifest and actual pod lifetimes.
- PVCs: requested sizes and existence duration.
- Managed DB: provisioned tier and disk (or compute units) by time slice.

### Resource Classes (Compute SKUs)

To keep pricing and scheduling simple for agents, introduce explicit resource classes.

Example (illustrative, not final):

| Class | Target | Requests | Billing Unit |
|---|---|---|---|
| `job.c1` | job runner | 1 vCPU, 2Gi | sats per minute |
| `job.c2` | job runner | 2 vCPU, 4Gi | sats per minute |
| `job.m1` | job runner | 2 vCPU, 8Gi | sats per minute |
| `svc.s1` | service | 250m CPU, 512Mi | sats per hour |
| `svc.s2` | service | 500m CPU, 1Gi | sats per hour |
| `svc.m1` | service | 1 vCPU, 2Gi | sats per hour |
| `disk.std` | PVC | N/A | sats per GB-hour |
| `db.p1` | managed Postgres | small tier + storage | sats per hour + GB-month |

This does three things:
- Gives agents a stable vocabulary to reason about cost.
- Makes scheduling easier (maps to node pools and quotas).
- Prevents "manifest games" where a tenant requests extreme resources accidentally.

### Enforcement: Budgets as a Scheduler Constraint

Budget enforcement should happen in two places:
- Admission: reject new deployments/jobs if the org is in deficit or above hard caps.
- Runtime: if an org goes negative, pause new jobs and begin graceful environment suspension.

"Graceful suspension" is a product feature:
- Stop runners immediately.
- Scale deployments to 0 or block ingress, depending on SLA tier.
- Preserve data (PVC/DB) for a retention window.

## Nostr Control Plane: Protocol Shape

Nostrworld needs a small, strict request/response protocol so agents can automate against it reliably.

Model:
- Requests are signed Nostr events (and optionally encrypted DMs).
- Responses are signed Nostr events correlated to the request via tags.
- Every request is idempotent (event id is the dedupe key).

Suggested request categories:
- `nostrworld.account.*` (funding, limits, capabilities)
- `nostrworld.project.*` (link repo, sync manifest, set defaults)
- `nostrworld.env.*` (create, deploy, scale, destroy)
- `nostrworld.job.*` (create, follow, result, cancel)
- `nostrworld.pipeline.*` (run, logs, approve)

The Gateway translates these into Eve API calls and stores a canonical record in the event spine (`source=nostr`).

This mirrors the existing Slack gateway pattern described in `docs/system/chat-gateway.md`.

### Concrete Example: Create a Job Over Nostr

Request (signed by the agent's pubkey):

```json
{
  "kind": 5000,
  "tags": [
    ["p", "<nostrworld-pubkey>"],
    ["t", "nostrworld"],
    ["t", "job.create"],
    ["x", "resource_class", "job.c2"]
  ],
  "content": "{\"op\":\"nostrworld.job.create\",\"params\":{\"project\":{\"repo_url\":\"https://github.com/acme/repo\",\"ref\":\"0123456789abcdef0123456789abcdef01234567\"},\"job\":{\"description\":\"Run integration tests\",\"execution_mode\":\"ephemeral\"},\"budget\":{\"max_sats\":2500}}}"
}
```

Response (signed by nostrworld, correlated to the request id):

```json
{
  "kind": 6000,
  "tags": [
    ["e", "<request-event-id>"],
    ["p", "<requester-pubkey>"],
    ["t", "nostrworld"],
    ["t", "job.created"]
  ],
  "content": "{\"ok\":true,\"job_id\":\"job_01k...\",\"invoice\":\"lnbc...\",\"estimated_cost_sats\":1800}"
}
```

Notes:
- If the org has sufficient prepaid balance, `invoice` can be omitted.
- If an invoice is required, the agent pays and then either replays the request with a payment proof or publishes a `nostrworld.payment.proof` event correlated to the request.

## The "Cloud Expansion" Flow (OpenClaw -> Nostrworld)

This is the killer story: an agent running on a random machine can burst into GKE without creating accounts or managing cloud creds.

Example intent:
1. Local agent decides "this needs more compute or a persistent service".
1. It sends a signed Nostrworld request: "run pipeline X at ref sha Y" or "deploy env Z".
1. Nostrworld replies with a job id and a streaming endpoint (or streams logs back over Nostr).
1. The agent pays a Lightning invoice (automated via NIP-47) if required.
1. Result arrives as a signed response event, plus a durable URL for deployed services if applicable.

In other words: Nostrworld becomes a "cloud adapter" that any agent can learn once and reuse everywhere.

## GKE Reference Architecture

GKE is a good reference because it forces us to solve production realities.

### GKE Overlay Checklist (Standing Up A World)

This should be a first-class `k8s/overlays/gcp` modeled after `k8s/overlays/aws`:
- Provision: GKE cluster with node pools (`system`, `runner`, `apps`) and autoscaling.
- Provision: Cloud SQL Postgres for the Eve control plane.
- Configure: `DATABASE_URL` in the overlay to point to Cloud SQL.
- Configure: `EVE_DEFAULT_DOMAIN=apps.nostrworld.com` for app ingress.
- Configure: API ingress host `api.nostrworld.com` (and `relay.nostrworld.com` if co-hosted).
- Configure: TLS issuance (cert-manager DNS01 or Google-managed certs).
- Configure: registry pull secret (GHCR or your registry).
- Configure: `eve-app` secret (internal API key, secrets master key, integration secrets).
- Deploy: `kubectl apply -k k8s/overlays/gcp` and run smoke checks (`/health`).
- Observe: ship logs/metrics (OTEL collector -> Cloud Monitoring).

The goal is boring, repeatable production deployment, not bespoke kube artisanalism.

Cluster layout:
- Node pool: `system` (API, orchestrator, worker, gateway, relay).
- Node pool: `runner` (ephemeral job pods), autoscaled.
- Node pool: `apps` (user workloads), autoscaled.
- Optional pools: `gpu`, `highmem`.

Data plane:
- Control-plane Postgres: Cloud SQL (recommended) or HA in-cluster operator.
- Object storage: GCS bucket for artifacts (optional early).
- PVCs: GCE PD for persistent volumes.

Ingress:
- `api.nostrworld.com` for Eve API (and possibly the gateway).
- `*.apps.nostrworld.com` for deployed services.
- TLS via cert-manager + DNS01, or Google-managed certs.

Isolation:
- Namespace per Eve environment (`eve-{orgSlug}-{projectSlug}-{envName}`) already matches the model.
- Apply `ResourceQuota` and `LimitRange` per namespace for enforceable caps.
- Network policies to prevent cross-tenant traffic.

Observability:
- OTEL collector + Cloud Logging/Monitoring.
- Expose per-org usage dashboards (optional UI) derived from the billing ledger.

## "Worlds" and Federation

Nostrworld should assume there will be many "worlds":
- Different operators.
- Different price curves.
- Different compliance regimes.
- Different regions.

Nostr becomes the discovery and negotiation layer:
- Worlds advertise pricing and capabilities as signed events.
- Agents choose where to run based on latency, reputation, and cost.
- An agent can move without losing identity because identity is a keypair, not an account.

Long-term: an agent can split workloads across worlds (multi-cloud for agents) and reconcile cost/quality the same way it reconciles DVM provider quality.

## Roadmap (Pragmatic Phases)

Phase 0: "Eve on GKE"
- Stand up a production-grade overlay (GKE) modeled after `k8s/overlays/aws`.
- External Postgres (Cloud SQL) + real ingress + real DNS.
- Runner node pool autoscaling.

Phase 1: "Nostr auth + gateway"
- Add `nostr` provider in `external_identities`.
- NIP-98 for HTTP auth.
- Gateway plugin: Nostr events in/out -> Eve events/jobs.

Phase 2: "Metered jobs"
- Usage ledger for job attempts.
- Balance model + invoice funding.
- Budget enforcement for new job creation.

Phase 3: "Metered environments"
- Resource requests required for persistent services.
- Quotas and enforcement per env namespace.
- Bill reserved capacity for deployments and PVCs.

Phase 4: "Managed data"
- Offer a managed Postgres SKU and bill it.
- Add artifact bucket support and bill storage/egress.

Phase 5: "Marketplace and federation"
- Worlds advertise prices and capabilities.
- Optional DVM bridge for jobs/pipelines so any Nostr agent can buy compute.

## Open Questions (That Actually Matter)

- Billing units: do we price in "millicore-seconds" and "GiB-seconds", or simplify to a few resource classes?
- Suspension semantics: scale to 0, block ingress, or hard-delete workloads when balance is exhausted?
- Secrets: how do we keep user secrets "sovereign" while still enabling automation (NIP-46 signer, NIP-47 wallet)?
- Abuse/spam: what is the minimum friction we require (deposit, PoW, reputation threshold)?
- Multi-pubkey orgs: what is the cleanest UX for "agent teams" that share a budget?

## The North Star

If we get this right:
- Agents can deploy services, run jobs, and provision data without cloud accounts.
- Identity is portable (Nostr keys).
- Payment is native (Bitcoin).
- The control plane is open (Nostr events), but execution is reliable (Kubernetes + Eve).

That is a platform an agent can actually build on.
