# Local App-Link Mesh (multi-project k3d inner loop)

> **Status**: Implemented
> **Last Updated**: 2026-05-20
> **Spec**: `eve-platform-specs/008 — Multi-project local dev loop for app-link testing` (ACME-side request, opened 2026-05-19)
>
> **Inputs**:
> - `docs/plans/cross-project-app-links-plan.md` (the producer/consumer surface this builds on — grant registry, token/env injection, job `--with-links`, CLI init containers, and event fan-out are in tree; local CLI image automation and NetworkPolicy reconciliation are not)
> - `docs/system/k8s-local-stack.md` (single-project k3d loop today)
> - `docs/system/cross-project-app-links.md` (shipped app-link surface this extends into local mode)
> - `docs/plans/local-stack-manager-guards-plan.md` (precedent: `eve local` vs `./bin/eh` ownership marker)
> - `packages/cli/src/commands/local.ts` (current `eve local up/down/health/...` shape)
> - `packages/cli/src/commands/env.ts` (`eve env deploy <env> --ref HEAD --direct --repo-dir <path>` — the unit primitive a mesh up command composes)
>
> **Dependencies (already shipped)**:
> - `x-eve.app_links.{exports,consumes}` manifest schema + `project_app_link_{grants,subscriptions}` tables
> - `mintAppLinkToken()` + `verifyAppLinkToken()` with `aud: project:<producer_project_id>`
> - Deployer-side `resolveAppLinkEnvVars()` writing `EVE_APP_LINK_<ALIAS>_{API_URL,TOKEN,CLI,SCOPES,PROJECT,ENV}` onto consumer pods (`apps/worker/src/deployer/deployer.service.ts:2547-2613`)
> - Job-dispatch app-link resolution (`apps/api/src/jobs/jobs.service.ts:363-417`) including `cli: { name, bin, image }` thread-through to `HarnessInvocation.appClis`
> - Agent-runtime k8s-runner init container mounting `appClis[].image` at `/opt/eve/app-cli/<name>/bin` and prepending to `PATH` (`apps/agent-runtime/src/invoke/k8s-runner.ts:253-385`)
> - `eve project sync --project <slug-or-id> --dir <path>` and `eve env deploy <env> --project <slug-or-id> --ref HEAD --direct --repo-dir <path>` (per-project local-source primitives)
> - `eve app-links {list,plan,explain}` diagnostics

---

## Problem

The observation-platform topology — and every other "core + satellites" pattern Eve aims to support — is a **mesh of Eve projects** that talk over app-links. ACME spec 008 is explicit about the cost imposed by that topology: every change that crosses a producer/consumer contract needs cross-project verification, and today the **only documented inner loop** is "deploy producer to remote sandbox, deploy consumer to remote sandbox, run E2E against the remote stack". That's minutes per iteration when it should be seconds.

The single-project local loop is already strong:

```bash
./bin/eh k8s start && ./bin/eh k8s deploy        # cluster up, platform deployed
eve project ensure --name observation-platform   # one project
eve project sync --project observation-platform --dir .  # sync from checkout
eve env deploy local --project observation-platform --ref HEAD --direct --repo-dir .
```

What spec 008 asks for is to make that loop work for **N projects on the same k3d cluster**, with app-links resolved among them, without a remote round-trip. Today there is no `eve local mesh` (or equivalent), no workspace declaration listing the N checkouts, and no producer-first orchestration that respects the sync ordering app-links require.

---

## Insight

**The platform already does this.** The deployer's `resolveAppLinkEnvVars()` reads grants and subscriptions from the local API DB, computes the producer's in-cluster DNS (`http://<env>-<service>.eve-<org>-<proj>-<env>.svc.cluster.local:<port>`), mints an `aud: project:<producer_id>` token, and writes the env vars onto consumer pods. The agent-runtime's k8s-runner mounts producer CLI images via init containers using the same `appClis[]` field that already works for same-project CLIs. None of this knows or cares whether it's running in staging EKS or local k3d — it routes through DB state and in-cluster DNS, and k3d provides both.

The gap is **purely workflow**. There is no:

