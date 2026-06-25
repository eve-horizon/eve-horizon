# Plan: `eve local` vs `./bin/eh` — Consolidation Analysis

> **Status**: Proposed
> **Date**: 2026-02-17

## Problem Statement

We have two parallel systems for managing the local k3d stack:

1. **`eve local`** — CLI commands shipped in the `@eve-horizon/cli` npm package (`packages/cli/src/commands/local.ts`)
2. **`./bin/eh k8s`** — Shell scripts in the monorepo (`bin/eh-commands/k8s.sh` + friends)

The question: are they interchangeable? If not, should we bring them in line or retire one?

## Findings

### They Are NOT Interchangeable

The two systems serve **fundamentally different audiences** with different image sourcing strategies, and they are already drifting apart.

### Audience Comparison

| Dimension | `eve local` (CLI) | `./bin/eh` (repo scripts) |
|---|---|---|
| **Target user** | App developers (install CLI via npm) | Platform developers (monorepo checkout) |
| **Image source** | Pulls released images from GHCR | Builds from local source code |
| **Manifests** | Bundled copy in `packages/cli/assets/local-k8s/` | Canonical copy in `k8s/` |
| **Dev modes** | k8s only | k8s + docker compose + hot-reload local |
| **Tool install** | Auto-installs k3d & kubectl to `~/.eve/bin/` | Requires pre-installed tools |
| **Multi-instance** | No | Yes (configurable ports, ownership guards) |
| **Testing** | No | Integration test harness |

### Critical Incompatibilities

#### 1. Image Sourcing (Fundamental)

`eve local up` resolves the latest semver tag across all 6 GHCR repos, pulls those images, re-tags to `:local`, and imports into k3d. A platform developer using this would get **stale released images**, not their code changes.

`./bin/eh k8s deploy` runs `docker build` from the monorepo source and imports those builds into k3d. This is the only way to test local code in k8s.

**Verdict**: A platform dev CANNOT use `eve local up` for development. It would erase their local builds.

#### 2. Manifest Drift (Already Happening)

The CLI bundles a **copy** of the k8s manifests (`packages/cli/assets/local-k8s/`). The repo's canonical manifests live at `k8s/`. These are already drifting:

| Difference | CLI copy | Repo canonical |
|---|---|---|
| `overlays/local/kustomization.yaml` | 4 patches | 5 patches (has `worker-registry.patch.yaml`) |
| `worker-registry.patch.yaml` | Missing | Present (sets `EVE_REGISTRY_HOST` + `EVE_BUILDKIT_INSECURE_REGISTRIES`) |

There is **no automated sync mechanism** between these two copies. Every time we change a k8s manifest, we must remember to update both locations.

#### 3. Registry Mirror Configuration

`./bin/eh k8s deploy` configures the k3d node's containerd registry mirror so that in-cluster image pulls from `eve-registry.eve.svc.cluster.local:5000` resolve to the registry's ClusterIP. This is required for BuildKit-based app deployments.

`eve local up` does not configure the registry mirror at all. Apps deployed via `eve env deploy` after `eve local up` may fail to pull built images.

#### 4. Auth Secrets Sourcing (Non-Issue)

Both tools auto-generate the same infrastructure secrets (JWT, internal API key, master key, bootstrap token) identically. `./bin/eh k8s secrets` also loads optional webhook/gateway config from `system-secrets.env.local`, but platform-level secrets are deprecated in favor of org/project secrets via `eve secrets set`. This is not a real incompatibility.

#### 5. Service Restart Differences

| Service | `eve local up` restarts | `./bin/eh k8s deploy` restarts |
|---|---|---|
| eve-api | Yes | Yes |
| eve-orchestrator | Yes | Yes |
| eve-worker | Yes | Yes |
| eve-gateway | Yes | Yes |
| eve-agent-runtime | Yes | Yes |
| supabase-auth | Yes | Yes |
| mailpit | Yes | Yes |
| eve-sso | Yes | **No** |

