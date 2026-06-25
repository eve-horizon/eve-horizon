# Scenario 54: Workflow Script App Links

**Time:** ~5 minutes
**Parallel Safe:** No, uses the shared local k3d mesh workspace
**LLM Required:** No

Validates that workflow `script:` jobs receive `EVE_APP_LINK_*` variables for
`inject_into.jobs: true` subscriptions. Covers manual invoke, a dependent script
step, and a cron/event-triggered workflow run. Token values must stay redacted in
job logs.

## Prerequisites

- Local k3d stack is running and this checkout owns it.
- `EVE_API_URL=http://api.eve.lvh.me`.
- `eve auth status` is authenticated against the local API.
- Scenario 44 fixtures are available under `tests/manual/fixtures/local-mesh/`.

## Setup

```bash
export EVE_API_URL=http://api.eve.lvh.me
eve system health --json
eve org ensure manual-test-org --slug mto --json

eve local mesh init lmesh-workflow-links --org org_manualtestorg --env local --force
eve local mesh add prod --path tests/manual/fixtures/local-mesh/producer
eve local mesh add cons --path tests/manual/fixtures/local-mesh/consumer
eve local mesh up
```

Find the consumer project:

```bash
CONSUMER_PROJECT_ID=$(eve local mesh status --workspace lmesh-workflow-links --json | jq -r '.results[] | select(.project=="cons") | .project_id')
```

k8s script execution cannot clone `file://` project repo URLs. If `mesh up`
created the consumer with a local repo URL, point only that project at a small
cloneable repository before invoking the workflow:

```bash
eve project update "$CONSUMER_PROJECT_ID" \
  --repo-url https://github.com/octocat/Hello-World.git \
  --json
```

## Manual Invoke

```bash
eve workflow invoke load-sandbox --project "$CONSUMER_PROJECT_ID" \
  --env-override LOAD_API_URL= \
  --env-override LOAD_INGEST_API_URL= \
  --json
```

Capture the root job id from the response:

```bash
ROOT=<root-job-id>
eve job show "${ROOT}.1" --json | jq '.env_name, .hints.resolved_app_links'
eve job logs "${ROOT}.1"
eve job result "${ROOT}.1"
```

Expected:

- `.env_name` is `"local"`.
- `.hints.resolved_app_links` contains `observation` and `observation-ingest`.
- Logs show both `_API_URL` vars and `_TOKEN=<redacted:true>`.
- Logs show `LOAD_API_URL=` and `LOAD_INGEST_API_URL=` blank.
- Logs do not contain raw token values.
- The `smoke` and `dependent` script steps both succeed.

## Cron/Event Path

> **Note**: the fixture's cron schedule is intentionally `0 0 30 2 *` (February 30
> — never fires). Manifest cron triggers are registered platform-wide by the
> orchestrator at startup with no disable lever, so an every-minute schedule in a
> fixture floods the stack with jobs forever. The cron/event path below exercises
> the trigger by emitting the matching `cron.tick` event manually.

```bash
eve event emit --project "$CONSUMER_PROJECT_ID" \
  --type cron.tick \
  --source cron \
  --payload '{"schedule":"0 0 30 2 *","trigger_name":"load-sandbox"}' \
  --json
```

Wait for the workflow root, then repeat the child inspection for the event-created
root job:

```bash
eve job list --project "$CONSUMER_PROJECT_ID" --since 10m --json
EVENT_ROOT=<event-root-job-id>
eve job show "${EVENT_ROOT}.1" --json | jq '.env_name, .hints.resolved_app_links'
eve job logs "${EVENT_ROOT}.1"
eve job logs "${EVENT_ROOT}.2"
```

Expected: the event path has the same app-link env vars, redacted token markers,
and successful `smoke` + `dependent` script steps as manual invoke.

## Cleanup

```bash
eve local mesh down --workspace lmesh-workflow-links
```
