# Job Execution Isolation Plan

> Status: Phase 1 implemented; phases 2 to 4 proposed
> Last Updated: 2026-11-05
> Purpose: Keep pipeline scripts and other job code away from the worker's
> credentials and Kubernetes permissions.

## Problem

Pipeline script steps are repository code. By default the worker runs them as a
`bash` child of its own process. The worker holds near-cluster-admin RBAC
(cluster-wide create/get on namespaces, pods, secrets, deployments and
daemonsets, plus `pods/exec` in `eve`) and its pod environment carries
`DATABASE_URL`, `EVE_INTERNAL_API_KEY` and, through `envFrom: eve-app`, every
platform secret.

Before this change:

- `EVE_SCRIPT_K8S_RUNNER` defaulted off, so scripts ran in-process.
- In-process script and action-run commands already started from a hand-built
  env, but the legacy step-run `run` action spread the worker's whole
  `process.env` into `bash -lc`.
- Runner pods used whatever `EVE_RUNNER_SERVICE_ACCOUNT` named; deployment
  manifests set it to `eve-worker`, so job code in a runner pod held the
  worker's token and RBAC. With the variable unset, the namespace default
  account's token was mounted.
- Runner pods had no node selector or tolerations, so they landed on the
  platform's core nodes and could not mount a `ReadWriteOnce` org filesystem
  claim held by the agents pool.
- The agent-runtime runner forwarded `EVE_SECRETS_MASTER_KEY`, which only the
  API uses.

## Phase 1 (this change)

| Change | Where |
| --- | --- |
| Runner pods set `automountServiceAccountToken: false` unless `EVE_RUNNER_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN=true` | `packages/shared/src/invoke/runner-pod.ts`, both `k8s-runner.ts` |
| Unset `EVE_RUNNER_SERVICE_ACCOUNT` means the namespace default account, never a platform one; naming a platform account logs a warning | same |
| `EVE_RUNNER_NODE_SELECTOR_KEY`/`_VALUE` and `EVE_RUNNER_TAINT_KEY`/`_VALUE`/`_EFFECT` place runner pods; half-set pairs fail the job | same |
| Optional `EVE_RUNNER_POD_AFFINITY_KEY`/`_VALUE` adds required pod affinity (`topologyKey: kubernetes.io/hostname`) so a runner follows the node holding a `ReadWriteOnce` org filesystem claim | same |
| Runner containers drop all capabilities | both `k8s-runner.ts` |
| Agent-runtime runner no longer receives `EVE_SECRETS_MASTER_KEY` | `apps/agent-runtime/src/invoke/k8s-runner.ts` |
| One allowlisted env for in-process job commands, now also used by the legacy `run` action | `apps/worker/src/execution/job-command-env.ts` |

The variable names follow the existing `EVE_APP_*` and `EVE_STABLE_EGRESS_*`
placement convention (key, value, taint key, taint value, taint effect).

Unit tests: `runner-pod.spec.ts` (shared), `k8s-runner.isolation.spec.ts`
(worker and agent-runtime pod specs: token, service account, selector,
tolerations, capabilities, master key), `job-command-env.spec.ts` (allowlist,
plus real `bash` runs of a script step and a legacy `run` action with a
poisoned worker env).

### Decision: `EVE_SCRIPT_K8S_RUNNER` stays off in code

Flipping the code default would change every Kubernetes install at once:
script steps would start paying pod start-up (image pull, PVC bind, readiness),
need `EVE_RUNNER_IMAGE`, the `eve-org-fs-org-default` claim and a schedulable
pool. On a `ReadWriteOnce` org filesystem claim a runner without pod affinity
hangs in `ContainerCreating` (Multi-Attach), so the default must not flip
until the deployment manifests carry the affinity for that storage profile. Docker-compose is unaffected (no Kubernetes), but the local k3d stack has
not been exercised with runner-pod scripts. So the production default lives in
the deployment manifests, and the code default can flip once k3d is verified
(checklist below).

### Deployment changes instances need

Worker (and agent-runtime when it uses runner mode):

```yaml
- name: EVE_SCRIPT_K8S_RUNNER          # worker only
  value: "true"
- name: EVE_RUNNER_SERVICE_ACCOUNT
  value: eve-runner
- name: EVE_RUNNER_NODE_SELECTOR_KEY
  value: pool
- name: EVE_RUNNER_NODE_SELECTOR_VALUE
  value: agents
- name: EVE_RUNNER_TAINT_KEY
  value: pool
- name: EVE_RUNNER_TAINT_VALUE
  value: agents
- name: EVE_RUNNER_TAINT_EFFECT
  value: NoSchedule
# Only when the org filesystem claim is ReadWriteOnce (one disk, one node):
- name: EVE_RUNNER_POD_AFFINITY_KEY
  value: app.kubernetes.io/name
- name: EVE_RUNNER_POD_AFFINITY_VALUE
  value: eve-agent-runtime
```

plus a token-less service account with no RBAC and no cloud identity binding:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eve-runner
  namespace: eve