The CLI restarts eve-sso; the shell script does not. This is likely a bug in `k8s.sh` (or an intentional omission that's now inconsistent).

### Capabilities Only in `./bin/eh`

These have **no CLI equivalent** and are essential for platform development:

| Capability | Command | Why it matters |
|---|---|---|
| Hot-reload dev | `eh start local` | Fast inner loop without containers |
| Docker compose | `eh start docker` | Quick containerized testing |
| Build from source | `eh k8s-image push` | Test local code changes in k8s |
| Worker variants | `eh worker-image push --variant full` | Test python/rust/java worker images |
| Integration tests | `eh test integration` | Automated test suite |
| Credential extraction | `eh auth extract` | Pull Claude/Codex keys from host keychain |
| Safe kubectl wrapper | `eh kubectl` | Forced k3d context, prevents staging accidents |
| Instance configuration | `eh configure` | Multi-checkout port isolation |
| Database management | `eh db reset --test` | Direct postgres operations |

### Capabilities Only in `eve local`

These are **not in `./bin/eh`**:

| Capability | Command | Why it matters |
|---|---|---|
| Auto-install tools | `eve local up` auto-installs k3d/kubectl | Zero-prereq onboarding for new users |
| Service log streaming | `eve local logs [service]` | Friendly wrapper around kubectl logs |
| Live status watch | `eve local status --watch` | Real-time dashboard |
| JSON output | `eve local status --json` | Machine-readable for automation |
| Version pinning | `eve local up --version 0.1.50` | Run specific platform release |

## Recommendation: Keep Both, Fix the Seams

**Retiring `./bin/eh` is not viable** — it has irreplaceable platform-dev features (source builds, multi-mode, integration tests, credential extraction).

**Retiring `eve local` is not viable** — it's the onboarding experience for app developers who don't have the monorepo.

**The right move**: clearly separate concerns and eliminate the manifest duplication that causes drift.

### Phase 1: Eliminate Manifest Duplication (High Priority)

**Problem**: Two copies of k8s manifests are already drifting.

**Solution**: Make the CLI assets a **build artifact** of the canonical repo manifests.

1. Add a build step to the CLI package that copies `k8s/base/` and `k8s/overlays/local/` into `packages/cli/assets/local-k8s/` (or better: `dist/assets/local-k8s/`).
2. Add the CLI's `assets/local-k8s/` directory to `.gitignore` so it's no longer checked in.
3. The `pnpm build` step for `@eve-horizon/cli` copies the manifests, the `npm publish` includes them in the package.
4. Add a CI check that fails if `assets/local-k8s/` diverges from `k8s/` (transitional, removed once fully automated).

**Scope**: ~2 hours. Eliminates the drift problem permanently.

### Phase 2: Add Registry Mirror to `eve local up` (Medium Priority)

**Problem**: `eve local up` doesn't configure the containerd registry mirror, so BuildKit-built app images can't be pulled.

**Solution**: Port the `configure_registry_mirror()` logic from `k8s.sh` into `local.ts`.

**Scope**: ~1 hour.

### ~~Phase 3: Auto-load system secrets~~ (Removed)

Platform-level secrets (`system-secrets.env.local`) are deprecated in favor of org/project-level secrets via `eve secrets set`. Both tools auto-generate the required infrastructure secrets (JWT, internal API key, master key, bootstrap token) identically. No action needed.

### Phase 4: Document the Boundary (High Priority)

Update CLAUDE.md and README to clearly state:

```
## Local Development: Two Tools, Two Purposes

**For app developers** (using Eve to deploy your app):
  eve local up                    # Start Eve platform locally
  eve local status                # Check health
  eve local logs api              # Debug

**For platform developers** (working on Eve itself):
  ./bin/eh k8s deploy             # Build from source + deploy
  ./bin/eh start local            # Hot-reload development
  ./bin/eh test integration       # Run test suite

These are NOT interchangeable:
- `eve local up` pulls released images — it does NOT build from source
- `./bin/eh k8s deploy` builds from your local code — use this for development
```

**Scope**: ~30 minutes.

### Phase 5: Backport `eve local` Niceties to `./bin/eh` (Low Priority)

Port useful features from `eve local` into the shell scripts:

- `eh k8s logs [service]` — friendly log streaming (currently must use `eh kubectl -n eve logs`)
- `eh k8s status --json` — machine-readable status output
- `eh k8s status --watch` — live dashboard

**Scope**: ~2-3 hours. Nice-to-have, not blocking.

### Phase 6: Consider `eve local up --source` (Future)

Long-term, consider adding a `--source` flag to `eve local up` that builds from the local monorepo instead of pulling from GHCR. This would make `eve local` a true superset of `./bin/eh k8s deploy`. But this is a significant scope increase and is only worth doing once the platform has external contributors who want source builds without learning `./bin/eh`.

## What NOT To Do

- **Don't retire `./bin/eh`** — it's the platform dev workhorse with features `eve local` can't replicate
- **Don't make `eve local` call `./bin/eh`** — `eve local` must work standalone (installed via npm)
- **Don't merge them into one** — they serve different audiences with different needs
- **Don't add multi-instance support to `eve local`** — that's a platform-dev concern

## Summary

| Phase | Priority | Effort | Impact |
|---|---|---|---|
| 0. Stack manager guards | High | 1h | Prevents silent image overwrites — see [local-stack-manager-guards-plan.md](./local-stack-manager-guards-plan.md) |
| 1. Eliminate manifest duplication | High | 2h | Prevents future drift |
| 2. Registry mirror in `eve local` | Medium | 1h | Fixes app deploy after `eve local up` |
| ~~3. Auto-load system secrets~~ | ~~Removed~~ | — | Platform secrets deprecated; use org/project secrets |
| 4. Document the boundary | High | 30m | Prevents confusion |
| 5. Backport log streaming to `./bin/eh` | Low | 2-3h | Nice parity |
| 6. `eve local up --source` | Future | 4-6h | True superset (only if needed) |
