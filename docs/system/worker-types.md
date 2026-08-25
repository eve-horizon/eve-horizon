# Worker Types

> Status: Current
> Last Updated: 2026-08-25
> Purpose: Configure job routing and toolchain selection for worker pools.

## Overview

Eve Horizon routes jobs to named worker services. A job requests a route through
`hints.worker_type`; the orchestrator resolves that name through
`EVE_WORKER_URLS`. Worker type selects a service endpoint, not an image variant.

The supported public artifact model is:

- one `worker:<platform-version>` image, released with the other six platform
  services;
- the same pinned worker image used for ephemeral runner pods through
  `EVE_RUNNER_IMAGE`; and
- independently versioned `toolchain-{python,media,rust,java,kotlin}` images,
  materialised per step through `EVE_TOOLCHAIN_IMAGE_PREFIX` and
  `EVE_TOOLCHAIN_IMAGE_TAG`.

There are no supported public `worker-full`, `worker-python`, or other
`worker-*` variant images. Toolchains are selected by manifest steps, not by
choosing a worker image variant.

## Worker routing

`EVE_WORKER_URLS` is a comma-separated map from route name to service URL:

```env
EVE_WORKER_URLS=default-worker=http://worker:4811,playwright-worker=http://worker-playwright:4811
```

A job can select a configured route:

```bash
eve job create \
  --project proj_example \
  --description "Run the browser checks" \
  --worker-type playwright-worker
```

If `hints.worker_type` is absent, the orchestrator uses `default-worker` (or the
legacy `WORKER_URL` fallback). An unknown route fails early. Docker Compose
ships an optional `worker-playwright` profile as the concrete secondary-pool
example; Kubernetes instance owners can add another worker Deployment and
Service, then add its URL to the orchestrator mapping.

## Toolchains

Declare language/media requirements on manifest workflow or pipeline steps.
The worker resolves those declarations into job hints, exports the requested
toolchain image into `EVE_TOOLCHAIN_ROOT`, and sources its `env.sh` only for the
launched process. This keeps the platform worker image stable while allowing
steps to compose the tooling they need.

For local k3d, `eh k8s-image push-toolchains` imports the toolchain images into
the cluster registry. Hosted deployment instances configure the public image
prefix and tag on the worker and agent-runtime pods.

## Adding a worker pool

1. Add a worker service with the canonical `worker:<platform-version>` image.
2. Give the service a distinct name and endpoint.
3. Add `<route-name>=<service-url>` to `EVE_WORKER_URLS` on the orchestrator.
4. Create a job with `--worker-type <route-name>` and verify the selected
   endpoint receives it.

Worker pools may have different capacity, node placement, or runtime policy.
They should still use the canonical worker and runner image unless an instance
owner has intentionally built and governs a private derivative.

## Runtime contract

Worker and runner processes use the shared workspace/cache/toolchain contract:

- `EVE_WORKSPACE_ROOT` for workspaces;
- `EVE_CACHE_ROOT` for package and compiler caches;
- `EVE_STATE_ROOT` for persistent state;
- `EVE_TOOLCHAIN_ROOT` for materialised toolchains; and
- UID/GID `1000` in the default Kubernetes security context.

The entrypoint verifies required paths are writable before starting. Runner
pods and worker services must use compatible workspace and cache mounts.

## Validation

1. Start the local stack with `./bin/eh k8s start` (or
   `./bin/eh start docker` for the quick development loop).
2. Submit a job without `--worker-type`; confirm it runs on `default-worker`.
3. Enable a secondary worker, add it to `EVE_WORKER_URLS`, and submit a job with
   its route name.
4. Add a manifest step with a toolchain requirement and confirm its environment
   is present only for that step.

See [Deployment](./deployment.md), [Harness Execution](./harness-execution.md),
and [Manifest](./manifest.md) for the surrounding runtime contracts.