1. **Workspace declaration** — a file that lists "these N checkouts are the local mesh".
2. **Mesh orchestrator** — a single command that does producer-first sync + deploy across all of them.
3. **Local CLI image automation** — when a producer export names a service CLI backed by `x-eve.cli.image` (the only CLI mode allowed cross-project; see `cross-project-app-links-plan.md` §6), the local k3d cluster needs the image imported, not pulled from `ghcr.io`. Today nothing builds + imports that image automatically.
4. **Convention** — every project in the mesh deploys to a shared env name so `consumes.*.environment: same` resolves cleanly. We have one already in tree (`local`), but no doc says "use this and only this for local mesh work".

That is the narrow scope. We are not adding a new manifest surface, new env vars, new token types, new NetworkPolicy reconcilers, or new agent-injection paths. Those are already shipped (or covered by `cross-project-app-links-plan.md` for the remaining phases). We are adding a **thin orchestrator** plus one missing platform helper for producer CLI images.

---

## Goals

- **One command to bring up the mesh.** `eve local mesh up` syncs and deploys every project in the active workspace, producer-first, against the running k3d cluster.
- **Workspace is declarative and committable-where-it-belongs.** A workspace lives in `~/.eve/workspaces/<name>.yaml`, lists projects by name + checkout path, with optional org and env overrides. It is per-host by default so multiple engineers can share the same set of checkouts with different workspace shapes.
- **Producer-first ordering is automatic.** The orchestrator toposorts the mesh by `x-eve.app_links.consumes[].project` references and refuses cycles. A consumer never syncs before its producer; sync failures are caught early with a precise error.
- **Local producer CLI images are platform-built and platform-imported.** When a producer export resolves to a `cli_image`, `eve local mesh up` builds the image from the producer's checkout (using `Dockerfile.cli` or an explicit `--dockerfile` override on the build helper) and imports it into k3d as `local/<producer-slug>-cli:<sha>` — the same image path the grant stores at sync time when the mesh supplies a local CLI registry override.
- **Diagnostics first-class.** `eve local mesh diagnose` walks every consumer subscription, prints resolved producer DNS / token-mint status / scopes / CLI image / NetworkPolicy reachability, and surfaces exactly why a link doesn't work — reusing `eve app-links explain` for the per-link detail. It never prints raw token values.
- **Fast iteration loop.** `eve local mesh redeploy <project>` redeploys one project; consumers' env vars (URL, token, CLI mount) refresh on their next deploy or job dispatch with no manifest change.
- **Cleanup is honest.** `eve local mesh down` deletes the mesh's per-project envs (namespaces + workloads) but leaves the k3d cluster and the platform stack running so the next `mesh up` is a few seconds away.

## Non-Goals (v1)

- **Replacing `eve local up`/`./bin/eh k8s deploy`.** Mesh work runs on top of an existing platform stack. The orchestrator refuses to act if the platform isn't healthy.
- **A new manifest surface.** Workspace files are local-only; the producer/consumer contract is unchanged.
- **Production-faithful sizing.** Mesh deploys use whatever the project's `local` env declares — usually `replicas: 1`, no PDBs, klipper LB.
- **Persistent state across `mesh down`.** Volumes are torn down with the namespaces; persistent dev data is out of scope for v1 (and arguably belongs in fixture seeders, not platform plumbing).
- **CI parallel workspaces.** CI may use `eve local mesh up` against an ephemeral k3d, but optimizing for `N` parallel mesh workspaces on one host is a separate concern.
- **Cross-cluster mesh.** All mesh projects land in one k3d cluster.
- **Cross-org links in local mode.** Producer/consumer must share an org — same constraint as `cross-project-app-links-plan.md` v1.
- **Persistent file-watch / hot-redeploy.** `mesh up --watch` is called out as a Phase 3 stretch; v1 is single-shot up/down/redeploy.

---

## Design

### 1) Workspace file

A workspace is a flat YAML at `~/.eve/workspaces/<name>.yaml`. The file is the single source of truth; the active workspace is selected by name.

```yaml
# ~/.eve/workspaces/observation-platform.yaml
name: observation-platform
org: manual-test-org              # platform org slug (must exist on the local stack)
env: local                        # env name each project deploys to (convention)
profile: local                    # eve CLI profile to use (defaults to current)

projects:
  - name: observation-platform    # canonical project slug used on the local API
    path: ~/dev/observation-platform
    role: producer                # informational only; sort order comes from manifest
  - name: acme-portal
    path: ~/dev/acme-portal

defaults:
  direct: true                    # use eve env deploy --direct (mesh still supplies --ref HEAD)
  pre_check: true                 # run `./bin/eh status` + `eve system health --json`
  cli_image_registry: local       # see §4
```

