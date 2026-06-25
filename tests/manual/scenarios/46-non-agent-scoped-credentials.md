# Scenario 46: Non-Agent Scoped Credentials

**Time:** ~3 minutes
**Parallel Safe:** No
**LLM Required:** No

Validates that pipeline `script:` and `action: { type: run }` steps mint
`EVE_JOB_TOKEN` with the per-step `permissions:` and `scope:` declared in
the manifest, and that `~/.eve/credentials.json` is provisioned so the
Eve CLI authenticates without env-var plumbing.

This closes the asymmetry where only agent steps honoured per-step
declarative credentials. Now `script:` and `action: { type: run }` honour
them too.

## Prerequisites

- `EVE_API_URL=http://api.eve.lvh.me`
- Local k3d stack deployed from the current branch (includes the
  `00099_jobs_token_permissions` migration, the new `permissions:` schema
  field, and the script/action executor changes).
- `eve` CLI built from the current branch.

## Setup

Use the stable manual test org:

```bash
export ORG_ID=org_manualtestorg
eve project ensure \
  --org $ORG_ID \
  --name "scope-test" \
  --slug scope-test \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=proj_<id_from_output>

TMPDIR=$(mktemp -d)
git clone --depth 1 https://github.com/eve-horizon/eve-horizon-fullstack-example $TMPDIR/repo
cp tests/manual/scenarios/fixtures/non-agent-scope/manifest.yaml $TMPDIR/repo/.eve/manifest.yaml
( cd $TMPDIR/repo && eve project sync --project $PROJECT_ID --json )
```

## Steps

The driver script `46-non-agent-scoped-credentials.sh` runs all seven cases
and emits one JSONL line per case. Run it directly:

```bash
./tests/manual/scenarios/46-non-agent-scoped-credentials.sh \
  --org $ORG_ID --project $PROJECT_ID
```

What each case validates (3 script-shaped, 3 action-run-shaped, 1 back-compat):

| Case | Step shape | Declares | Calls | Expected |
| --- | --- | --- | --- | --- |
| `positive-script-jobs` | `script:` | `permissions: [jobs:read]` | `eve job current --json` | success (`exit 0`) |
| `negative-perm-script-jobs` | `script:` | `permissions: [projects:read]` (no `jobs:read`) | `eve job current --json` | denied (non-zero, `403`) |
| `positive-script-orgfs` | `script:` | `permissions: [jobs:read,orgfs:read]`, `scope.orgfs.read_only_prefixes: [/groups/projects/scope-test/**]` | `eve orgfs read /groups/projects/scope-test/marker.txt` | success or `404 resource_not_found` (path passed scope check) |
| `negative-path-script-orgfs` | `script:` | same permissions, scope narrowed to `/groups/projects/other/**` | `eve orgfs read /groups/projects/scope-test/marker.txt` | denied (non-zero, `403`) |
| `positive-action-run-jobs` | `action: { type: run }` | `permissions: [jobs:read]` | `eve job current --json` | success (`exit 0`) |
| `negative-perm-action-run-jobs` | `action: { type: run }` | `permissions: [projects:read]` | `eve job current --json` | denied |
| `backcompat-script-no-decl` | `script:` | (no `permissions:`, no `scope:`) | `eve job current --json` | success (uses `DEFAULT_SCRIPT_JOB_PERMISSIONS`) |

The driver pipes each pipeline's logs through `jq` to extract the case
result, then writes a JSONL summary block to stdout:

```jsonl
{"case": "positive-script-jobs",            "expected": "success", "actual": "success", "pass": true}
{"case": "negative-perm-script-jobs",       "expected": "denied",  "actual": "denied",  "pass": true}
{"case": "positive-script-orgfs",           "expected": "success", "actual": "success", "pass": true}
{"case": "negative-path-script-orgfs",      "expected": "denied",  "actual": "denied",  "pass": true}
{"case": "positive-action-run-jobs",        "expected": "success", "actual": "success", "pass": true}
{"case": "negative-perm-action-run-jobs",   "expected": "denied",  "actual": "denied",  "pass": true}
{"case": "backcompat-script-no-decl",       "expected": "success", "actual": "success", "pass": true}
```

Driver exits non-zero on any case mismatch; CI can wrap it directly.

## Inspecting persistence

After the driver finishes, you can confirm the per-step persistence:

```bash
eve job list --project $PROJECT_ID --label pipeline:scope-test --json | \
  jq -r '.data[] | "\(.id)\t\(.step_name)"'
eve job show <step_job_id> --verbose
```

The `Token:` block should show the merged `Permissions:` list and
`Scope:` JSON for steps that declared them, and be absent for the
back-compat case.

## Success Criteria

- [ ] All seven JSONL cases report `pass: true` and the driver exits 0.
- [ ] `eve job show <id> --verbose` renders `Token: Permissions: ...` for
      declared steps and omits the block for the back-compat step.
- [ ] `eve job diagnose <id>` includes the `Token:` block; it surfaces a
      `⚠ scope.orgfs.read_only_prefixes set but permissions[] missing
      orgfs:read` warning for any deliberately misaligned case.
- [ ] No step references `EVE_INTERNAL_API_KEY` in its environment
      (`eve job logs <id>` should not contain the worker's internal key).
