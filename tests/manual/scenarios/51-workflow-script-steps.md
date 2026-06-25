# Scenario 51: Workflow Script Steps

**Time:** ~2 minutes
**Parallel Safe:** Yes
**LLM Required:** No

Validates that manifest workflow `script:` and shorthand `run:` steps
materialize as script child jobs, not agent jobs.

## Prerequisites

- Local k3d stack is running.
- `eve auth status` is authenticated against the local API.

## Setup

```bash
export ORG_ID=org_manualtestorg

eve project ensure \
  --org $ORG_ID \
  --name workflow-script-steps \
  --slug workflow-script-steps \
  --repo-url https://github.com/test/workflow-script-steps \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>
```

Create a temporary project manifest and sync it:

```yaml
name: workflow-script-steps
services:
  api:
    image: test/api:latest
workflows:
  setup-review:
    permissions: [jobs:read]
    steps:
      - name: setup
        script:
          run: "echo setup && eve job current --json"
          timeout_seconds: 60
      - name: shorthand
        depends_on: [setup]
        run: "echo shorthand"
      - name: review
        depends_on: [shorthand]
        agent:
          prompt: "Review the setup output"
```

## Steps

### 1. Invoke Workflow

```bash
eve workflow run $PROJECT_ID setup-review --json
```

**Expected:**
- Response includes one root job and three `step_jobs`.
- `review.depends_on` contains `shorthand`.

### 2. Inspect Step Jobs

```bash
eve job show <setup_job_id> --json
eve job show <shorthand_job_id> --json
eve job show <review_job_id> --json
```

**Expected:**
- `setup.execution_type` is `script`.
- `setup.script_command` is `echo setup && eve job current --json`.
- `setup.script_timeout_seconds` is `60`.
- `shorthand.execution_type` is `script`.
- `shorthand.script_command` is `echo shorthand`.
- `review.execution_type` is `agent`.

## Success Criteria

- [ ] Workflow script steps create script child jobs.
- [ ] Script command and timeout are persisted on the job.
- [ ] Agent steps still create agent child jobs.
- [ ] `depends_on` edges are preserved across mixed step kinds.