automountServiceAccountToken: false
```

Network policy must let the worker (and agent runtime) reach runner pods on
port 4749 (`eve.type=runner`), and let runner pods reach the API and Postgres.

**Behaviour change for existing installs:** runner pods that previously ran
as `eve-worker` with its token lose Kubernetes API access. Runner code never
uses the API (it self-terminates by exiting), so only job code that called
`kubectl` from a runner pod is affected; such an install can set
`EVE_RUNNER_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN=true` while it migrates. Installs
that never enabled runner mode see no change.

## Residual risk after phase 1

1. **In-process execution is defence in depth only.** Scripts share the
   worker's UID, filesystem and pod. They can read the worker's service account
   token at `/var/run/secrets/kubernetes.io/serviceaccount/token` (cluster-wide
   RBAC), reach the pod's cloud identity through the metadata server (GKE
   Workload Identity, EKS IRSA or Pod Identity), and read credential files the
   worker entrypoint writes under `$HOME`. The worker's own environment, its
   helper children and the inspector are covered by the service process
   hardening (see
   [harness-process-isolation-plan.md](./harness-process-isolation-plan.md)).
   Only runner-pod mode with a token-less, identity-free service account
   removes the token and the cloud identity. Production should run scripts in
   runner pods.
2. **Runner pods still carry `DATABASE_URL` and `EVE_INTERNAL_API_KEY`.** The
   runner process writes execution logs and runner events and resolves project
   secrets with them. Job code in the pod runs under the same UID.
3. **The worker's RBAC is cluster-wide.** A compromise of the worker process
   itself (not job code) still reads every Secret in the cluster.

## Phase 2: runners without platform credentials

The runner process uses its platform credentials for:

| Credential | Outbound use in a runner pod |
| --- | --- |
| `DATABASE_URL` | job and attempt reads, execution log appends, runtime metadata, thread messages |
| `EVE_INTERNAL_API_KEY` | `mintJobToken` (the script's `EVE_JOB_TOKEN`), `resolveProjectSecrets` (git auth, `env_overrides`), `mintAppLinkToken`, `emitRunnerEvent` (`runner.started/completed/failed`) |

Job code does not inherit either (allowlisted env), and with the non-dumpable
service process change it cannot read them from the runner's `/proc` entries;
but both remain in the pod spec, visible to anyone who can read the pod. Dropping
only the internal key would buy nothing while `DATABASE_URL` stays, and would
break runner pods once inbound internal-key checks land on the worker app.

Give a runner pod an attempt-scoped token instead of `DATABASE_URL` and the
internal key:

- The worker mints an attempt-scoped runner token (job token plus
  `runner:report` for one attempt) and passes it in the submit request, not the
  pod env.
- New API endpoints accept execution log appends, runtime metadata and runner
  events for that attempt only.
- Secret resolution uses the job token's project scope.
- The runner image's DB module is not loaded in runner mode.
- Inbound calls to the runner (`/invoke`, `/scripts/execute`) authenticate
  with a per-pod random token that the creating worker generates, puts in the
  pod spec as the runner's expected inbound key, and sends with its submit
  request. That keeps inbound auth working without the platform-wide key.

## Phase 3: per-namespace worker RBAC

Replace the worker `ClusterRole` with a `Role` per app namespace, created with
the namespace (the worker keeps cluster-wide `namespaces` create and
`rolebindings` create, scoped by an admission policy to `eve-*` namespaces).
`secrets` get is then limited to app namespaces, which closes the residual the
upsert path needs today.

## Phase 4: refuse in-process scripts in Kubernetes

Once phase 2 lands and k3d is verified, flip `EVE_SCRIPT_K8S_RUNNER` on for
`EVE_RUNTIME=k8s` and require an explicit `EVE_SCRIPT_ALLOW_IN_PROCESS=true`
to run job code inside the worker. Consider deriving the runner's affinity
from the org filesystem claim's access mode instead of configuration.

## Live-cluster verification (not run offline)

- [ ] With `EVE_SCRIPT_K8S_RUNNER=true` and the variables above, a pipeline
      script step runs in a runner pod on the agents pool and completes.
- [ ] In that pod: no file under `/var/run/secrets/kubernetes.io/`;
      `kubectl auth can-i --list` fails; on GKE the metadata server returns no
      token for the runner's KSA.
- [ ] With a `ReadWriteOnce` org filesystem claim and
      `EVE_RUNNER_POD_AFFINITY_KEY=app.kubernetes.io/name`,
      `_VALUE=eve-agent-runtime`, a runner pod starts on the agent runtime's
      node (no `Multi-Attach` event); without the affinity on a multi-node
      pool it can hang, which confirms the setting is needed.
- [ ] With `EVE_RUNNER_NODE_SELECTOR_KEY` set and the value missing, the job
      fails with the configuration error rather than scheduling.
- [ ] k3d: `./bin/eh k8s deploy` with `EVE_SCRIPT_K8S_RUNNER=true`, then a
      manual scenario with a script step, before flipping the code default.
