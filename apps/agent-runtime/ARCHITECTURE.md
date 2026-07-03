# Agent Runtime Architecture

> **What**: Executes ALL agent jobs (chat, manual, scheduled) via harnesses.
> **Why**: Agent execution has different scaling, warmth, and security needs than build/deploy work.

## Overview

The orchestrator routes every agent job here when `EVE_AGENT_RUNTIME_URL` is set (true in all shipped
environments). The runtime prepares a workspace, provisions declared toolchains on demand, resolves
harness auth, and invokes the selected harness via `eve-agent-cli`, streaming normalized JSONL events
(including `llm.call` cost events) back to the system of record.

## Components

- `src/invoke/invoke.service.ts` — job acceptance, workspace prep, harness invocation; composes the
  shared agent-execution logic in `packages/shared/src/invoke/` (budget enforcement, carryover
  context, message relay, security policy, result extraction).
- `src/invoke/k8s-runner.ts` — ephemeral runner pods for isolated execution.
- `src/invoke/toolchains.ts` — on-demand toolchain init-container injection.
- `src/runtime/runtime.service.ts` — pod heartbeat/placement registration, drain on shutdown.

## Key Decisions (Why)

- **All agent jobs run here** — the worker is builds/pipelines/scripts only (see the CRITICAL routing
  rule in [CLAUDE.md](../../CLAUDE.md)).
- **Shared invoke module** (`packages/shared/src/invoke/`) is the single source of truth for
  agent-execution behavior; new features land there, not in per-service forks.

## Navigation

- Agent runtime: [docs/system/agent-runtime.md](../../docs/system/agent-runtime.md)
- Harness execution: [docs/system/harness-execution.md](../../docs/system/harness-execution.md)
