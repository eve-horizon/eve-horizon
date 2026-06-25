# Agent Runtime (Current)

> Status: Current
> Last Updated: 2026-06-03
> Purpose: Describe the org-scoped agent runtime service and warm pods.

## Overview

Agent Runtime provides **warm, org-scoped execution** for chat-triggered jobs to reduce cold starts. It complements the worker/runner model used for standard job execution.

## Key Concepts

- **Warm pods**: Pre-provisioned runtime pods ready to execute routed agent jobs.
- **Org scope**: Runtime placements are keyed by org; routing is sticky within org.
- **Heartbeat**: Agent runtime pods report health and capacity for placement.
- **Local multi-org mode**: In the local k3d overlay, runtime pods track orgs dynamically from invocations instead of a single pinned org ID.
- **Inline hot path**: Agent runtime executes directly in warm pods by default (`EVE_AGENT_RUNTIME_EXECUTION_MODE=inline`), with runner-pod mode available as an explicit fallback.

## Declared Toolchains

Agent workflow steps can declare `toolchains: [python]` and the orchestrator
forwards the resolved list to the agent runtime as `invocation.toolchains`.

Inline execution is the default path. Before `execution_started_at` is marked,
agent-runtime provisions each requested toolchain with the shared
`ensureToolchains` cache used by worker script/action-run jobs. The harness env
then receives:

- toolchain `bin` directories prepended to `PATH`
- env vars exported by each toolchain `env.sh`
- user/manifest `env_overrides` applied after toolchain env so overrides win

Provisioning uses the `EVE_TOOLCHAIN_*` contract:

- `EVE_TOOLCHAIN_ROOT` (default `/opt/eve/toolchains`)
- `EVE_TOOLCHAIN_IMAGE_PREFIX` (default `eve-horizon/toolchain-`)
- `EVE_TOOLCHAIN_IMAGE_TAG` (default `local`)
- `EVE_TOOLCHAIN_REGISTRY_INSECURE=true` for local in-cluster registry reads

If a toolchain cannot be provisioned, the attempt fails before harness spawn
with `result_json.error_code = "toolchain_unavailable"` and status log lines
name the toolchain/image. Agent-runtime pods include `crane` and mount a
writable `/opt/eve/toolchains` cache.

Runner-pod mode still uses per-toolchain init containers. Both inline and
runner modes update `runtime_meta.toolchains` with `execution_mode`,
`requested`, `resolved`, `missing`, and `source`.

## Data Model

- `agent_runtime_pods` (heartbeat + capacity)
- `agent_placements` (pod selection)
- `agent_state` (agent status + last heartbeat)

## Diagnostics

Use `eve job diagnose <job-id>` to inspect the latest attempt. It renders
`runtime_meta.toolchains`, classified toolchain errors, pod metadata, and recent
toolchain provisioning logs.

## Related Docs

- [Agents & Teams](./agents.md)
- [Chat Gateway](./chat-gateway.md)