Key shape decisions:

- **One env per project.** The workspace fixes a single env name (default `local`) for every project. `consumes.*.environment: same` is the only sane strategy in a local mesh; the env name must match across producers and consumers, and the workspace pins it. Per-project env overrides could come later, but v1 is intentionally rigid.
- **Path resolution.** `path` accepts `~/`, env vars, and relative paths. Resolved at command time, validated to contain `.eve/manifest.yaml`.
- **Project slug is the local API slug.** `name` must match the slug used by `eve project ensure`. If the project doesn't exist on the local API yet, `mesh up` creates it (idempotent `eve project ensure --name <slug> --slug <slug> --repo-url file://<path> --branch <current-branch>`).
- **`role` is informational.** Toposort uses the consumer's `app_links.consumes[].project` references. Hand-declared roles get ignored if they conflict.
- **No project-level git state in the workspace.** Each `path` is a live checkout; `mesh up` uses whatever's at `HEAD`. If the workspace ever needs to pin shas, that's a Phase 3 add (see Open Questions).

Workspace management:

```bash
eve local mesh init <name> [--org <slug>] [--env local] [--profile <profile>]
                                                    # creates an empty workspace file, prompts for missing defaults
eve local mesh add <project> --path <path>         # appends to the active workspace
eve local mesh use <name>                          # makes <name> active (writes ~/.eve/active-workspace)
eve local mesh list [--json]                       # lists all workspaces and which is active
eve local mesh show [--workspace <name>] [--json]  # prints the resolved workspace
```

`eve local mesh up` accepts `--workspace <name|path>` to override the active workspace inline.

### 2) The `eve local mesh` command surface

```bash
eve local mesh up        [--workspace <name>] [--only <project>...] [--skip-pre-check] [--skip-cli-build]
eve local mesh down      [--workspace <name>] [--delete-projects]                        # default: delete envs only
eve local mesh redeploy  <project> [--workspace <name>] [--skip-cli-build]
eve local mesh diagnose  [--workspace <name>] [--project <slug>] [--json]                # mesh-wide
eve local mesh logs      <project>[/<component>] [--follow] [--since <duration>]         # passthrough
eve local mesh status    [--workspace <name>] [--json]                                   # one table for the whole mesh
```

Implementation is **a composer over existing primitives**, not a new code path:

- `mesh up` per project: `eve project ensure --name <slug> --slug <slug>` → `eve project sync --project <slug> --dir <path>` → (build + import producer CLI image if applicable) → `eve env deploy <env> --project <slug> --ref HEAD --direct --repo-dir <path>`. Failures are reported per-project with the same error surfaces those commands already emit.
- `mesh down` per project: `eve env undeploy <env> --project <slug> --force` (already exists). The default keeps projects and the workspace for fast re-up; `--delete-projects` additionally calls `eve project delete <slug>` after undeploy succeeds.
- `mesh redeploy` is `mesh up --only <project>`, with upstream producers synced first when the target is a consumer.
- `mesh status` shells `eve env show` per project and folds the output into one table with app-link rows pulled from `eve app-links list --json`.
- `mesh diagnose` walks every consumer's subscriptions and calls `eve app-links explain --consumer <c> --alias <a> --json` for each, plus a NetworkPolicy probe (§5).

Everything lives in `packages/cli/src/commands/local.ts` next to the existing `eve local` handlers, or in a new `packages/cli/src/commands/local-mesh.ts` registered the same way. No server-side endpoints or tables for Phase 1; Phase 2 adds only a per-sync request field/header for local CLI image rewriting.

### 3) Producer-first toposort

The mesh orchestrator does not rely on the workspace's declaration order. It builds a DAG from each project's parsed manifest:

```
for project in workspace.projects:
    manifest = parseYaml(<path>/.eve/manifest.yaml)
    appLinks = (manifest["x-eve"] ?? manifest.x_eve)?.app_links
    for alias, consume in appLinks?.consumes ?? {}:
        addEdge(producer=consume.project, consumer=project.name)
```

