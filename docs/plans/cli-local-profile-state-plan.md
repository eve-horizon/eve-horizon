# CLI Local Profile State Plan

## Problem

Two projects on the same host/user need different Eve profiles simultaneously. Current architecture stores state globally in `~/.eve/`, meaning:
- Active profile is shared across all terminals/projects
- Switching profiles affects all concurrent sessions
- Users must manually manage `EVE_PROFILE` env var or `--profile` flag

## Current Architecture

```
~/.eve/
├── config.json          # {active_profile, profiles: {name: ProfileConfig}}
└── credentials.json     # {profile_name: {access_token, refresh_token, ...}}

.eve/ (repo, optional)
├── profile.yaml         # Overrides only (api_url, org_id, project_id)
└── manifest.yaml        # Project manifest
```

**Resolution hierarchy**: CLI flags > `.eve/profile.yaml` > env vars > global profile

## Proposed Solution

### Option A: Profile Name Reference (Recommended)

Enhance `.eve/profile.yaml` to specify which global profile to use:

```yaml
# .eve/profile.yaml
profile: staging  # References ~/.eve/ profile by name

# Optional overrides (applied on top of referenced profile)
org_id: org_xxx
project_id: proj_xxx
```

**How it works:**
1. CLI loads `.eve/profile.yaml` from cwd
2. If `profile:` key exists, use that profile from `~/.eve/config.json`
3. Apply any local overrides on top
4. Credentials stay in `~/.eve/credentials.json` (keyed by profile name)

**Pros:**
- Minimal change to existing architecture
- Credentials managed in one secure location
- Profile name can be committed (not sensitive)
- Overrides allow project-specific tweaks

**Cons:**
- Still requires global profile setup first

### Option B: Full Local State

Store complete profile config locally:

```yaml
# .eve/profile.yaml (committable)
api_url: https://api.eve.example.com
org_id: org_xxx
project_id: proj_xxx
default_harness: mclaude

# .eve/credentials.yaml (gitignored)
access_token: eyJ...
refresh_token: eyJ...
expires_at: 1234567890
```

**Pros:**
- Full isolation per project
- No global setup required
- Can copy credentials between machines

**Cons:**
- Credentials scattered across repos
- More complex credential management
- Risk of accidental credential commits

### Option C: Hybrid (Profile + Local Credentials)

```yaml
# .eve/profile.yaml (committable)
profile: staging           # Optional: inherit from global
api_url: https://...       # Optional: override
org_id: org_xxx

# Credentials resolution:
# 1. .eve/credentials.yaml (gitignored) if exists
# 2. ~/.eve/credentials.json[profile_name] fallback
```

**Pros:**
- Flexible - use global or local credentials
- Supports air-gapped/CI scenarios with local creds
- Backwards compatible

**Cons:**
- More complex resolution logic

## Recommendation: Option A with Progressive Enhancement

Start with Option A (profile reference), then add Option C capabilities if needed.

### Phase 1: Profile Reference

**Changes to `context.ts`:**

```typescript
// Current behavior
const repoProfile = loadRepoProfile(); // .eve/profile.yaml overrides

// New behavior
const repoProfile = loadRepoProfile();
if (repoProfile?.profile) {
  // Use named profile from global config as base
  const baseProfile = config.profiles[repoProfile.profile];
  // Merge: base profile + repo overrides + env vars + flags
}
```

**New `.eve/profile.yaml` schema:**

```yaml
# Profile reference (optional, defaults to active global profile)
profile: staging

# Overrides (all optional)
api_url: https://...
org_id: org_xxx
project_id: proj_xxx
default_harness: mclaude
```

**Gitignore considerations:**
- `profile.yaml` is safe to commit (no secrets)
- Consider `.eve/profile.local.yaml` for user-specific overrides (gitignored)

### Phase 2: Local Credentials (Optional)

If needed later:

```yaml
# .eve/credentials.yaml (gitignored by default via .eve/.gitignore)
access_token: eyJ...
refresh_token: eyJ...
```

CLI checks `.eve/credentials.yaml` first, falls back to `~/.eve/credentials.json`.

## Migration Path

1. Existing users: No change required, current behavior preserved
2. New behavior: Add `profile: name` to `.eve/profile.yaml`
3. Global profiles still work for users who prefer them

## Implementation Tasks

- [ ] Update `loadRepoProfile()` in `context.ts` to handle `profile:` key
- [ ] Update `resolveContext()` to merge base profile + overrides
- [ ] Add `--local` flag to `eve profile use` command
- [ ] Add `--clear` flag to remove local profile
- [ ] Update `eve profile show` to indicate source (global vs local)
- [ ] Add `.eve/profile.local.yaml` support (gitignored overrides) - future
- [ ] Update CLI help and documentation

## CLI UX

### Setting local profile

```bash
# Current behavior (unchanged): set global active profile
eve profile use staging

# New behavior: set profile for current directory
eve profile use staging --local
# Creates/updates .eve/profile.yaml with: profile: staging

# With overrides
eve profile use staging --local --org org_xxx --project proj_xxx
# Creates .eve/profile.yaml:
#   profile: staging
#   org_id: org_xxx
#   project_id: proj_xxx
```

### Switching profiles

```bash
cd ~/dev/project-a

# Check current profile
eve profile show
# Shows: staging (from .eve/profile.yaml)

# Switch to local dev
eve profile use local --local

# Switch back to staging
eve profile use staging --local
```

### Clearing local profile

```bash
# Remove local profile (fall back to global)
eve profile use --local --clear
# Or just delete the file
rm .eve/profile.yaml
```

## Example Workflows

### Two projects, different environments

```bash
# Project A: uses staging
cd ~/dev/project-a
eve profile use staging --local

# Project B: uses production
cd ~/dev/project-b
eve profile use production --local

# Both work simultaneously without interference
eve job list  # Each uses its own profile
```

### CI/CD with env vars

```bash
# .eve/profile.yaml committed with profile: ci
# CI sets EVE_API_URL to override for ephemeral environment
EVE_API_URL=https://pr-123.eve.example.com eve deploy
```

### Local development override

```bash
# .eve/profile.yaml (committed)
profile: staging
org_id: org_team

# .eve/profile.local.yaml (gitignored, user-specific)
project_id: proj_my_fork
```
