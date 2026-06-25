# Local App-Link Mesh

Current: implemented for local k3d via `eve local mesh`.

`eve local mesh` runs a small set of Eve projects on the same local k3d stack
and deploys them in app-link order. It is an orchestration layer over existing
platform primitives: project ensure, project sync, direct env deploy, app-link
diagnostics, and k3d image import.

## Workspace Files

Workspaces live under `~/.eve/workspaces/<name>.yaml`; the active workspace name
is stored in `~/.eve/active-workspace`.

```yaml
name: observation
org: org_manualtestorg
env: local
profile: local

projects:
  - name: prod
    path: ~/dev/producer
  - name: cons
    path: ~/dev/consumer

defaults:
  direct: true
  pre_check: true
  cli_image_registry: local
```

Project `name` is the Eve project slug, not a display name. It must be the same
4-8 character slug used in `x-eve.app_links.*.project` references. Paths accept
`~`, environment variables, and relative paths.

## Command Flow

```bash
eve local mesh init obs --org org_manualtestorg --env local
eve local mesh add prod --path ../producer
eve local mesh add cons --path ../consumer
eve local mesh up
eve local mesh status
eve local mesh diagnose --probe
eve local mesh redeploy cons
eve local mesh down
```

`mesh up` requires a running local API (`http://api.eve.lvh.me` or localhost)
and valid auth. It refuses non-local API URLs. The command ensures every
declared project exists, parses each manifest, verifies `environments.<env>` is
declared, builds a DAG from `x-eve.app_links.consumes`, and syncs/deploys in
producer-first order.

`mesh redeploy <project>` syncs upstream producers first, then syncs and deploys
the requested project. This catches grant/scope changes before the consumer
rollout.

`mesh down` undeploys tenant envs only. It leaves the `eve` platform namespace
and k3d cluster running.

## Local CLI Images

Cross-project app-link CLIs must be image-mode CLIs. In staging those images
come from a registry. In local mesh mode, the producer checkout can provide a
`Dockerfile.cli`; `mesh up` builds it as:

```bash
local/<producer-slug>-cli:<git-sha>
```

and imports it into the `eve-local` k3d node cache with `k3d image import`.
During producer sync, the CLI sends a per-request `local_cli_images` map so the
grant records the local image reference. This is intentionally per-sync request
state; the API process has no global local registry setting.

The standalone helper is:

```bash
eve project image build-cli prod --repo-dir ../producer --import-to-k3d
```

## Diagnostics

`eve local mesh status` shows workspace projects, env state, namespace, and
declared app-link subscriptions.

`eve local mesh diagnose` calls `eve app-links explain` semantics for each
consumer subscription. `--probe` additionally creates a short-lived Kubernetes
Job in the consumer namespace, clones the injected `EVE_APP_LINK_<ALIAS>_*`
environment variables from the consumer deployment, and curls the producer
`/health` endpoint. The probe never prints raw token values.

If a probe fails, first check:

- The producer and consumer both declare the workspace env name, usually
  `local`.
- The consumer `project` reference matches the producer Eve project slug.
- The producer grant includes the consumer project, requested scopes, and
  `local` env.
- The consumer service is listed in `inject_into.services`.
- The producer service exposes a `/health` route if using `--probe`.

## Boundaries

Local mesh does not bootstrap the platform stack. Use `eve local up` or
`./bin/eh k8s start && ./bin/eh k8s deploy` first.

The mesh does not add a new manifest surface, token type, or app-link runtime.
It reuses the existing app-link grant/subscription tables, deploy-time service
env injection, job `--with-links`, and agent-runtime CLI init containers.