Then it toposorts. A consume reference whose producer is not listed in the workspace fails fast with "add producer `<slug>` to this mesh" rather than silently using stale DB state. Cycles are rejected with a clear error pointing at the offending consume blocks (cycles across local projects are themselves an architectural smell — the user should split the contract or eliminate the cycle, not ask the orchestrator to paper over it).

Projects with no app-link references go first in the workspace's declared order. `mesh up` first ensures every project exists, then syncs and deploys projects in topo order. There is no arbitrary "sync everything first" pass, because consumer sync validates against producer grants and therefore must run after the producer sync. Work proceeds after a single-project failure unless the failed project is a producer for another in-flight project, in which case downstream syncs/deploys are skipped with a `skipped: producer <X> failed` reason in `mesh status`.

### 4) Producer CLI image: local-mode build + import

This is the one place where v1 needs new platform behavior. Today `cross-project-app-links-plan.md` Phase 3 assumes the producer's CLI image is at a registry the consumer's cluster can pull (in practice `ghcr.io/...`). In local k3d, we don't want consumers to pull from ghcr at all — we want a reproducible, fast loop that uses the producer's working tree.

Two changes:

1. **A producer-side build helper `eve project image build-cli --import-to-k3d`** that:
   - Locates `Dockerfile.cli` in the producer's repo (or accepts an explicit `--dockerfile <path>` flag). v1 does not add an `x-eve.cli.dockerfile` manifest field.
   - Builds `local/<producer-slug>-cli:<sha>` using the local Docker daemon.
   - Imports into the active k3d cluster via `k3d image import` (same pattern as `./bin/eh k8s-image push`).
   - Returns the image reference for the mesh orchestrator to record.

2. **A workspace-time grant override**. When `defaults.cli_image_registry: local` is set in the workspace (the default), `mesh up` runs the build+import for every producer that has a `cli_image` declared, **then** calls `eve project sync` with a per-request local CLI registry override so the sync writes `local/<producer-slug>-cli:<sha>` into `project_app_link_grants.cli_image` instead of the manifest's prod reference. Concretely: the CLI passes either a request body field such as `local_cli_registry` or an `X-Eve-Local-Cli-Registry` header; the API threads that value into `apps/api/src/projects/projects.service.ts::resolveCliImage()` before grant upsert. This must not be a process-wide API env var, because that would pollute unrelated syncs.

The k8s-runner's init-container logic is unchanged; it just pulls `local/<producer-slug>-cli:<sha>` instead of `ghcr.io/.../...`, and because the image was imported via `k3d image import`, the kubelet finds it under `imagePullPolicy: IfNotPresent` (the local default per CLAUDE.md and `k8s-runner.ts`).

Repo-mode CLI exports remain rejected at producer sync (per `cross-project-app-links-plan.md` §6). The mesh doesn't paper over that — if you want cross-project CLI sharing locally, your producer needs `Dockerfile.cli` (and that gives you a clean staging story too).

### 5) Cross-namespace reachability in local mode

The shipped deployer computes `http://<env>-<service>.eve-<org>-<proj>-<env>.svc.cluster.local:<port>` regardless of cluster, and that DNS resolves on k3d. The only thing that can break direct cross-namespace traffic is a default-deny NetworkPolicy. Two observations:

- **The current local stack does not create tenant default-deny NetworkPolicies.** That is different from claiming k3d cannot enforce them; if/when namespace hardening lands locally, direct Service DNS needs an explicit allow rule. `mesh diagnose --probe` below makes this empirical instead of aspirational.
- **The cross-project app-links plan already calls out an additive `eve-app-link-<consumer-env>` NetworkPolicy reconciler as a Phase 2 deliverable.** That reconciler is platform-wide, not mesh-specific. The mesh inherits whatever it ships.

For v1 mesh diagnostics:

- `eve local mesh diagnose --probe` schedules a one-shot job in the consumer namespace that `curl -fsS $EVE_APP_LINK_<ALIAS>_API_URL/health` for each subscription and reports the outcome. This is the single source of truth for "is the link reachable" and saves an engineer the kubectl excursion.

No mesh-private NetworkPolicy primitive. If the platform reconciler ships, the mesh benefits; if not, `diagnose --probe` makes the gap obvious.

### 6) Convention: env name `local`

The mesh assumes every project declares an env named `local` (e.g., top-level `environments.local`) and that the workspace pins `env: local`. This is the recommended app-manifest convention for local k3d work, but it has not been written down as a requirement for cross-project app-link work. The plan asks us to:

