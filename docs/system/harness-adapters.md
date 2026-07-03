# Harness Adapters

**Current (Implemented)**

Harness-specific logic is split into per-harness modules in two places: the proxy CLI
(`eve-agent-cli`, which spawns the harness binary and normalizes output) and the shared adapter
registry (which builds invocation options for the runtimes). Adapters are resolved through static
registries (no dynamic loading). There are no per-service adapter directories — agent-runtime and
the worker both consume the shared modules.

## Module layout

- Proxy CLI adapters: `packages/eve-agent-cli/src/harnesses/`
  - `claude-direct.ts` (claude), `mclaude.ts`, `zai.ts`, `gemini.ts`, `code.ts`, `codex.ts`, `pi.ts`
  - `claude.ts` is not an adapter — it exports `buildClaudeCommand` shared by the claude-family
    adapters (mclaude/zai); `codex` similarly reuses `buildCodeCommand` from `code.ts`
  - Registry: `packages/eve-agent-cli/src/harnesses/index.ts`
- Shared adapters + registry: `packages/shared/src/harnesses/`
  - Adapters: `adapters/{claude,mclaude,zai,gemini,code,codex,pi}.ts`
  - Registry: `registry.ts` (canonical names + aliases), selection: `select.ts`,
    profiles: `profile-resolver.ts`, env: `env-builder.ts`, auth: `auth.ts` +
    `packages/shared/src/invoke/{claude-auth,codex-auth}.ts`

## Harness naming

| Harness | Binary | Aliases | Notes |
|---------|--------|---------|-------|
| `claude` | `claude` | - | Claude Code CLI (direct) |
| `mclaude` | `mclaude` | - | cc-mirror Claude variant |
| `zai` | `zai` | - | cc-mirror Z.ai variant |
| `gemini` | `gemini` | - | Google Gemini CLI |
| `code` | `code` | `coder` | Every Code CLI. Use the `coder` alias on host to avoid clashes with VS Code's `code` binary |
| `codex` | `codex` | - | OpenAI Codex CLI |
| `pi` | `pi` | - | Pi CLI (integration Phase 2 pending — see `docs/plans/pi-harness-integration-plan.md`) |

## Add a new harness

1. **Proxy CLI adapter**
   - Create `packages/eve-agent-cli/src/harnesses/<harness>.ts`.
   - Export a `CliHarnessAdapter` with `buildCommand()` that maps to the harness CLI args + env.
   - Register it in `packages/eve-agent-cli/src/harnesses/index.ts`.

2. **Shared adapter**
   - Create `packages/shared/src/harnesses/adapters/<harness>.ts` and register it in
     `packages/shared/src/harnesses/registry.ts`.

3. **Types**
   - Add the harness name to the union type in:
     - `packages/shared/src/types/harness.ts`
     - `packages/shared/src/schemas/job.ts`
     - `packages/shared/src/config/schema.ts` (default harness enum)

4. **Tests**
   - Add a stub binary under `tests/fixtures/bin/<harness>` if it is exercised in integration tests.
   - Add the harness to `apps/api/test/integration/harness-matrix.integration.test.ts`.

## Add the harness binary to the runtime images

If the harness CLI is not provided by the base image, add it explicitly:

- **Dockerfiles**: `apps/agent-runtime/Dockerfile` (primary — all agent jobs) and
  `apps/worker/Dockerfile`
  - Install globally in the build or production stage (e.g., `npm install -g <cli>`).
  - Ensure PATH includes the install location (e.g., `/root/.local/bin`).

- **Entrypoint**: `docker/worker/entrypoint.sh`
  - If the CLI needs runtime configuration (tokens, profiles, variants), add it here.
  - Example: `cc-mirror` variants are created in the entrypoint for `mclaude`/`zai`.

**PATH assumptions**
- The runtime images set `PATH=/root/.local/bin:$PATH`.
- `node_modules/.bin` is added to PATH when spawning harnesses.

## Planned (Not Implemented)

- None. The adapter split and registries are the intended end state for now.
