# CLI Repo-Local Profiles Refactor

## Summary
Global CLI profiles in `~/.eve/config.json` cause cross-project interference: agents in different repos
change the active profile and break each other. This plan removes global profiles entirely and makes
all profile defaults repo-local, while keeping authentication global (SSH keys + token cache).

Supersedes `docs/plans/cli-local-profile-state-plan.md`.

## Goals
- Eliminate global profile state (`~/.eve/config.json`) and any runtime dependence on it.
- Store all CLI defaults (API URL, org, project, harness, auth defaults) in repo-local profiles.
- Preserve the ergonomics of `eve profile` subcommands and `--profile` / `EVE_PROFILE` selection.
- Keep auth global: tokens live in `~/.eve/credentials.json` and are reused across repos.
- Provide a safe migration path for legacy profile files and credentials.

## Non-Goals
- Changing job harness profile semantics (`--profile` on `eve job` still maps to harness profile).
- Changing auth endpoints or credential formats on the server.
- Reworking agent policy / harness configuration.

## Current State (Deep Dive)
- **Global config**: `packages/cli/src/lib/config.ts` reads `~/.eve/config.json` with
  `active_profile` + `profiles` map.
- **Local overrides**: `.eve/profile.yaml` can reference a profile name and override org/project.
- **Resolution order**: flags > env > `.eve/profile.yaml` > global active profile.
- **Credentials**: `~/.eve/credentials.json` is keyed by profile name.
- **Profile CLI**: `eve profile` supports both local and global writes via `--global`.

## Proposed Design
### Repo-Local Profile Store
Profiles live in `.eve/profile.yaml` inside the repo and hold **all defaults**:

```yaml
active_profile: local
profiles:
  local:
    api_url: http://localhost:4801
    org_id: org_xxx
    project_id: proj_xxx
    default_harness: mclaude
    default_email: you@example.com
    default_ssh_key: ~/.ssh/id_ed25519
  staging:
    api_url: https://api.eve.example.com
    org_id: org_xxx
    project_id: proj_yyy
```

### Resolution Order
1. CLI flags (`--api-url`, `--org`, `--project`)
2. Environment variables (`EVE_API_URL`, `EVE_ORG_ID`, `EVE_PROJECT_ID`, `EVE_PROFILE`)
3. Repo-local profile (`.eve/profile.yaml` active profile)
4. Default API URL (`http://api.eve.lvh.me`)

### Auth Storage (Global)
- Tokens remain in `~/.eve/credentials.json` (global) and are keyed by **normalized API URL**.
- Legacy profile-keyed tokens are still read as a fallback.
- Tokens are written back under the API URL key on login/refresh.

### CLI UX
- `eve profile list|show|create|set|use|remove` operate **only** on repo-local profiles.
- `--global` is removed.
- `--profile` / `EVE_PROFILE` selects a **repo-local** named profile.

## Migration & Compatibility
- Legacy `.eve/profile.yaml` (single-profile shape) is normalized into the new format at load time.
- If a repo only has `profile: <name>` (from global references), users must populate local defaults
  with `eve profile set <name> --api-url ...`.
- Legacy credentials are still read (by profile name) if no API URL token exists yet.

## Implementation Plan
1. **Local profile store**
   - Add `.eve/profile.yaml` schema (active_profile + profiles map).
   - Normalize legacy single-profile files on read.
2. **Context resolution**
   - Remove `~/.eve/config.json` reads.
   - Resolve profile purely from repo-local store + flags/env.
3. **Auth token scoping**
   - Key credentials by normalized API URL.
   - Keep legacy profile-keyed tokens as fallback.
4. **CLI commands**
   - Update `eve profile` to operate locally only (remove `--global`).
5. **Docs & help**
   - Update CLI help + README to explain repo-local profiles and global auth.
6. **Tests**
   - Adjust/extend CLI tests for profile resolution and token lookup.

## Open Questions
- Should we add `.eve/profile.local.yaml` (gitignored) for per-user overrides?
- Do we want a one-time `eve profile import-global` helper for migration?
- Should we introduce `--cli-profile` to avoid ambiguity with `eve job --profile`?