- Document the convention in `docs/system/k8s-local-stack.md` and the new `docs/system/local-app-link-mesh.md`.
- Have `mesh up` fail-fast with a clear error if a project's manifest does not have the workspace's env name.

### 7) Composition with `cross-project-app-links-plan.md` phases

The mesh is orthogonal to the phasing of the cross-project app-links plan. Concretely:

| Cross-project plan phase | Mesh dependency | Behaviour on local mesh |
|--------------------------|-----------------|-------------------------|
| Phase 1 — grant registry | required | `mesh up` syncs producer then consumer; sync validation fires identically |
| Phase 2 — token + env injection | required | deployer injects `EVE_APP_LINK_*` onto local pods; same code path as staging. NetworkPolicy reconciliation is still inherited from the cross-project plan, not solved in the mesh. |
| Phase 3 — CLI distribution | required for `mesh up --skip-cli-build=false` | mesh adds local CLI image build/import; everything else flows through `appClis` |
| Phase 4 — event fan-out | optional | mesh works without it; `mesh diagnose --events` can add event-link probes once the event fan-out/replay surface is complete |

The mesh adds **zero new producer/consumer surfaces**. Everything the mesh does, an engineer can already do by typing seven commands in the right order; v1 just makes the order automatic and the surface legible.

---

## Phasing

### Phase 1 — Workspace + mesh orchestrator (no producer CLI image automation)

**Code**:
- `packages/cli/src/commands/local-mesh.ts`: new file. Implements `init/add/use/list/show` for workspace files plus `up/down/redeploy/status/logs` and a simple toposort.
- `packages/cli/src/commands/local.ts`: register `mesh` as a `local` subcommand (mirrors current `up/down/health` dispatch).
- `packages/cli/src/lib/local-mesh-workspace.ts`: workspace file loader, Zod schema, and `~/.eve/active-workspace` pointer. Keep this CLI-local; do not add a shared schema unless another package needs it.
- Internal helpers reuse `runUnifiedSync()` and extract the reusable deploy body from `packages/cli/src/commands/env.ts` instead of shelling out, to keep error surfaces typed.

**Out of scope (Phase 1)**: producer CLI image build/import, `diagnose --probe`, watch mode.

**Verification (Phase 1)**: `tests/manual/scenarios/44-local-mesh-grants-and-services.md`
1. Two fixture checkouts under `tests/manual/fixtures/local-mesh/{producer,consumer}` with matching top-level `environments.local`, producer exporting an `observation` API (no CLI), consumer consuming it injected into a service.
2. `eve local mesh init obs-mesh && eve local mesh add producer --path <p> && eve local mesh add consumer --path <c>`.
3. `eve local mesh up` succeeds; producer-first ordering visible in stdout.
4. `eve local mesh status` shows both envs `ready` and the consumer's `observation` link `resolved`.
5. Exec into the consumer pod: `printenv | grep EVE_APP_LINK_OBSERVATION_` matches the producer's in-cluster DNS, scopes, project id.
6. `curl -fsS -H "Authorization: Bearer $EVE_APP_LINK_OBSERVATION_TOKEN" $EVE_APP_LINK_OBSERVATION_API_URL/observations` from the consumer pod returns producer fixture data.
7. Edit the producer's consumer allowlist to drop the consumer; `eve local mesh redeploy consumer` re-runs producer sync first → consumer sync fails with a precise scope/grant error from `runUnifiedSync`.
8. `eve local mesh down` removes both envs; `./bin/eh kubectl get ns | rg 'eve-'` shows the mesh namespaces gone but the `eve` platform namespace untouched.

### Phase 2 — Producer CLI image build + import

**Code**:
- `packages/cli/src/commands/project.ts`: add `eve project image build-cli [--import-to-k3d] [--tag <ref>] [--dockerfile <path>]`.
- `packages/cli/src/lib/cli-image-builder.ts`: build via `docker build` against `Dockerfile.cli` (or an explicit `--dockerfile <path>` flag), tag `local/<slug>-cli:<sha>`, optional `k3d image import`.
- `apps/api/src/projects/projects.service.ts::resolveCliImage()`: accepts a per-request local registry override (`local_cli_registry` in the sync body or `X-Eve-Local-Cli-Registry` header) to rewrite the resolved image path stored on the grant.
- `packages/cli/src/commands/local-mesh.ts`: per-producer `cli_image` detection, build+import before consumer deploy.

