# Agent Runtime (Current)

> Status: Current
> Last Updated: 2026-10-13
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

## Runner pod isolation

Runner pods (`EVE_AGENT_RUNTIME_EXECUTION_MODE=runner`) share the worker's
runner settings: no service account token (`automountServiceAccountToken:
false`), all capabilities dropped, the service account named by
`EVE_RUNNER_SERVICE_ACCOUNT` (namespace default when unset), and placement
from `EVE_RUNNER_NODE_SELECTOR_KEY`/`_VALUE` and
`EVE_RUNNER_TAINT_KEY`/`_VALUE`/`_EFFECT`, plus optional pod affinity
(`EVE_RUNNER_POD_AFFINITY_KEY`/`_VALUE`) to the node of a labelled pod. Set the
placement to the pool the agent runtime itself runs on. `EVE_SECRETS_MASTER_KEY` is not forwarded to
runner pods; only the API decrypts secrets. See
[pipelines.md](./pipelines.md#where-script-steps-run-and-what-they-can-reach)
for the full variable list.

## Cancellation and workspace cleanup

Agent and worker executors check cancellation before starting, poll job phase
independently of harness output every two seconds, and check again before
publishing results. Cancellation sends SIGTERM to the POSIX execution process
group and escalates to SIGKILL after five seconds, including descendants that
outlive their parent or start a separate process group. Descendant process
identities are retained through the grace period to avoid trusting recycled PIDs.
A harness that exits zero while handling cancellation still
returns `job_cancelled` with exit code 130. These timings assume job-state reads
remain available; they are not a bound on a stalled database or cleanup request.

Dedicated runners use the same cancellation signal during pod startup, HTTP
submission, and completion polling. Cancellation requests pod deletion with a
five-second termination grace period and deletes the attempt PVC. Cancelled
attempts preserve refreshed Codex credentials but skip git publication and release
hooks. Late completion cannot overwrite a concurrent terminal phase transition.

Inline executors clean their own attempt workspace after finalization, honoring
`EVE_CLEANUP_WORKSPACE_ON_SUCCESS` and `EVE_CLEANUP_WORKSPACE_ON_FAILURE`.
Orchestrator cleanup alone cannot remove files on another pod's filesystem.
Session workspaces, the configured root itself, paths outside that root, and
symlink aliases are preserved. Operators must still size local storage for peak
active attempts and shared toolchain caches.

## Process isolation

Inline harnesses run as the runtime's UID. The image starts the runtime with
`/usr/local/libexec/eve-node --disable-sigusr1 dist/main.js`: an execute-only
copy of node, so the kernel marks it non-dumpable and harnesses cannot read its
environment (`DATABASE_URL`, `EVE_INTERNAL_API_KEY`) from `/proc/1/environ` or
its memory, and no SIGUSR1 inspector. Helpers it runs (git, crane, kubectl)
get an allowlisted environment without credentials. The boot log says
`AGENT-RUNTIME: process is non-dumpable with SIGUSR1 disabled`; a warning means
the pod is not protected (for example a `command:` override that runs plain
`node`). Set
`EVE_REQUIRE_ENVIRON_PROTECTION=true` to refuse to start in that case. See
[agent-secret-isolation.md](./agent-secret-isolation.md#layer-1b-the-runtimes-own-environment).

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
