# Scenario 43: Job Token Resource Scope

**Time:** ~5 minutes
**Parallel Safe:** No
**LLM Required:** Yes

Validates that workflow `scope` is persisted on step jobs, used for the
workspace `.org` mount, and enforced by the API through `EVE_JOB_TOKEN`.

## Prerequisites

- `EVE_API_URL=http://api.eve.lvh.me`
- Local k3d stack deployed from the current branch
- Authenticated CLI profile for the local stack
- A test org and project pair available

## Steps

### 1. Prepare Access Scope

Create or reuse one org/project pair where the invoking user has a custom
access binding that covers only the project A subtree:

```yaml
version: 2
access:
  roles:
    scoped_smoke_writer:
      scope: org
      permissions: [orgfs:read, orgfs:write]
  bindings:
    - subject: { type: user, id: <user_id> }
      roles: [scoped_smoke_writer]
      scope:
        orgfs:
          allow_prefixes:
            - /groups/projects/proj-a
            - /groups/projects/proj-a/**
```

Apply it:

```bash
eve access sync --file /path/to/access.yaml --org <org_id> --yes
eve access can --org <org_id> --user <user_id> \
  --permission orgfs:write --resource-type orgfs \
  --resource /groups/projects/proj-a --action write --json
```

### 2. Sync a Scoped Workflow

Add a workflow whose step scope allows only project A:

```yaml
workflows:
  scoped-token-smoke:
    steps:
      - name: check
        agent:
          prompt: |
            Use EVE_JOB_TOKEN against the Eve API.
            GET /orgs/<org_id>/fs/download-url?path=/groups/projects/proj-a/ok.txt
            and report the HTTP status.
            Then try /groups/projects/proj-b/x.txt and report the HTTP status
            and error code. Finally list .org and report whether proj-b is absent.
        scope:
          orgfs:
            allow_prefixes: [/groups/projects/proj-a/**]
```

Sync or validate the manifest:

```bash
eve manifest validate --project <project_id>
eve project sync --project <project_id>
```

### 3. Invoke and Inspect

```bash
eve workflow run scoped-token-smoke --project <project_id> --json
eve job diagnose <step_job_id> --json
```

**Expected:**
- The step job has `token_scope.orgfs.allow_prefixes` containing only
  `/groups/projects/proj-a/**`.
- `eve job diagnose` includes `token_scope`.

### 4. Verify API Enforcement

**Expected from the job output:**
- A read/download-url check for `/groups/projects/proj-a/ok.txt` does not fail
  authorization. If the object is absent, `404 resource_not_found` is acceptable
  because it means the request reached storage after the scope check.
- A read/download-url check for `/groups/projects/proj-b/x.txt` fails with
  403 `resource_access_denied`.
- If testing writes with the sync-link API, a request under
  `/groups/projects/proj-a/**` should pass authorization and may then fail at
  the service layer (for example `fs_device_not_found` when using a fake device).
  The same request under `/groups/projects/proj-b/**` must fail with
  403 `resource_access_denied`.
- The workspace `.org` mount does not expose the `proj-b` subtree.

### 5. Cloud FS Mount Scope

If Cloud FS mounts are configured, create two mounts, one per project, then run
a workflow step with:

```yaml
scope:
  cloud_fs:
    allow_mount_ids: [<mount_a>]
```

**Expected:**
- `eve cloud-fs list --json` only shows `<mount_a>` from inside the job.
- Browse/search/download against `<mount_b>` returns 403.

## Success Criteria

- [ ] Step job persists `token_scope`
- [ ] Job token enforces scoped orgfs API writes
- [ ] Workspace `.org` mount matches the token scope
- [ ] Cloud FS mount listing and per-mount routes honor `allow_mount_ids`