**Verification (Phase 2)**: `tests/manual/scenarios/45-local-mesh-cli-injection.md`
1. Producer fixture gains `Dockerfile.cli` and `x-eve.cli` declaring image-mode `obs`.
2. `eve local mesh up` builds + imports `local/producer-cli:<sha>`; the grant in the local DB records that path.
3. Consumer agent job dispatched via `eve job create --project consumer --env local --with-links observation --description "obs observations list"`.
4. Agent workspace: `which obs` resolves; `obs --help` runs from the imported image; `obs observations list --json` returns producer fixture data.
5. Producer code change → `eve local mesh redeploy producer`; producer's image rebuilt + reimported; consumer's next job picks up the new image (init-container pull is `IfNotPresent` against the new sha).

### Phase 3 — `diagnose --probe` and optional watch (stretch)

**Code**:
- `eve local mesh diagnose --probe`: one-shot job in each consumer namespace that calls `$EVE_APP_LINK_<ALIAS>_API_URL/health` per subscription; surfaces 200/4xx/5xx + body excerpt.
- `eve local mesh up --watch` (optional): fs-watch each project's `apps/` and `.eve/`; debounce; redeploy producers first.
- `eve local mesh diagnose --events` (optional, post Phase 4 of cross-project plan): probe app-link event fan-out by emitting `app.observation.created` from the producer and asserting a consumer event arrives within N seconds.

**Verification (Phase 3)**: lightweight scenario `46-local-mesh-diagnose.md` showing `--probe` PASS/FAIL output for resolvable and intentionally-broken links.

---

## Verification loop on local k3d

The standard mesh loop, once Phase 1 lands:

```bash
./bin/eh status                                              # 0. platform healthy
./bin/eh k8s deploy                                           # 1. fresh platform if needed
eve org ensure manual-test-org --slug manual-test-org
eve secrets import --org org_manualtestorg --file manual-tests.secrets

eve local mesh init obs-mesh --org manual-test-org --env local
eve local mesh add observation-platform --path ../observation-platform
eve local mesh add acme-portal      --path ../acme-portal

eve local mesh up                                            # producer-first, syncs+deploys both
eve local mesh status                                        # one table
eve local mesh diagnose                                      # per-link explain
# … iterate on producer code …
eve local mesh redeploy observation-platform                 # fast loop
eve local mesh down                                          # tear down envs, keep platform
```

The same loop drives every phase's manual scenario. Each scenario is one workspace and one or two `mesh up`/`mesh redeploy` cycles — measured in seconds once Phase 1 is in.

---

## Risks and unknowns

1. **Local CLI image rewrite is a sync-time concern with a CLI-supplied flag.** Putting `EVE_LOCAL_CLI_REGISTRY` on the API process would pollute every project's sync. Mitigation: keep the rewrite per-request — the CLI passes a header or sync-request field that the API accepts only for local API URLs and local-admin auth (`admin@example.com` on local, per CLAUDE.md). This keeps the rewrite local-only and out of staging behavior.

2. **Producer manifest must declare a `local` env.** If a producer in the workspace only declares `staging` and `production`, `mesh up` fails. v1 fails-fast with a clear error; we should consider a manifest-help command that copies top-level `environments.staging` defaults into `environments.local` later, but that's authoring assistance, not mesh orchestration.

3. **Watch mode is a foot-gun.** `mesh up --watch` could redeploy a producer on every save, which churns consumer init containers. Phase 3, opt-in, debounced, and documented as "use for short iteration bursts, not all day".

4. **Workspace-as-state vs workspace-as-declaration.** v1 makes the workspace a pure declaration; the running mesh state lives in the local API DB plus k3d. This means `eve local mesh status` always reflects truth, not the workspace's intent. The downside: a workspace file can drift from reality if you `eve env undeploy` directly. Mitigation: `mesh status` highlights "declared in workspace but not deployed" rows.

5. **Path resolution surprises across hosts.** A workspace with `path: ~/dev/...` won't work for a teammate who keeps repos elsewhere. v1 keeps workspaces per-host (`~/.eve/workspaces`); we explicitly do not check workspace files into project repos. A future "shared workspace template" with substitutable paths could come later.

