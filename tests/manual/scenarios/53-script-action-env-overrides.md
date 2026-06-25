# Scenario 53: Script and Action-Run Env Overrides

**Time:** ~5 minutes
**Parallel Safe:** Yes
**LLM Required:** No

Validates that workflow `script:` steps and pipeline `action: { type: run }`
steps receive persisted `env_overrides` as bash environment variables, including
`${secret.KEY}` interpolation, missing-secret failure, and reserved-key
defensive stripping.

## Prerequisites

- Local k3d stack is running and freshly deployed.
- `eve auth status` is authenticated against `http://api.eve.lvh.me`.
- Test org exists:
  ```bash
  export EVE_API_URL=http://api.eve.lvh.me
  eve org ensure "manual-test-org" --slug mto --json | tee /tmp/saeo-org.json
  export ORG_ID=$(jq -r '.id' /tmp/saeo-org.json)
  ```

## Setup

```bash
eve project ensure \
  --org $ORG_ID \
  --name script-action-env-overrides \
  --slug saeo \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json | tee /tmp/saeo-project.json
export PROJECT_ID=$(jq -r '.id' /tmp/saeo-project.json)

eve secrets set SAEO_TOKEN "resolved-secret-value" --project $PROJECT_ID
```

Sync a manifest with one workflow and one pipeline:

```bash
export SAEO_MANIFEST_DIR=$(mktemp -d)
mkdir -p "$SAEO_MANIFEST_DIR/.eve"
cat > "$SAEO_MANIFEST_DIR/.eve/manifest.yaml" <<'YAML'
name: script-action-env-overrides
workflows:
  env-smoke:
    env_overrides:
      TARGET_PATH: "/expected/path"
      TOKEN: ${secret.SAEO_TOKEN}
    steps:
      - name: script-env
        script:
          run: |
            test "$TARGET_PATH" = "/expected/path"
            test "$TOKEN" = "resolved-secret-value"
            echo "script env ok"
  missing-secret:
    env_overrides:
      TOKEN: ${secret.SAEO_NOT_SET}
    steps:
      - name: should-not-run
        script:
          run: "echo should-not-run"
pipelines:
  action-env-smoke:
    env_overrides:
      PIPELINE_VALUE: "pipeline"
    steps:
      - name: action-run
        env_overrides:
          PIPELINE_VALUE: "step"
        action:
          type: run
          command: |
            test "$PIPELINE_VALUE" = "step"
            echo "action env ok"
YAML

eve project sync --project "$PROJECT_ID" --dir "$SAEO_MANIFEST_DIR" --json
```

## Steps

### 1. Workflow script receives literal and secret overrides

```bash
eve workflow run $PROJECT_ID env-smoke --json | tee /tmp/saeo-workflow.json
export SCRIPT_JOB_ID=$(jq -r '.step_jobs[] | select(.step_name=="script-env") | .job_id' /tmp/saeo-workflow.json)
eve job wait $SCRIPT_JOB_ID --timeout 180
eve job logs $SCRIPT_JOB_ID --json | jq '.[] | select(.type=="output" or .type=="status")'
```

Expected:
- Step job phase is `done`.
- Output includes `script env ok`.
- Status logs include `Applied env_overrides`.
- `eve job show $SCRIPT_JOB_ID --json | jq '.env_overrides.TOKEN'` returns `"${secret.SAEO_TOKEN}"`, not the resolved value.

### 2. Missing secret fails before bash

```bash
eve workflow run $PROJECT_ID missing-secret --json | tee /tmp/saeo-missing.json
export MISSING_JOB_ID=$(jq -r '.step_jobs[] | select(.step_name=="should-not-run") | .job_id' /tmp/saeo-missing.json)
eve job wait $MISSING_JOB_ID --timeout 120 || true
eve job logs $MISSING_JOB_ID --json | jq '.[] | select(.type=="error")'
```

Expected:
- Error log includes `code: "missing_secret_override"` and `SAEO_NOT_SET`.
- Output does not include `should-not-run`.

### 3. Pipeline action-run receives merged overrides

```bash
export REF=$(git ls-remote https://github.com/eve-horizon/eve-horizon-fullstack-example refs/heads/main | awk '{print $1}')
eve pipeline run action-env-smoke --ref "$REF" --project "$PROJECT_ID" --only action-run --json | tee /tmp/saeo-pipeline.json
export ACTION_JOB_ID=$(jq -r '.jobs[] | select(.step_name=="action-run") | .id' /tmp/saeo-pipeline.json)
eve job wait $ACTION_JOB_ID --timeout 180
eve job logs $ACTION_JOB_ID --json | jq '.[] | select(.type=="output" or .type=="status")'
```

Expected:
- Action job phase is `done`.
- Output includes `action env ok`.
- `eve job show $ACTION_JOB_ID --json | jq '.env_overrides.PIPELINE_VALUE'` returns `"step"`.

## Success Criteria

- Workflow script step sees literal and `${secret.KEY}` env overrides.
- Missing workflow script secret fails with `missing_secret_override` before bash output.
- Pipeline action-run persists step-over-pipeline overrides and sees them in bash.
- Persisted job rows preserve unresolved placeholder text.
