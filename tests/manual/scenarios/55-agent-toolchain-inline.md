# Scenario 55: Agent Toolchain Inline Runtime

**Time:** ~4-6 minutes
**Parallel Safe:** Yes
**LLM Required:** Yes

Validates that an agent workflow step declaring `toolchains: [python]` runs in
the default inline agent-runtime path with `python3` available to the harness.

## Prerequisites

- Local k3d stack is rebuilt and healthy.
- Toolchain images are pushed to the local in-cluster registry.
- `eve auth status` is authenticated against the local API.
- Manual test org secrets include a working harness credential.

## Setup

```bash
export ORG_ID=org_manualtestorg

eve project ensure \
  --org $ORG_ID \
  --name agent-toolchain-inline \
  --slug atinline \
  --repo-url https://github.com/octocat/Hello-World.git \
  --branch master \
  --force \
  --json
export PROJECT_ID=<id_from_output>
```

Create or update the project manifest:

```yaml
name: agent-toolchain-inline
workflows:
  python-inline-smoke:
    steps:
      - name: python-proof
        harness: claude
        toolchains: [python]
        agent:
          name: python_smoke
          prompt: |
            Run `python3 --version`.
            Report the observed version.
```

Create a minimal named agent config so the workflow does not inherit unrelated
default AgentPack state:

```yaml
# agents/agents.yaml
version: 1
agents:
  python_smoke:
    slug: py-smoke
    description: Minimal manual-test agent for inline Python toolchain verification.
    skill: python-smoke
    workflow: assistant
    policies:
      permission_policy: auto_edit
```

```yaml
# agents/teams.yaml
version: 1
teams: {}
```

```yaml
# agents/chat.yaml
version: 1
routes: []
```

Commit the temporary manifest/config repo so `eve project sync --local` can
record a git SHA, then sync it:

```bash
eve project sync --project $PROJECT_ID --dir <manifest_repo_dir> --local --allow-dirty --json
```

## Steps

### 1. Invoke Workflow

```bash
eve workflow run $PROJECT_ID python-inline-smoke --json
export ROOT_JOB_ID=<root_job_id_from_output>
```

**Expected:**
- Response includes a root job and one agent step job.
- The step job has `hints.toolchains: ["python"]`.

### 2. Wait For Completion

```bash
eve job wait $ROOT_JOB_ID --timeout 600
```

**Expected:**
- Root workflow reaches `done`.
- The agent step reaches `done`.

### 3. Inspect Diagnostics

```bash
eve job tree $ROOT_JOB_ID
eve job diagnose <python_step_job_id>
eve job logs <python_step_job_id> --summary
```

**Expected:**
- `diagnose` shows `runtime_meta.toolchains.execution_mode = inline`.
- `runtime_meta.toolchains.requested` and `resolved` include `python`.
- `runtime_meta.toolchains.missing` is empty.
- Logs include toolchain cache/provisioning events.
- Harness output includes `python3 --version` output.

## Success Criteria

- [ ] Agent step runs inline, not through manual runtime download.
- [ ] `python3` is available to the harness process.
- [ ] `runtime_meta.toolchains` records requested/resolved/missing/source.
- [ ] `eve job diagnose` renders toolchain metadata.