6. **Cross-namespace traffic on local k3d.** Today the local stack does not create tenant default-deny NetworkPolicies, but that is a current implementation detail. `diagnose --probe` (Phase 3) is the empirical check; if it fails on a stock k3d or after namespace hardening lands, we need to ship the NetworkPolicy reconciler `cross-project-app-links-plan.md` already calls out before claiming probe support is reliable.

7. **`./bin/eh` vs `eve local` ownership marker.** `eve local mesh` runs against whatever's deployed; it does not write the namespace marker. If the user is running `./bin/eh k8s deploy` for the platform, the mesh subcommands are still safe — they only touch tenant namespaces (`eve-<org>-<proj>-<env>`), never the `eve` namespace. Document this and add a defensive guard if `mesh up` is ever asked to run against a cluster with no platform deployed.

8. **Profile / auth scoping.** Each `eve env deploy` call needs valid auth against the local API. The workspace's `profile` field plus the existing `EVE_PROFILE`/`--profile` resolution covers this, but errors are easy to misread when one project syncs as the wrong identity. Mitigation: `mesh up` does a single `eve auth whoami` early and prints the resolved identity once, not per project.

---

## Documentation impact

When this ships, update **before tagging the release**:

- `eve-skillpacks/eve-work/eve-read-eve-docs/references/cli.md` — add `eve local mesh {init,add,use,list,show,up,down,redeploy,status,logs,diagnose}`.
- `eve-skillpacks/.../references/deploy-debug.md` — add a "Local multi-project mesh" section pointing at the mesh commands as the recommended cross-project iteration loop.
- `eve-skillpacks/.../references/manifest.md` — note that cross-project local work assumes every project declares the same env name (default `local`).
- `docs/system/k8s-local-stack.md` — add a "Multi-project meshes" subsection that links to the new system doc.
- New `docs/system/local-app-link-mesh.md` — full mental model: workspace files, producer-first ordering, CLI image rewrite, `diagnose --probe`, troubleshooting.
- New `tests/manual/scenarios/44-local-mesh-grants-and-services.md`, `45-local-mesh-cli-injection.md`, and (Phase 3) `46-local-mesh-diagnose.md`.
- Update `CLAUDE.md` (the **Developer Quick Start** section) to mention `eve local mesh` for engineers working across more than one project on the local stack.

---

## Open questions

1. **Workspace location: home dir, repo, or both?** v1 lands on `~/.eve/workspaces/<name>.yaml` for per-host isolation. A future "checked-in mesh template" with `${ENV:HOME}` substitution would let teams share canonical mesh shapes. Lean: keep v1 home-dir-only; revisit when a second team asks.

2. **Should the workspace pin git SHAs per project?** A "snapshot" mode that records each project's resolved SHA after a successful `mesh up` makes mesh state reproducible across machines, but conflicts with the inner-loop ethos (you want HEAD, fast). Lean: do not pin in v1; add `eve local mesh snapshot` later only if a workflow demands it.

3. **Mesh up against a remote API (staging) for "shadow" testing?** Technically the same orchestrator could target the staging profile and bring up an isolated mesh in remote namespaces. v1 is k3d-only; the failure modes against remote (image push permissions, NetworkPolicy reality, billing) are different enough that we should design that separately.

4. **Should `mesh up` ever run `./bin/eh k8s deploy` for the user?** Today the platform must already be running. Doing platform bootstrap implicitly hides a 60-second build, which surprises the user. Lean: keep separate; `mesh up` errors with a one-line `./bin/eh k8s deploy` hint.

5. **Cli image registry naming (`local/...` vs `localhost:5050/...`).** k3d's in-cluster registry is reachable as `localhost:5050` from the host and as the registry hostname from inside. `local/<slug>-cli:<sha>` is a private OCI namespace that only works because the image is pre-imported via `k3d image import` — kubelet finds it via cache. If we ever flip to "push to in-cluster registry instead of pre-import", the path changes to `<cluster-registry>/<slug>-cli:<sha>`. Lean v1: pre-import only; revisit when the toolchain image path also adopts the in-cluster registry.

6. **Mesh-level event tracing.** When `cross-project-app-links-plan.md` Phase 4 lands, `eve local mesh diagnose --events` becomes the mesh-wide observability for fan-out. Worth scoping there to keep this plan small.
