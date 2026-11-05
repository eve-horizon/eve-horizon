# Harness Process Isolation Plan

> Status: Phase 1 implemented; phases 2 and 3 proposed
> Last Updated: 2026-11-05
> Purpose: Stop job code (agent harnesses, pipeline scripts) from reading the
> platform credentials of the service process that launched it.

## Problem

The agent runtime's default `EVE_AGENT_RUNTIME_EXECUTION_MODE=inline` spawns
harnesses as children of the runtime, under the same UID (`node`, 1000). The
harness env is an allowlist (`packages/shared/src/harnesses/env-builder.ts`),
but Linux lets any process read `/proc/<pid>/environ` of another process with
the same UID. So a prompt-injected agent could run

```bash
tr '\0' '\n' < /proc/1/environ
```

and read the runtime's `DATABASE_URL` and `EVE_INTERNAL_API_KEY` (and, with
`envFrom: eve-app`, every platform secret). With the database URL it can set
`users.is_admin`; with the internal key it can decrypt project secrets and mint
job and registry tokens. The worker has the same exposure for in-process
pipeline scripts: PID 1 is `tini`, which holds the whole pod environment.

The environment is also visible, briefly, in helper children the services
spawn with the full `process.env` (git, crane, tar), and for as long as it runs
in the worker's orphan reaper, a background bash loop started by the entrypoint.

## Options considered

| Option | Verdict |
| --- | --- |
| **Separate UID for the harness** (`spawn` with `uid`/`gid`) | Needs `CAP_SETUID`/`CAP_SETGID` in the runtime. Kubernetes cannot grant ambient capabilities to a non-root container user, so the runtime would run as UID 0 with a trimmed capability set. That fails the `restricted` Pod Security profile, makes any runtime RCE root in the container, and every file the runtime prepares for a harness (workspace clone, job HOME, credentials, CLAUDE.md, caches, the org filesystem) needs ownership handover, plus `safe.directory` for git on both sides. Strongest separation, largest blast radius, and not verifiable offline. Deferred to phase 3. |
| **Entrypoint drops the runtime to another user** (`gosu`, `su-exec`, `setpriv`) | Dropping the runtime is easy; spawning the harness as yet another UID still needs a privileged helper (setuid binary, which `allowPrivilegeEscalation: false` blocks, or a root broker process). Keeping `CAP_SETUID` as an ambient capability leaks it to every child, including the harness. Rejected. |
| **`/proc` with `hidepid=2`** | Needs a privileged mount; Kubernetes `procMount` only offers `Default`/`Unmasked` (masked paths, not `hidepid`). It also hides only other users' processes, so it adds nothing without UID separation. Rejected. |
| **`shareProcessNamespace`** | Concerns containers in one pod; the harness is a child process in the same container. Not applicable. A sidecar container per job would be a separate PID namespace, which is what runner pods already are. |
| **Scrub the runtime's own environment after reading it** | `delete process.env.X` calls `unsetenv()`, which drops the pointer but leaves the original strings in the exec-time block that `/proc/<pid>/environ` reads. Node has no API to overwrite that memory, and libuv's process-title support only reuses the `argv` area. Rejected for Node. |
| **Runner pods with scoped job tokens** | Runner pods still receive `DATABASE_URL` and `EVE_INTERNAL_API_KEY` (the runner records logs, mints the job token and resolves secrets with them), and the harness shares the runner's UID, so before this change the same `/proc` read worked there. Runner pods use the worker image, so phase 1 protects their processes too, but the credentials stay in the pod spec. Right long-term direction; phase 2 (see job-execution-isolation-plan.md). |
| **Non-dumpable service process** (chosen) | The kernel marks a process non-dumpable when it executes a binary its user cannot read (`would_dump()` in `fs/exec.c`). Its `/proc/<pid>` files become root-owned and `ptrace_may_access()` refuses same-UID callers without `CAP_SYS_PTRACE`. No root, no capabilities, no ownership changes, no harness changes. |

## Phase 1 (this change)

1. **Execute-only interpreters.** The agent-runtime and worker images install
   `/usr/local/libexec/eve-node` (a copy of node, mode `0711`, owned by root)
   and the worker image installs `/usr/local/libexec/eve-tini`. The services
   start from them (`CMD`, `ENTRYPOINT`); the worker entrypoint `exec`s into
   `eve-node`. Harnesses and scripts keep using the ordinary, readable
   `/usr/local/bin/node`, so tools that read the node binary (SEA builds,
   `ldd`, packagers) are unaffected. Cost: one extra copy of node per image
   (about 110 MB uncompressed).
2. **Startup self-check.** `checkEnvironProtection()` (shared) stats
   `/proc/self/environ`: root-owned means non-dumpable. The worker and agent
   runtime log the result at boot and warn with the fix when exposed (for
   example a deployment that overrides `command: ["node", ...]`).
   `EVE_REQUIRE_ENVIRON_PROTECTION=true` turns the warning into a refusal to
   start; recommended for production once the new images are rolled out.
3. **Helper children without platform credentials.** `withoutPlatformSecrets()`
   removes `DATABASE_URL`, `EVE_INTERNAL_API_KEY`, `EVE_SECRETS_MASTER_KEY`,
   signing keys and storage secrets from the env of git (`runGit`,
   `GitWorkspace.runGit`), crane and tar.
4. **Orphan reaper.** The worker entrypoint starts the reaper with `env -i`
   and only its own settings.

### Verified offline

In a container with `--cap-drop ALL`, `no-new-privileges`, UID 1000 (kernel
6.8, `fs.suid_dumpable=0`, Yama `ptrace_scope=1`):

