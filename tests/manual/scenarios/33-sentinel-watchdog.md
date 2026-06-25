# Scenario 33: Sentinel Watchdog

**Time:** ~8-10 minutes
**Parallel Safe:** No
**LLM Required:** No

End-to-end validation of Platform Sentinel on the local k3d stack: watchdog detection, circuit-breaker behaviour, CLI reporting, and optional internal responder checks.

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| Watchdog can be enabled locally | Setup |
| Healthy environment detection | Phase 1 |
| CrashLoopBackOff detection | Phase 2 |
| ImagePullBackOff detection | Phase 3 |
| Circuit-breaker scale-to-zero | Phase 4 |
| Recovery detection | Phase 5 |
| `eve system env-health` output | Phases 1-5 |
| Internal responder keyword handling | Optional appendix |

## Prerequisites

- Local k3d stack running: `./bin/eh k8s deploy`
- `export EVE_API_URL=http://api.eve.lvh.me`
- Authenticated as local system admin:
  ```bash
  eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
  ```
- `jq` installed
- Local CLI built:
  ```bash
  pnpm build
  ```
- A deployed test environment exists
  - Recommended: run Scenario 05 first, or deploy a test app before starting this scenario

## Setup

```bash
export EVE_API_URL=${EVE_API_URL:-http://api.eve.lvh.me}
export ORG_ID=${ORG_ID:-org_manualtestorg}

eve_local() { node "$(pwd)/packages/cli/dist/index.js" "$@"; }
EVE=eve_local

# Ensure the watchdog is enabled on the local orchestrator.
kubectl -n eve set env deployment/eve-orchestrator \
  EVE_ENV_HEALTH_ENABLED=true \
  EVE_ENV_HEALTH_STABLE_TICKS=2

kubectl -n eve rollout status deployment/eve-orchestrator --timeout=120s

# Ensure or reuse a deployed test project/environment.
PROJECT_ID=$($EVE project ensure \
  --org "$ORG_ID" \
  --name "sentinel-watchdog" \
  --slug swdg \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter \
  --branch main \
  --force \
  --json | jq -r '.id')

# If the environment is not already deployed, deploy it now.
$EVE env deploy "$PROJECT_ID" test --ref main --wait --json || true

ENV_JSON=$($EVE env show "$PROJECT_ID" test --json)
ENV_NS=$(echo "$ENV_JSON" | jq -r '.namespace')

echo "Project: $PROJECT_ID"
echo "Namespace: $ENV_NS"
test -n "$ENV_NS"
```

## Phase 1: Healthy Detection

Wait for two watchdog ticks after enabling the orchestrator env var.

```bash
sleep 240
$EVE system env-health --json | jq '.summary'
```

**Expected:**
- The command succeeds
- The test environment appears in the output
- The environment is `healthy` before injecting failures

## Phase 2: CrashLoopBackOff Detection

Inject a crashing deployment into the environment namespace. The sentinel watchdog only watches pods labeled with the project ID and environment name, so keep those labels.

```bash
kubectl apply -n "$ENV_NS" -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sentinel-crashloop-test
  labels:
    eve.project_id: "$PROJECT_ID"
    eve.env: "test"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sentinel-crashloop-test
  template:
    metadata:
      labels:
        app: sentinel-crashloop-test
        eve.project_id: "$PROJECT_ID"
        eve.env: "test"
    spec:
      containers:
        - name: crasher
          image: busybox:1.36
          command: ["/bin/sh", "-c", "exit 1"]
EOF
```

Wait for the pod to enter `CrashLoopBackOff`, then wait for the next watchdog tick:

```bash
kubectl -n "$ENV_NS" get pods
sleep 150
$EVE system env-health --json | jq '.environments[] | select(.environment_id != null) | select(.issues_json != null)'
```

**Expected:**
- The injected pod enters `CrashLoopBackOff`
- `eve system env-health --json` shows a non-healthy status for the environment
- `issues_json` includes `crash_loop_backoff`

