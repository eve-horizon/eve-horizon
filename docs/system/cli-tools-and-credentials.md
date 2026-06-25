# Eve Horizon: CLI Tools and Credentials

> **Status**: Planned
> **Last Updated**: 2026-01-18
> **Purpose**: Define how CLI tool dependencies and credentials are provided to skills across Docker Compose (quick dev) and Kubernetes (default runtime) deployments.
> **Historical**: Predates the configuration model refactor; workflow-specific language is legacy unless marked otherwise.

---

## Overview

Skills may rely on external CLIs (e.g., `gh`, `aws`, `supabase`). This document defines how those tools could be made available inside agent containers and how credentials are supplied safely in **local single‑host** vs **multi‑tenant Kubernetes** environments.

## Current (Implemented)

- No first-class tool requirements are declared by skills today.
- Tooling availability is controlled by the worker image or the local host environment.
- Credential access is ad-hoc for local development, with `.env` for config, `system-secrets.env.local` for OAuth tokens, and API-scoped secrets for jobs.

## Planned (Not Implemented)

- Standard tool delivery strategies (base image profiles, dynamic install, init containers).
- Explicit credential handling patterns for local and multi-tenant deployments.
- A formal declaration of tool/credential requirements (if workflows return in the future).

## Legacy (Removed)

- Workflow-based tool requirements embedded in SkillPacks.

---

## Planned: Tool Delivery Strategies

### A) Base Image Profiles (MVP Default)

Provide a few curated base images with preinstalled tool bundles:

```
eve-horizon/agent-base:minimal   # git, curl, jq
eve-horizon/agent-base:web       # + gh, node, npm, pnpm
eve-horizon/agent-base:full      # + aws, gcloud, supabase, terraform, kubectl
```

**Pros**: fast startup, deterministic, no runtime network.  
**Cons**: larger images, tool version drift across profiles.

### B) Dynamic Install (Post‑MVP)

Install required tools at container start based on skill or job requirements.

**Pros**: flexible, smaller base images.  
**Cons**: slower cold start, network dependency, less deterministic.

### C) Init Containers (K8s‑Only, Later)

Use init containers to populate a shared `/tools` volume.

**Pros**: clean separation, cacheable in K8s.  
**Cons**: Kubernetes‑only, added orchestration complexity.

---

## Legacy: Workflow Tool Requirements

Workflows declared required tools and credentials so the scheduler could select the right image and mounts. This pattern is not used in the current system.

```yaml
---
id: pr-execution
tools_required:
  - gh
  - npm
  - git
credentials_required:
  - github
  - npm_registry
container_profile: web
---
```

---

## Planned: Local Docker Compose (Single Host)

### Credential Access Pattern

Mount host credential directories **read‑only** into the agent container.

```
~/.ssh
~/.gitconfig
~/.config/gh
~/.aws
~/.config/supabase
~/.npmrc
```

**Security**: mounts are opt‑in per job, read‑only, and scoped to a local trusted developer environment.

### Host Mount Example (Conceptual)

```
volumes:
  - ${HOME}/.gitconfig:/root/.gitconfig:ro
  - ${HOME}/.ssh:/root/.ssh:ro
  - ${HOME}/.config/gh:/root/.config/gh:ro
  - ${HOME}/.aws:/root/.aws:ro
  - ${HOME}/.config/supabase:/root/.config/supabase:ro
  - ${HOME}/.npmrc:/root/.npmrc:ro
```

---

## Planned: Kubernetes (Multi‑Tenant Cloud)

### Credential Access Pattern

No host mounts. Use **K8s secrets**, **OAuth**, and **cloud service identities**.

**GitHub**
- Preferred: GitHub App → short‑lived installation tokens.
- Optional: user OAuth → encrypted token storage → per‑task secret injection.

**AWS**
- Preferred: IRSA / Workload Identity (no static keys).

**Supabase**
- Use project‑scoped service role keys stored as secrets.

### Kubernetes Secret Examples (Conceptual)

**GitHub App credentials**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: github-app-project-123
  namespace: eve-horizon-tasks