| Target process (UID 1000) | `/proc/<pid>/environ` owner | Same-UID `cat environ` | `/proc/<pid>/fd` | `/proc/<pid>/mem` |
| --- | --- | --- | --- | --- |
| Started from a readable binary | 1000 | **secret printed** | listable | denied (Yama) |
| Started from a `0711` root-owned binary | 0 | permission denied | denied | denied |

`/proc/<pid>/cmdline`, `stat` and `status` stay readable and signals still
work, so `ps` and the orphan reaper behave as before.

With `node:22-slim` (v22.23.4) and a service started as UID 1000 from
`install -D -o root -g root -m 0711 /usr/local/bin/node /usr/local/libexec/eve-node`
with `DATABASE_URL` in its environment:

| | `eve-node` (execute-only) | `/usr/local/bin/node` (control) |
| --- | --- | --- |
| `/proc/self/environ` owner seen by the service (the self-check) | 0 | 1000 |
| Job child (`sh`, clean env) reads the service's environ | permission denied | `DATABASE_URL=...` printed |
| Job child reads its own environ | yes | yes |
| `process.execPath` child process | runs | runs |
| `worker_threads` | run | run |

Not verified offline: the full service images (not built), Kubernetes nodes'
`fs.suid_dumpable`, and the harness CLIs end to end (live-test list below).

Unit tests: `process-isolation.spec.ts` (exposure classification, strict mode,
platform-secret stripping, real `git` children without the credentials), and
image guards in both apps (`process-isolation.image.spec.ts`).

## Residual risk

- **`fs.suid_dumpable=1`.** On a node with this debug setting, execute-only
  binaries no longer make a process non-dumpable. The default is 0, and
  Ubuntu with apport uses 2; both protect. The self-check reports `exposed` in
  that case, and strict mode refuses to start.
- **Same UID still means same files.** Concurrent jobs on one runtime pod
  (`AGENT_RUNTIME_CAPACITY` > 1) share UID 1000: a harness can read another
  job's workspace, job token, credentials file and harness environment (LLM
  keys). This is job-to-job leakage within an org-scoped runtime, not
  platform-credential exposure. Phase 3 (per-job UIDs) or runner pods close it.
- **Signals.** A harness can still signal the runtime (denial of service).
- **Service account token and cloud identity.** The agent runtime needs no
  Kubernetes API in inline mode; deployments should set
  `automountServiceAccountToken: false` on it and bind no cloud identity to its
  account (the template's storage identity binding is tracked separately).
- **Other children with the full environment.** Worker-only spawn sites still
  pass `process.env`: `buildctl`, the managed-database snapshot tools
  (`pg_dump`, `psql`) and the worker's legacy git helpers. They matter only for
  in-process scripts running concurrently; runner-pod scripts avoid them.
- **Network.** A harness can call unauthenticated internal endpoints (worker
  and agent-runtime `/invoke`); tracked separately with NetworkPolicy and an
  internal-key check.
- **Development modes** (`pnpm dev`, the `development` Docker targets) do not
  use the execute-only interpreter.

## Least-privilege database role

Even with the environment hidden, the runtime holds a superuser-group
`DATABASE_URL`. Run the agent runtime and worker with a dedicated role:

- `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, not a member of
  `cloudsqlsuperuser`, `rds_superuser` or the migration role.
- Owns nothing; migrations run as a separate owner role from the migrate job.
- `SELECT, INSERT, UPDATE` only on the tables each service touches (jobs,
  job attempts, execution logs, events, threads and messages, agent runtime
  pods and placements, toolchain metadata); no `DELETE` beyond retention
  paths; no access to `users`, `org_members`, role and permission tables,
  `secrets` or auth tables.
- Separate roles for API, orchestrator, worker and agent runtime, so a leak
  from one cannot write `users.is_admin`.

Producing the grant list needs a query inventory per service; it is a
follow-up rather than part of this change.

## Phase 2: runners with job-scoped credentials only

See job-execution-isolation-plan.md: runner pods receive an attempt-scoped
token instead of `DATABASE_URL` and the internal key, so a harness that does
read its runner's environment finds nothing platform-wide.

## Phase 3: per-job UIDs

Run each job as its own UID (from a pool such as 20000-20999), with the runtime
as root restricted to `SETUID`, `SETGID`, `CHOWN`, `FOWNER`, `DAC_OVERRIDE` and
`KILL`. The runtime chowns the attempt workspace and job HOME to the job UID
before spawn and back after exit, and sets `safe.directory` for its own git
calls. This closes job-to-job leakage but needs the `baseline` Pod Security
profile and a live-cluster test matrix across all harnesses.

## Live-cluster verification (not run offline)

- [ ] New images: `kubectl exec` into an agent-runtime pod as UID 1000,
      `cat /proc/1/environ` fails with permission denied; boot log shows
      `AGENT-RUNTIME: process is non-dumpable`.
- [ ] A test agent job running `tr '\0' '\n' < /proc/1/environ` and
      `for f in /proc/[0-9]*/environ; do grep -a DATABASE_URL "$f"; done`
      finds nothing; same for a worker script step (PID 1 is `eve-tini`, the
      worker is `eve-node`).
- [ ] Harness matrix (claude, mclaude, zai, codex, code, gemini, pi) completes
      a job with toolchains; `process.execPath` children and toolchain env
      sourcing work from `eve-node`.
- [ ] Orphan reaper still lists and reaps orphans; `ps` shows `eve-node`.
- [ ] `EVE_REQUIRE_ENVIRON_PROTECTION=true` with an image that runs plain
      `node` refuses to start; with the new image it starts.
- [ ] `cat /proc/sys/fs/suid_dumpable` on each node pool is 0 or 2.