## Phase 3: ImagePullBackOff Detection

Inject a broken image pull into the same namespace.

```bash
kubectl apply -n "$ENV_NS" -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sentinel-imagepull-test
  labels:
    eve.project_id: "$PROJECT_ID"
    eve.env: "test"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sentinel-imagepull-test
  template:
    metadata:
      labels:
        app: sentinel-imagepull-test
        eve.project_id: "$PROJECT_ID"
        eve.env: "test"
    spec:
      containers:
        - name: puller
          image: nonexistent-registry.invalid/no-such-image:v999
          imagePullPolicy: Always
EOF
```

Wait for the next watchdog tick:

```bash
sleep 150
$EVE system env-health --json | jq '.environments[] | select(.issues_json != null) | {environment_slug, status, issues_json, consecutive_degraded_ticks}'
```

**Expected:**
- The environment remains non-healthy
- `issues_json` now includes both the crash loop and image pull issues

## Phase 4: Circuit-Breaker

Wait until the environment has been degraded for at least the configured stable tick threshold.

```bash
sleep 150
$EVE system env-health --json | jq '.environments[] | {environment_slug, status, consecutive_degraded_ticks, actions_taken_json}'
kubectl -n "$ENV_NS" get deployments
```

**Expected:**
- `consecutive_degraded_ticks` reaches at least `2`
- `actions_taken_json` includes `scale_to_zero`
- `sentinel-crashloop-test` and `sentinel-imagepull-test` are scaled to zero
- The app's healthy deployment is not scaled to zero

## Phase 5: Recovery

Remove the broken deployments and wait for the watchdog to observe recovery.

```bash
kubectl -n "$ENV_NS" delete deployment sentinel-crashloop-test sentinel-imagepull-test
sleep 150
$EVE system env-health --json | jq '.environments[] | {environment_slug, status, consecutive_degraded_ticks, actions_taken_json}'
```

**Expected:**
- The environment returns to `healthy`
- `consecutive_degraded_ticks` resets to `0`
- No failing test deployments remain in the namespace

## Success Criteria

- [ ] Watchdog enabled successfully on the local orchestrator
- [ ] Healthy environment detected before failure injection
- [ ] CrashLoopBackOff issue detected
- [ ] ImagePullBackOff issue detected
- [ ] Circuit-breaker scales only the failing deployments to zero
- [ ] Recovery returns the environment to `healthy`
- [ ] `eve system env-health` reflects each phase accurately

## Optional Appendix: Internal Responder Check

This does not require Slack. It validates the responder endpoint directly using the in-cluster internal API key.

```bash
INTERNAL_TOKEN=$(kubectl -n eve get secret eve-app -o jsonpath='{.data.EVE_INTERNAL_API_KEY}' | base64 -d)

curl -s -X POST http://api.eve.lvh.me/internal/platform-respond \
  -H "Content-Type: application/json" \
  -H "x-eve-internal-token: $INTERNAL_TOKEN" \
  -d '{"text":"health","channel_id":"C_TEST","thread_ts":"1234.5678"}' | jq .
```

**Expected:**
- Returns HTTP 200
- The response includes formatted markdown health text

## Cleanup

```bash
kubectl -n "$ENV_NS" delete deployment sentinel-crashloop-test sentinel-imagepull-test 2>/dev/null || true
kubectl -n eve set env deployment/eve-orchestrator \
  EVE_ENV_HEALTH_ENABLED- \
  EVE_ENV_HEALTH_STABLE_TICKS-
kubectl -n eve rollout status deployment/eve-orchestrator --timeout=120s
```

If you enabled the watchdog only for this test, unset the env vars afterward:

```bash
kubectl -n eve set env deployment/eve-orchestrator EVE_ENV_HEALTH_ENABLED- EVE_ENV_HEALTH_STABLE_TICKS-
kubectl -n eve rollout status deployment/eve-orchestrator --timeout=120s
```
