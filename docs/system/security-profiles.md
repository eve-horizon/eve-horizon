# Security profiles

A security profile decides what each hardening rule does. Eve uses profiles
so that stricter defaults can arrive without breaking existing apps: you see
what would change before anything does.

| Profile | What a rule does |
|---|---|
| `legacy` | Nothing: the old behaviour. **Deprecated in 0.1.330 and removed in 0.1.331**: see [the `legacy` deprecation](#the-legacy-deprecation). |
| `audit` | The old behaviour, plus a finding recording what `strict` would refuse. |
| `strict` | The rule is enforced: the request gets 403, and a finding is recorded. |

## Where a profile is set

- **The instance:** the system setting `security.profile`. A fresh database,
  and an existing one after the upgrade that brought profiles, starts on
  `audit`.
- **An org:** overrides the instance.
- **A project:** overrides its org.
- **New projects:** the system setting `security.new_project_profile`, when
  set, is written onto each project as it is created.

Only system admins set profiles, at every level:

```bash
eve system security profile audit                          # instance
eve system security profile strict --project proj_xxx      # one project
eve system security profile clear --project proj_xxx       # inherit again
eve system security profile strict --new-projects          # default for new projects
```

Clearing an org or project profile makes it inherit again. Clearing the
instance profile leaves no instance profile, which means `legacy` until
0.1.331 (with a warning, see [the `legacy` deprecation](#the-legacy-deprecation));
set `audit` instead to keep recording. Each change is written to the audit log
(entity type `security_profile`) with the system admin who made it and the
old and new profile; the change and its record commit together.

## The `legacy` deprecation

`legacy` is deprecated in 0.1.330 and removed in 0.1.331. Use `audit`: it
keeps today's behaviour and records what `strict` would refuse.

**In 0.1.330**, `legacy` still works, and Eve says it is going:
- Setting `legacy` at any level (instance, new projects, an org, a project)
  succeeds, and the response carries `warnings`: "legacy is deprecated and is
  removed in 0.1.331; use audit". `eve system security profile legacy`
  prints it. Clearing the instance profile gives the same warning, because
  an instance with no profile resolves to `legacy`.
- `eve doctor security` lists every level that resolves to `legacy`
  (`legacy_levels` in `--json`): the instance when it has no profile or
  `legacy`, the new-project default when it is `legacy`, and each org and
  project on `legacy`, set there or inherited.
- The API and the worker log one warning at start while the instance
  resolves to `legacy`.

**In 0.1.331**, a migration turns every stored `legacy` into `audit` (orgs,
projects, the instance setting and `security.new_project_profile`), with an
audit-log entry for each; an instance with no profile resolves to `audit`;
and the API and CLI refuse `legacy` (400, naming `audit`). Such a level then
records findings, writes the `audit` NetworkPolicy pairs (nothing blocked),
reads each image's config once per service per deploy, and runs the runner
self-check in `audit` mode. Otherwise it behaves as before.

**What to do before 0.1.331:** run `eve doctor security`, and set each level
it lists to `audit` (for the instance, `eve system security profile audit`).
Rolling back from 0.1.331 to 0.1.330 is code only: 0.1.330 knows `audit`, and
former `legacy` levels stay `audit`.

## Rule sets and stamps

Each rule belongs to the rule set of the release step that brought it: the
P1 rules (0.1.326) are rule set 1, the P2 rules (0.1.327) rule set 2. A
`strict` profile is stamped with the rule set current when it was set
(`security_profile_ruleset` on orgs and projects, the system setting
`security.profile_ruleset` for the instance). A rule newer than the stamp
runs under `audit` there: it is recorded, not enforced. So a release never
starts enforcing new rules on a profile already `strict`; nothing changes
until someone moves that profile on.

- Profiles that were `strict` before stamps existed are stamped 1. A `strict`
  with no stamp reads as 1.
- Setting `strict` again stamps the current rule set, which takes the new
  rules: `eve system security profile strict --project proj_xxx`.
- A project created under `security.new_project_profile = strict` is stamped
  with the current rule set.
- `legacy` and `audit` carry no stamp.
- An org's or project's profile changed without its stamp (by a release
  before 0.1.327, after a rollback) drops the stamp, so the newer rules start
  in `audit` again on the way back up (a database trigger, migration 00120).
- The API, and the worker and orchestrator (`decideSecurityRule`), resolve
  stamps the same way. New behaviour always gets a new rule id, never a wider
  meaning for an old one, so a stamp keeps what it covered.

`eve doctor security` shows what each `strict` covers, for example
`strict (P1 rules); P2 rules on audit`.

Each rule is governed by the profile of the side it protects:
- **Identity rules** follow the instance, because the app calling them is
  the party they guard against.
- **A project's own resources** follow the project.
- **Org-wide data** follows the org.

## Findings and the report

A finding records the rule, the org and project, and who acted: a user, a
job, a service, a service principal or an app link. It never records a value,
token or request body. Findings are kept one row per rule, scope, actor and
day, with a count.

```bash
eve doctor security                       # every org and project
eve doctor security --project proj_xxx    # one project
eve doctor security --days 7 --json
```

A project whose report shows no findings for a few days of normal use can
move to `strict`. Switching back is instant: set the profile to `audit`
again.

The report also shows whether the cluster enforces NetworkPolicy (the
instance setting `network.policy_enforced`, `network` in `--json`) and, for
each project not yet `strict`, its strict checklist (`strict_checklist`):
clean when the window has no findings for it and `network.policy_enforced`
is `true`. Without enforcement, `egress.default_deny` applies its policies
and blocks nothing, so a project is not ready for `strict` until it is set.
See [egress policies](egress-policies.md#enforcement).

## Rules

Each hardening rule lists its id, its governing profile and what `strict`
changes. Rules are added release by release, one rule set per release step.

### Rule set 1 (0.1.326)

| Rule | Governs | Under `strict` |
|---|---|---|
| `jobs.run_step_change` | Project | The jobs of a workflow or pipeline run (root and compiled steps) change only through the run: changes to what they run, phase moves (including done and cancelled), `review_required`, claim, release, submit, approve and reject come only from the run's actor with their own user token, a job token of one of the run's compiled steps, or a project admin (`jobs:admin`). Adding or removing a run root's dependencies counts as a change to it. A compiled step's token may not lower `review_required` on any job. Cancelling a compiled step also cancels the steps after it in its own run, and a compiled step's failure cancels only the steps of its own run. |
| `jobs.dependency_change` | Project | The dependencies of a job outside any run change only for its actor (or their agents), its own job token, or a project admin (`jobs:admin`). |
| `jobs.approve_token` | Project | Job approve and reject, and a `PATCH` that settles a review (moving a job out of `review`, changing `review_required` while in review, or lowering `review_required` in any phase), need a person's own token: job, service, service-principal and app-link tokens get 403. |
| `pipelines.approve_token` | Project | Pipeline-run approve needs a person's own token: job, service, service-principal and app-link tokens get 403. |
| `harness.no_preference` | Project | An agent job with no harness named, no `x-eve.defaults.harness_preference` and no instance `harness_preference` fails at dispatch ("no harness configured") instead of using the built-in list. |
| `harness.missing_credential` | Project | A harness credential counts only from project, org, system or job-actor secrets, never from the orchestrator's or worker's own environment or credential files: harness preferences skip a harness without one, and an agent job whose harness is named (on the job or by its profile) fails at dispatch without one. Under `audit`, a job that runs on such a host credential is recorded. |
| `harness.missing_profile` | Project | A harness profile that is not declared, or that cannot be read, fails the manifest sync (workflow steps), the agents sync (agents and workflow steps) and dispatch (a job naming the profile). |
| `harness.missing_agent` | Project | A workflow step naming an agent that does not exist fails the agents sync and the workflow invoke, before any job is created. |
| `harness.reserved_env` | Project | Env overrides may not set names that load code or libraries (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `BASH_ENV`, `ENV`, `PYTHONPATH`, `PYTHONSTARTUP`), nor `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE` or `CURL_CA_BUNDLE` unless a single `${secret.KEY}`: job create, chat hints, workflow invoke and manifest sync refuse them (403), and the run strips them from jobs that still carry them. Names reserved on every profile are recorded under this rule when a stored job or definition carries them. |
| `harness.user_secret_routing` | Project | User-scope secrets named like model routing settings (`*_BASE_URL`, proxies, TLS trust and the other routing names) or names that load code (`NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `BASH_ENV`, `ENV`, `PYTHONPATH`, `PYTHONSTARTUP`) are left out when the project's secrets are resolved for a job; a project or org secret of the same name applies instead. |
| `ports.implicit_public` | Project | A service that lists ports and has no `x-eve.ingress` block gets no public ingress, default host, alias or domain; it needs `x-eve.ingress.public: true`, and its next deploy removes an Ingress an earlier deploy made for it. Preview URLs and `eve env diagnose` follow the same rule. |
| `access.implicit_project` | Project | An org `member` gets nothing on a project from the org role alone: rights there come from a project membership or bindings. Applies to permission checks, `eve access can`, project listing and org-wide job, event and agent queries. A binding counts only when its role belongs to the project's org and grants what the listing needs (`projects:read` for the project list and agents, `jobs:read` for jobs and job stats, `events:read` for events); an org-wide binding counts. Org owners and admins are unchanged. `eve access can` answers under this rule without recording a finding. |
| `access.unresolved_project` | Project (the project's own profile for a deleted project named by id; the instance when the project cannot be found) | A permission check for a project that cannot be looked up refuses instead of granting the member set. A failed lookup of a project or its profile is an error under every profile, never the member set. |
| `access.org_route_project` | Project | An org route that reaches a project's resource needs the right a project route would need there: org thread routes on a project's thread (`threads:read`, `threads:write`), `job_attachments:` resolution (`jobs:read` on the job's project), thread distillation (`threads:read`), and the attachments (`jobs:read`) and events (`events:read`) of org search. A refusal gets 403, or the result is left out of the search. |
| `chat.sender_rights` | Project | Chat starts agent work only for a sender who maps to an Eve user holding `jobs:write` on the project; unmapped senders are refused. |
| `access.org_data_unscoped` | Org that owns the data | A job token with no `scope` gets no org file, doc or cloud-fs access, and a job with no `scope` gets no org-fs mount from its user's bindings. |
| `access.org_data_no_user` | Org that owns the data | A job token for work no user started (event, schedule or system runs) gets no org file, doc or cloud-fs access. A workflow or pipeline step that such a run would create with org files, docs or cloud-fs in its declared `scope` is refused (400); its env-db entries stand. The orchestrator mounts no org files for such a job. |
| `access.org_data_scope_wide` | Org that owns the data | Each org file, doc or cloud-fs entry of a job scope a user declares (workflow and pipeline steps, retries), `*` included, must sit inside that user's role bindings (direct or through a group, org-wide or on the project); built-in roles do not count, except an org owner's or admin's. Otherwise 400. Pipeline steps gained the check in this release, so under `legacy` they are still not judged. |
| `access.org_data_scope_unjudged` | Org that owns the data | A job gets org files, docs or cloud-fs from its declared scope only when the API judged that scope for the user who started the work (`jobs.token_scope_judged_at`, cleared when someone else becomes the job's actor unless it is judged again for them). Otherwise the orchestrator gives the job no org-fs mount and only the env-db part of its scope, script and `run` action jobs mint their token with only the env-db part, and the API refuses the token org data. |
| `access.org_data_role_wildcard` | Org that owns the data | A built-in project role (owner, admin, member), and the org `member` role, no longer carry a wildcard scope over the org's files, docs and cloud-fs mounts; their env-db scope stands. Members reach org data only through bindings. Org owners and admins keep theirs. |
| `access.org_data_route_scope` | Org that owns the data | A check on org files, docs or cloud-fs that names no single resource is judged on what the route reaches, for people (their bindings; the org `member` role's wildcard does not count) and for job tokens (their declared `scope`). Org doc lists, queries, searches and stale listings, memory and org search, org-fs object listings, events (list and stream), links, conflicts, shares and public paths return only what the caller reaches; a share token is shown only for a path the caller reaches. Agent KV (`/agents/<slug>/kv/<namespace>/<key>`), thread distillation (the doc it writes), org-fs object listings by prefix, new shares and new public paths are judged on the path they act on. Org-fs status, device enrolment, links and conflicts with no path, share revocation and public path removal need the org's whole filesystem. Org search for a job token also keeps only its own project's attachments and events, and no org threads. Cloud-fs mount listing and default-mount reads need a `cloud_fs` entry in a token's scope, and show a person only the mounts their grants reach. |
| `sso.session_origin` | Instance | The SSO's `/session` and `/logout` serve only the Eve dashboard (no `project_id`), the SSO itself for `/logout`, and an https host of the named project with `x-eve.auth` (default environment hosts, ingress aliases, verified custom domains, manifest `allowed_redirect_origins`). Any other origin, or none, gets 403. |
| `sso.app_access` | Instance | `/session` gives an app a token only for a person its app-access policy admits; anyone else gets 403. |
| `sso.audience_token` | Instance | An app gets a one-hour audience token (`aud` `eve-app:<project>[:<env>]`, no `orgs` claim) instead of the platform token. Under `audit` each app session that would get one is recorded. |

### Rule set 2 (0.1.327)

A profile stamped 1 runs these under `audit` until `strict` is set again.

| Rule | Governs | Under `strict` |
|---|---|---|
| `secrets.value_read` | Project | Secret values are write-only through the API: `POST /projects/:id/secrets/export` gets 403. `ensure` returns a value it generates once, in its own response, and `eve github setup` returns the webhook secret only when it creates it (`secret` is `null` otherwise; `--regenerate` makes a new one). Under `audit`, each export is recorded. |
| `secrets.legacy_ciphertext` | Instance | A `v1` secret, or an integration token, OAuth client secret or Slack signing secret stored plain, is refused when read, and new writes use `v2`. Under `audit`, each such read is recorded. `eve system security profile strict` on the instance gets 409, naming the count, while any `v1` or plain rows remain: run `eve system secrets reencrypt` first (`--dry-run` shows the count), or override with `--force` (recorded in the audit log). Org and project flips are not checked. See [secrets](secrets.md#storage-at-rest). |
| `webhooks.global_secret` | Project | A GitHub webhook for a project with no `GITHUB_WEBHOOK_SECRET` of its own gets 401 instead of being verified with the instance's `EVE_GITHUB_WEBHOOK_SECRET`. Under `audit`, each delivery the global secret verifies is recorded; nothing is recorded for a signature that does not verify. Set a project secret with `eve github setup`. |
| `internal.service_key` | Instance | A call to an internal route with only the legacy `EVE_INTERNAL_API_KEY` (`x-eve-internal-token`) gets 401, at the API, the worker, the agent runtime, the orchestrator and the gateway (which asks the API, `POST /internal/security/legacy-key-calls`, since it holds no database). The gateway's and the SSO's keys work only on the routes that declare them (`@InternalCallers`); elsewhere 403. The core key works everywhere. Under `audit`, each legacy-only call and each gateway or SSO call off its routes is recorded (actor `service:legacy-key`, `service:gateway`, `service:sso`). See [internal service keys](#internal-service-keys). |
| `registry.internal_key` | Instance | The registry token endpoint refuses the internal key as a Basic password, and pull and push credentials signed with it (401). Credentials signed with `EVE_REGISTRY_CREDENTIAL_KEY` work. Under `audit`, each use of the internal key or a credential it signed is recorded. `eve system security profile strict` on the instance gets 409 while any environment's pull secret is not on the current registry key version: run `eve system security reconcile` first, or override with `--force`. See [container registry](container-registry.md#credential-key). |
| `secrets.system_scope` | Project | A system secret reaches the project's workloads and jobs only when the instance setting `secrets.system_shared_keys` names it (`eve system settings set secrets.system_shared_keys "KEY_A,KEY_B"`). Others are left out of the project and org resolves (deploys, jobs, harness checks) and of secret validation; an org or project secret of the same name still applies. Under `audit`, each resolve that delivers an unshared system secret is recorded, with the names in the finding's `keys` (`eve doctor security --json`). |
| `isolation.runner_mode` | Project | Job code runs only in credential-free runner pods ([runner pods](runner-pods.md)): agent jobs go to the worker (never the agent runtime's inline path), script steps and `action: run` run in runner pods, and a legacy pipeline-runner `run` step gets 400 ("use a `script:` step"). A runner pod mounts no org filesystem, and before it uses its job token it checks that the metadata server and the Kubernetes API are out of reach; if either answers, the job fails ("egress policy not enforced"). Outside Kubernetes such work fails ("strict needs runner pods"). Under `audit` nothing changes and each inline run is recorded (`kind` `agent`, `script`, `action_run` or `legacy_run`; an agent job asking for org files carries `strict_blocker: orgfs_mount`), and runner pods run the self-check without enforcing it. The instance switch `EVE_RUNNER_PODS_ONLY=true` gives every project the runner-pod routing (self-check under `audit`), whatever its profile. |
| `secrets.unbound_job` | Project | A job whose agent (`access.secrets`) and job (a workflow step's `secrets:`) declare no allowlist receives, in its runner pod, only its harness's provider keys and the keys its env overrides reference. The clone credential (the git token or SSH key the platform holds to clone) comes flagged `clone_only`: the runner clones with it and job code never receives it. The filter is the worker's job resolve for a runner pod (`POST /internal/projects/:id/secrets/resolve` with `bound: true`, which also resolves user secrets for the job's own actor, never a caller-supplied user). Under `audit`, each unbound job is recorded with `withheld` (the names `strict` leaves out); a runner resolve's finding says `bound_resolve: true`, an inline resolve's `filtered: false`. See [runner pods](runner-pods.md#secrets). |
| `isolation.pod_security` | Project | Tenant pods and service job pods (migrations) run with the restricted Pod Security context: `seccompProfile: RuntimeDefault`, no service account token, no privilege escalation, all capabilities dropped, `runAsNonRoot` and a numeric `runAsUser` (and `runAsGroup`). The user comes from `x-eve.security.run_as_user` and `run_as_group`, else from the image config's numeric `USER` (`uid` or `uid:gid`, read with `crane config` using the env's pull credentials). A `USER` that is a name, root or unset, or an image config that cannot be read, refuses the deploy or job, naming those fields: the kubelet cannot check `runAsNonRoot` against a name. Opt-outs: `x-eve.security.run_as_root: true`, and `x-eve.security.capabilities` from `NET_BIND_SERVICE`, `CHOWN`, `SETUID`, `SETGID` and `DAC_OVERRIDE`. `x-eve.networking.egress: stable` (host network) is refused. The namespace gets the Pod Security `warn` and `audit` labels at `restricted`, or `baseline` once a service opts out (anything beyond `NET_BIND_SERVICE`, or root); never `enforce`. Under `audit` nothing changes, and each service is recorded with its image user (`root`, `empty`, `numeric`, `name` or `unknown`), ports below 1024, the controls `strict` would add and the blocker `strict` would hit (`named_user`, `root_user`, `unknown_user`, `stable_egress`). See [manifest](manifest.md#x-evesecurity). |
| `access.operator_rights` | Project | The operator rights `secrets:use` and `envdb:export` come only from admin and owner roles, bindings and custom roles, and `jobs:harness_override` leaves the member role and the default job permissions (a job token keeps it only when its agent's `access.permissions` or the job's own token permissions declare it). Outside `strict`, `secrets:read` stands for `secrets:use` and `envdb:read` for `envdb:export`, and the member role and default job permissions carry `jobs:harness_override`; under `audit` each use of a read right as the operator right, and each request that rests on the member role's `jobs:harness_override`, is recorded. `eve access can` and `explain` answer the same way. See [permissions](auth.md#operator-rights). |
| `secrets.use` | Project | Starting work bound to a secret beyond its harness credential needs `secrets:use`: job create, workflow invoke and chat (the sender the gateway mapped, or no one). The binding is what the declared allowlists name (the agent's `access.secrets`, a workflow step's `secrets:`, the starting job token's allowlist), plus the keys env overrides reference, less the harness's provider keys. A job with no allowlist counts only its references; a clone credential is never declared, so never counts. A workflow is judged once, before any job exists; a chat listener the sender may not start is skipped, not the whole dispatch. Work no caller starts (triggers, schedules) was authorised by the manifest sync. Under `audit`, a starter with neither `secrets:use` nor `secrets:read` is recorded, with the bound names. |
| `envdb.export` | Project | `GET /projects/:id/envs/:name/db/snapshots/:snapshotId/download` (a full dump, presigned for an hour) needs `envdb:export`; `envdb:read` still lists and shows snapshots. |
| `secrets.job_org_write` | Project | A job or service token may not write a secret at org scope, which other projects share. The org secret routes refuse those tokens on every profile; this rule governs the harness credential write-back, which may update only a project-scope copy (`SecretsService.mayJobWriteSecret`). Keep a project-scope copy of a credential a strict project's jobs refresh (for example `CODEX_AUTH_JSON_B64`). Under `audit`, each org-scope write is recorded. |
| `egress.default_deny` | Project | The project's env namespaces hold only `eve-egress` (DNS, the namespace itself, the API's public port, the ingress controller, the internet outside private ranges and `network.private_cidrs`, and the env's managed databases and app-link producers) and `eve-egress-metadata` (the metadata server, for Workload Identity pods only); its runner pods get `eve-runner-<project>` (the same base, its own env namespaces and its producers). Under `audit` an allow-all companion sits beside each (`eve-egress-audit`, `eve-runner-<project>-audit`), so nothing is blocked; under `legacy` env namespaces get none and runner pods get the companion alone. A profile change reconciles the project at once. Under `audit` nothing is recorded per connection: compare allowed-flow logs with the strict set. See [egress policies](egress-policies.md). |
| `harness.checkout_settings` | Project | Settings the checkout supplies cannot reroute the harness's model traffic, or hand its credential to a place the checkout names. **Refused** (the run fails, naming the file and setting, never a value): a Claude Code config directory inside the checkout whose `settings.json` sets a routing name (`*_BASE_URL`, proxies, TLS trust, `NODE_OPTIONS`, the code-loading names), or `apiKeyHelper`; a Codex project `.codex/config.toml`, or `config.toml` in a config home inside the checkout, that sets the top-level `profile`, `model_provider`, a `model_providers` entry, any `*base_url`, or an env override with a routing name (what `shell_environment_policy` lets shell commands inherit is left to egress allow lists: Codex passes its whole environment to them by default); any `.env` in a Codex config home inside the checkout (variant homes included), whatever it holds, since Codex expands `${NAME}` in it; routing names in `.gemini/.env`; a checkout MCP server handed a credential of the running harness or of Eve (the job token, app link tokens, internal keys) or a routing name, by Codex's `env_vars`, `bearer_token_env_var`, `env_http_headers` or an `auth` other than `oauth`, or by a `$NAME` or `${NAME}` reference in Claude Code's `.mcp.json` or the config directory's `.claude.json`; any string in Gemini's `.gemini/settings.json` that references one; a checkout settings file the scan cannot parse; and the `code` and `pi` harnesses, which have no confirmed mechanism. Another harness's key or Eve's plain settings (`EVE_API_URL`, `EVE_PROJECT_ID`) are the project's own and are not refused. **Kept out without refusing:** Claude Code reads a cleaned copy of the project and local settings through `--settings` with `--setting-sources user`, Eve's copy of `.agent/harnesses/<harness>/` is cleaned in place; Codex gets `-c model_provider="openai"` (and the variant profile's); Gemini gets an Eve-owned system settings file excluding the project `.env`'s routing names. No checkout file is edited. Under `audit`, each finding is recorded with the files and names, never values. **Not covered:** job code that sends a credential out itself, through its shell, hooks, MCP servers or plugins. That is credential exfiltration, accepted until host egress allow lists (`egress.allow_hosts`, rule set 3) close it. See [harness execution](harness-execution.md#checkout-settings). |

Always on in 0.1.327, whatever the profile: runner pods fail closed
(the static `eve-runner-deny` allows a runner pod only DNS and the API's
public port until its project's policy adds more) and take connections only
from the worker on the submit port (`eve-runner-ingress`); apps and runner
pods get the API's public port as `EVE_API_URL` (`EVE_API_APP_URL`), never
the internal one; read-only SQL (`eve db sql`
without `--write`) runs one statement on the extended protocol, so a
statement list gets 400 instead of being able to commit the read-only
transaction and write after it; reads of both ciphertext formats
and of sealed or plain OAuth columns; masks that show no character of a
value; OAuth state stored with its expiry and bound to the user (or
signed-link install cookie) that started the install; per-service Secrets:
resolved `${secret.*}` and `${managed.*}` values, `EVE_SERVICE_TOKEN` and
app-link tokens reach a service through its own Secret and `secretKeyRef`,
never inline in the Deployment or Job (see
[deployment](deployment.md#service-secrets)); the internal service
keys below, with each platform service holding only the platform secrets it
reads; registry credentials signed with their own key; and service tokens
clamped to the manifest: `POST /internal/auth/mint-service-token` grants at
most `DEFAULT_SERVICE_PERMISSIONS` plus the service's `x-eve.permissions` in
the manifest of the release being deployed (or the env's current release),
for an env that exists in the project of a project in the org (404
otherwise).

### Rule set 3 (0.1.328)

A profile stamped 1 or 2 runs these under `audit` until `strict` is set again.

| Rule | Governs | Under `strict` |
|---|---|---|
| `auth.nip98_public_url` | Instance | A Nostr NIP-98 request is refused when the API has no `EVE_PUBLIC_API_URL`. With it, the signed URL is always checked against that origin, never the request's `Host` or `X-Forwarded-*` headers (always on). Under `audit`, each NIP-98 request checked against header-derived host names is recorded. |
| `egress.allow_hosts` | Project | The project's runner pods and env pods reach on the internet only the hosts it declares (`x-eve.egress.hosts`, project list and service lists), the harness model APIs and the git host (runners only): the internet rule and the allow-all companions of `egress.default_deny` are left out, and with `EVE_EGRESS_FQDN_PROVIDER=gke` the worker writes one GKE `FQDNNetworkPolicy` per host. With no provider (`none`, the default), deploys, service jobs and job dispatch fail with "egress allow lists need a provider (EVE_EGRESS_FQDN_PROVIDER)". Under `audit` the FQDN policies are written beside the companions, so nothing is blocked, and each deploy and reconcile records a project with no declared hosts (`no_declared_hosts`) or no provider (`no_provider`). IP filtering lets other hosts on the same addresses through, and DNS lookups succeed for any name. See [egress policies](egress-policies.md#host-allow-lists). |
| `network.ingress_isolation` | Project | Each env namespace holds `eve-ingress`, which admits to every pod only the API (`app.kubernetes.io/name: eve-api` in the platform namespace; no other platform pod) and the project's own env namespaces and runner pods; and one `eve-ingress-svc-<service>` per service, which admits to that service's pods only the ingress controller (when the service has an Ingress, on the port it routes to) and the env namespaces and runner pods of projects consuming it through an app link with a live API grant for that env (on the link's port). NetworkPolicies add up, so under `strict` these widen, within the namespace, a project's own ingress policies: a project that restricts traffic between its own pods keeps that only for pods Eve's allows do not select, and `eve-ingress` selects every pod. Under `audit` Eve writes no ingress policies (findings only: each deploy, service job and reconcile records what `strict` would write) and removes any it wrote, never one the project wrote; under `legacy` there are none. Public TCP listeners (`x-eve.tcp_ingress`) are not admitted under `strict`. See [egress policies](egress-policies.md#ingress-isolation). |
| `isolation.pod_security_admission` | Project | Env namespaces carry Pod Security `enforce` at their level (`restricted`, or `baseline` after an `isolation.pod_security` opt-out by any service or service job), set after each deploy's rollout has succeeded and pinned to `EVE_POD_SECURITY_VERSION` (default `v1.30`); `warn` and `audit` are set before the workloads, and a failure to set them stops the deploy. Under `audit` they carry `warn` and `audit` only, and each deploy is recorded with the env and level. Under `audit` and `legacy` an `enforce` Eve set is removed at the next deploy; one it did not set stays. See [deployment](deployment.md#pod-security). |
| `managed_db.owner_url` | Project | A long-running service that reads the managed database owner's credential (`${managed.<db>.url}` or `${managed.<db>.password}` in its environment, command or entrypoint) is refused at deploy, naming the declared-role form `${managed.<db>.roles.<role>.url}`. Job services (migrations) still receive it, and the non-secret parts (host, port, database, username) are unaffected. Under `audit`, each such service is recorded at each deploy. |

Always on in 0.1.328, whatever the profile: the worker's rights end at the
namespaces it manages (labelled `eve.horizon/managed=true`, with a
RoleBinding to `eve-worker-tenant`), and the template's admission policy
holds its writes there (see [deployment](deployment.md#worker-rights));
each managed database accepts
only its own logins (`CONNECT` is revoked from `PUBLIC`; the owner keeps it
by ownership and declared roles by grant), every login without a
connection limit gets its class's limit (25, 100 or 200), and the database
as a whole across all its logins gets its class maximum plus a platform
reserve of 5 for Eve's own connections (30, 105 or 205; set only when there
is none, so an operator's limit stays), applied at provisioning, when a
change to the tenant finishes and once to existing tenants when the
orchestrator starts (run the pre-check in
[connection limits](db.md#connection-limits) before the deploy). A login
limit an operator set is never changed. A managed
database declares at most 8 roles. `eve db reset` and `wipe` reinstall
the extensions that lived in `public` and the declared roles' grants, in the
same transaction as the drop. `eve db sql` reports an error in the tenant's
own SQL as 400 with the Postgres code and message. Deleting an environment
queues its managed databases for drop instead of failing on them or
removing their rows (a forced delete no longer leaves the database behind),
new managed databases carry the environment id in their name, a destroyed
database is provisioned afresh on the next deploy, a failed drop is retried
for a day (after a wait that doubles with the time since the delete, from 1
minute to at most an hour), a database deleted while it was being provisioned
or changed is still dropped, and a pre-delete snapshot that was asked for and
fails keeps the database. Only the local provider provisions; any other fails with
`provider_unsupported`.

### Rule set 4 (0.1.329)

A profile stamped 1, 2 or 3 runs these under `audit` until `strict` is set again.

| Rule | Governs | Under `strict` |
|---|---|---|
| `manifest.approval_unenforced` | Project | Manifest sync refuses (400) a manifest whose `environments.<env>.approval` asks for a gate (any value but `none`, in any case, or blank), with "Environment approval gates are not enforced by Eve. Remove `approval` from environments.<env>." Eve has no deploy approval gate: deploys to the environment never waited for a person. Under `audit` the manifest syncs with that text in its warnings and the environments are recorded; under `legacy`, the warning only. |

### Rule set 5 (0.1.336)

A profile stamped 1 to 4 runs this under `audit` until `strict` is set again.

| Rule | Governs | Under `strict` |
|---|---|---|
| `jobs.token_read_scope` | Project | A job token reads (GET) only the jobs of its own job tree, its root and every job under it, parents and siblings included (job ids are hierarchical: `proj-1a2b3c4d.2.1` is in the tree of `proj-1a2b3c4d`), and the other steps of its own pipeline run. Any other job in its project gets 403 on `/jobs/:job_id` and every route under it (attempts, logs, results, receipts, streams). Under `audit` the read is allowed and recorded with the reader and the job; under `legacy`, allowed. A job token never reached another project's jobs. Writes are held by their own rules (`jobs.run_step_change`, `jobs.dependency_change`). |

### Internal service keys

Platform services call each other with a key per service, sent as
`x-eve-service-key: <service>.<key>`:

| Key | Held by | Accepted |
|---|---|---|
| `EVE_INTERNAL_CORE_KEY` (`core`) | API, worker, orchestrator, agent runtime | On every internal route, and by the worker, agent runtime and orchestrator. They all hold the database URL, so separate keys between them would add no wall. Never sent to the gateway, which refuses it. |
| `EVE_INTERNAL_GATEWAY_KEY` (`gateway`) | Gateway | By the API, on the routes the gateway calls. |
| `EVE_INTERNAL_SSO_KEY` (`sso`) | SSO | By the API, on `magic-link-wrap/inspect` and `consume`. |
| `EVE_INTERNAL_DELIVER_KEY` (`deliver`) | API | By the gateway only, on `/internal/deliver` and simulate. |

A callee that accepts a key without holding it holds its SHA-256 instead:
`EVE_INTERNAL_CALLER_HASHES=core:<hex>,gateway:<hex>,sso:<hex>,deliver:<hex>`
(the API needs the gateway and SSO hashes, the gateway the deliver hash). It
cannot act as those callers. Runner pods get only the core key's hash, to
accept the worker's submissions.

**Upgrade order does not matter.** While a service still holds the legacy
`EVE_INTERNAL_API_KEY`, it also sends `x-eve-internal-token`, so a callee not
yet upgraded keeps working; a callee that cannot verify a service key yet
(its hashes not set) falls back to the legacy key. A call carrying both is
judged on the service key. Removing the legacy key from a service's env stops
it sending and accepting it.

**Removing the legacy key.** Remove `EVE_INTERNAL_API_KEY` only when
`eve doctor security` shows no `internal.service_key` findings from
`service:legacy-key` and no environment on an older registry key version,
the same gate as `registry.internal_key`: until then, pull secrets signed with
it still depend on it. Tokens the API signs for itself (identity link tokens,
Slack install links, org filesystem link tokens without
`EVE_ORG_FS_LINK_TOKEN_SECRET`) are signed with keys derived from the core
key once it is set, and those signed with the legacy key keep verifying only
while it is set; the SSO keys its sign-in forms with its own key the same way.

### Reconcile

`eve system security reconcile` (`POST /system/security/reconcile`, system
admins) brings environments in line with the profiles without restarting
anything. In 0.1.327 it writes every environment's and project's egress
policies for `egress.default_deny` and removes the runner policies of deleted
projects (see [egress policies](egress-policies.md)), then re-signs each
environment's registry pull secret with the current registry credential key
(the internal key when none is set, the way back before a rollback) and
records the key version (see
[container registry](container-registry.md#credential-key)), and renders the
runner templates and warm pools from the instance settings (see
[runner pods](runner-pods.md); a no-op without the agent-sandbox CRDs).

Setting the profile of a project, an org or the instance also reconciles the
egress policies of the projects in scope, so their allow-all companions go
(or come back) at once rather than at the next deploy. The profile stands if
the worker cannot be reached; the response's `network` says so, and
`eve system security reconcile` finishes the job.
