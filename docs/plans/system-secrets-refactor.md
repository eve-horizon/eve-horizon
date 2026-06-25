# System-Level Secrets Refactoring Plan

> **Plan (Historical)**: This plan may be partially or fully implemented.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

## Overview

Add a `system` scope to the secrets hierarchy, enabling global defaults for runtime secrets like `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`, and `ANTHROPIC_API_KEY`.

## Current State

**Resolution order**: `host env (EVE_SECRET_*) → user → org → project`
**SecretScopeType**: `'user' | 'org' | 'project'`

## Target State

**Resolution order**: `system → org → user → project`
**SecretScopeType**: `'user' | 'org' | 'project' | 'system'`

System secrets are DB-stored global defaults, loaded from `system-secrets.env.local` on API startup.

## Design Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| scope_id value | `'system'` literal | Simple, clear, no collision risk since it's a reserved scope |
| Bootstrap timing | Auto on API startup | Seamless experience, secrets always available |
| File location | `./system-secrets.env.local` | Follows `.env.local` pattern, gitignored |
| Auth extract | Update `--save` to write new location | Single workflow, no flags proliferation |

## Implementation Phases

### Phase 1: Schema & Types

**Files:**
- `packages/db/src/queries/secrets.ts` - Add `'system'` to `SecretScopeType`
- `packages/shared/src/schemas/secret.ts` - Update shared Zod schemas

**Changes:**
```typescript
export type SecretScopeType = 'user' | 'org' | 'project' | 'system';
```

### Phase 2: API Resolution Logic

**Files:**
- `apps/api/src/secrets/secrets.service.ts` - Update `resolveForProject()`

**Changes:**
- Load system secrets first (where `scope_type = 'system'` and `scope_id = 'system'`)
- Then layer user → org → project on top
- System secrets become the baseline defaults

### Phase 3: System Secrets Bootstrap

**Files:**
- `apps/api/src/secrets/secrets.service.ts` - Add `loadSystemSecrets()` method
- `apps/api/src/app.module.ts` or startup hook - Call on app init

**Behavior:**
1. On API startup, read `./system-secrets.env.local` if it exists
2. Parse as KEY=VALUE pairs
3. Upsert each into secrets table with `scope_type='system'`, `scope_id='system'`
4. Log count of loaded secrets

### Phase 4: CLI Support

**Files:**
- `packages/cli/src/commands/secrets.ts` - Add `--system` flag

**Commands:**
```bash
eve secrets set CLAUDE_CODE_OAUTH_TOKEN <token> --system
eve secrets list --system
eve secrets get CLAUDE_CODE_OAUTH_TOKEN --system
eve secrets delete CLAUDE_CODE_OAUTH_TOKEN --system
```

### Phase 5: Auth Extract Update

**Files:**
- `bin/eh-commands/auth.sh` - Update `--save` to write to `system-secrets.env.local`

**Changes:**
- Change output file from `.env.local` to `system-secrets.env.local`
- Keep same format: `KEY=VALUE` pairs
- Update help text to reflect new location

### Phase 6: Worker Cleanup

**Files:**
- `apps/worker/src/invoke/invoke.service.ts` - Simplify host secrets handling

**Changes:**
- Remove `EVE_SECRET_*` prefix extraction logic (no longer needed)
- Secrets come from API resolution which now includes system scope
- Keep CLAUDE_CODE_OAUTH_TOKEN passthrough for k8s compatibility

### Phase 7: Documentation

**Files:**
- `docs/system/secrets.md` - Update with new hierarchy
- `docs/system/local-dev-setup.md` - Update bootstrap instructions

## File Checklist

- [ ] `packages/db/src/queries/secrets.ts` - Add system scope type
- [ ] `packages/shared/src/schemas/secret.ts` - Update shared types
- [ ] `apps/api/src/secrets/secrets.service.ts` - Resolution + bootstrap
- [ ] `packages/cli/src/commands/secrets.ts` - CLI --system flag
- [ ] `bin/eh-commands/auth.sh` - Update --save target
- [ ] `apps/worker/src/invoke/invoke.service.ts` - Cleanup if needed
- [ ] `docs/system/secrets.md` - Documentation
- [ ] `.gitignore` - Ensure `system-secrets.env.local` is ignored

## Testing

1. Unit tests for `resolveForProject()` with system scope
2. Integration test: system secret < org secret < project secret
3. E2E: `eh auth extract --save` → API sees system secret → worker gets it
4. K8s stack E2E: CLAUDE_CODE_OAUTH_TOKEN flows through correctly
