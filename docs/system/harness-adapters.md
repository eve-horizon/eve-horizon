# Harness Adapters

**Current (Implemented)**

Harness-specific logic is split into per-harness modules for both the proxy CLI and the worker. Adapters are resolved through static registries (no dynamic loading).

## Module layout

- Proxy CLI adapters: `packages/eve-agent-cli/src/harnesses/`
  - `mclaude.ts`, `zai.ts`, `gemini.ts`, `code.ts`, `codex.ts`
  - Registry: `packages/eve-agent-cli/src/harnesses/index.ts`
- Worker adapters: `apps/worker/src/invoke/harnesses/`
  - `mclaude.ts`, `zai.ts`, `gemini.ts`, `code.ts`, `codex.ts`
  - Registry: `apps/worker/src/invoke/harnesses/index.ts`

## Harness naming

| Harness | Binary | Aliases | Notes |
|---------|--------|---------|-------|
| `mclaude` | `mclaude` | - | cc-mirror Claude variant |
| `zai` | `zai` | - | cc-mirror Z.ai variant |
| `gemini` | `gemini` | - | Google Gemini CLI |
| `code` | `code` | `coder` | Every Code CLI. Use the `coder` harness on host to avoid clashes with VS Code's `code` binary |
| `codex` | `codex` | - | OpenAI Codex CLI (official OpenAI tool) |

## Add a new harness

1. **Proxy CLI adapter**
   - Create `packages/eve-agent-cli/src/harnesses/<harness>.ts`.
   - Export a `CliHarnessAdapter` with `buildCommand()` that maps to the harness CLI args + env.
   - Register it in `packages/eve-agent-cli/src/harnesses/index.ts`.

2. **Worker adapter**
   - Create `apps/worker/src/invoke/harnesses/<harness>.ts`.
   - Export a `WorkerHarnessAdapter` with `buildOptions()`.
   - Register it in `apps/worker/src/invoke/harnesses/index.ts`.

3. **Types**
   - Add the harness name to the union type in:
     - `packages/shared/src/types/harness.ts`
     - `packages/shared/src/schemas/job.ts`
     - `packages/shared/src/config/schema.ts` (default harness enum)

4. **Tests**
   - Add a stub binary under `tests/fixtures/bin/<harness>` if it is exercised in integration tests.
   - Add the harness to `apps/api/test/integration/harness-matrix.integration.test.ts`.

## Add the harness binary to the worker image

If the harness CLI is not provided by the base image, add it explicitly:

- **Dockerfile**: `apps/worker/Dockerfile`
  - Install globally in the build or production stage (e.g., `npm install -g <cli>`).
  - Ensure PATH includes the install location (e.g., `/root/.local/bin`).

- **Entrypoint**: `docker/worker/entrypoint.sh`
  - If the CLI needs runtime configuration (tokens, profiles, variants), add it here.
  - Example: `cc-mirror` variants are created in the entrypoint for `mclaude`/`zai`.

**PATH assumptions**
- The worker image sets `PATH=/root/.local/bin:$PATH`.
- The worker adds `node_modules/.bin` to PATH when spawning harnesses.

## Planned (Not Implemented)

- None. The adapter split and registries are the intended end state for now.