type: Opaque
data:
  app-id: <base64>
  private-key: <base64>
```

**Supabase project credentials**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: supabase-project-123
  namespace: eve-horizon-tasks
type: Opaque
data:
  url: <base64>
  service-role-key: <base64>
```

**OAuth user token (encrypted)**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: oauth-user-456
  namespace: eve-horizon-tasks
type: Opaque
data:
  access-token: <base64>
  refresh-token: <base64>
  expires-at: <base64>
```

### OAuth Flow (Conceptual)

```
User → Eve Web App → OAuth Provider → Encrypted Token Store → K8s Secret → Agent
```

### OAuth Callback Endpoints (Conceptual)

```
GET  /auth/{provider}/start
GET  /auth/{provider}/callback
POST /auth/{provider}/refresh
```

---

## Planned: Security Model

- Local host mounts are **developer‑only** and opt‑in per job.
- Cloud credentials are scoped per **org/project/SkillPack**.
- Secrets are injected per task with short‑lived tokens where possible.
- Audit events logged for credential access.

---

## Planned: Decision Matrix

| Choice | Speed | Security | Flexibility | Determinism |
|--------|-------|----------|-------------|-------------|
| Base images | High | Medium | Medium | High |
| Dynamic install | Low | Medium | High | Low |
| Init containers | Medium | High | Medium | Medium |

---

## Planned: Recommended Defaults

**MVP**:
- Base image profiles (`minimal`, `web`, `full`)
- Host credential mounts (read‑only) for local docker‑compose
- K8s secrets + OAuth for cloud

**Later**:
- Dynamic installs for rare tools
- Init‑container tool caches for K8s scale

---

## Open Questions

1. Which CLIs are baseline vs opt‑in? (gh/aws/supabase vs gcloud/terraform)
2. Should tool versions be pinned in skill pack specs?
3. How do we handle OAuth refresh during long‑running tasks?

---

## Eve CLI Reference

The `eve` CLI provides commands for interacting with the Eve Horizon API. For complete documentation, see [packages/cli/README.md](../../packages/cli/README.md).

### Job Execution and Monitoring Commands

```bash
# Get job results
eve job result <job-id> [--format text|json|full] [--attempt N]

# Wait for job completion
eve job wait <job-id> [--timeout N] [--quiet] [--json]

# Stream logs in real-time
eve job follow <job-id> [--raw] [--no-result]
```

#### eve job result

Fetch and display completed job results.

**Options:**
- `--format <text|json|full>` - Output format (default: full)
  - `text`: Plain text output only
  - `json`: Full JSON structure
  - `full`: Formatted with metadata
- `--attempt <N>` - Specific attempt number to fetch results from

**Example:**
```bash
eve job result MyProj-123 --format text
eve job result MyProj-123 --attempt 2 --format json
```

#### eve job wait

Block until a job completes, with optional timeout. Useful in scripts and CI/CD pipelines.

**Options:**
- `--timeout <N>` - Timeout in seconds (default: 300, max: 300)
- `--quiet` - Suppress progress output
- `--json` - Output in JSON format

**Exit codes:**
- `0`: Job completed successfully
- `1`: Job failed
- `124`: Timeout reached
- `125`: Job was cancelled

**Example:**
```bash
# Wait for job in a script
eve job wait MyProj-123 --timeout 120 || echo "Job failed or timed out"

# JSON output for parsing
eve job wait MyProj-123 --quiet --json | jq '.status'
```

#### eve job follow

Stream job logs in real-time using Server-Sent Events (SSE). Connects to the job's SSE endpoint and displays logs as they are generated.

**Options:**
- `--raw` - Print raw JSON lines (for parsing/filtering)
- `--no-result` - Don't print the final result when job completes

**Output includes:**
- Timestamps for each log entry
- Tool names and actions
- Formatted, human-readable output (unless `--raw` is used)

**Example:**
```bash
# Follow logs with formatted output
eve job follow MyProj-123

# Follow with raw JSON for parsing
eve job follow MyProj-123 --raw | jq '.tool'

# Follow logs only, skip final result
eve job follow MyProj-123 --no-result
```
