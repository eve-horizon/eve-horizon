# Scenario 24: Project vs Org Secret Scope Behavior

**Time:** ~6-8 minutes
**Parallel Safe:** No
**LLM Required:** No

Validates project- and org-scoped secret materialization behavior at deploy time.

## Prerequisites

- Local k3d stack running
- Scenarios 01 and 05 pass (API healthy, deploy works)
- `EVE_API_URL` set to local API URL (`http://api.eve.lvh.me`)
- Manual test org exists (`org_manualtestorg`) and local kube context points to k3d

```bash
export EVE_API_URL=http://api.eve.lvh.me
export ORG_ID=org_manualtestorg
export ORG_SLUG=mto
```

## Setup

```bash
export RUN_ID=$(date +%s)
export PROJECT_NAME="secret-scope-regress-${RUN_ID}"
export PROJECT_SLUG="sreg${RUN_ID}"
export PROJECT_ENV=test
export CLUSTER_DOMAIN=lvh.me

# Use a public repo with a known-good deploy path
REPO_DIR=$(mktemp -d)/repo
git clone --depth 1 https://github.com/eve-horizon/eve-horizon-fullstack-example $REPO_DIR

# Provision an isolated project
 eve project ensure \
  --org "$ORG_ID" \
  --name "$PROJECT_NAME" \
  --slug "$PROJECT_SLUG" \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>

# Import shared secrets (GITHUB_TOKEN, Z_AI_API_KEY)
eve secrets import --project "$PROJECT_ID" --file ./manual-tests.secrets

# Sync manifest from repo and create env
 eve project sync --project "$PROJECT_ID" --dir "$REPO_DIR" --json

eve env create "$PROJECT_ENV" --type persistent --project "$PROJECT_ID" --json
```

## Regression helper

Define a pod env probe that only reports whether the variable exists (no secret value).

```bash
export TEST_NAMESPACE="eve-${ORG_SLUG}-${PROJECT_SLUG}-${PROJECT_ENV}"

probe_runtime_secret_scope() {
  local label="$1"
  echo "\n== Runtime env check: ${label} =="
  echo "Namespace: ${TEST_NAMESPACE}"

  kubectl get pods -n "$TEST_NAMESPACE" --no-headers -o custom-columns=":metadata.name" | while read -r POD; do
    echo "- Pod: $POD"
    if ! kubectl exec -n "$TEST_NAMESPACE" "$POD" -- sh -lc 'if [ -n "${ADMIN_BOOTSTRAP_SECRET+x}" ]; then echo "  ADMIN_BOOTSTRAP_SECRET=present"; else echo "  ADMIN_BOOTSTRAP_SECRET=missing"; fi; if [ -n "${CORS_ALLOWED_HOSTS+x}" ]; then echo "  CORS_ALLOWED_HOSTS=present"; else echo "  CORS_ALLOWED_HOSTS=missing"; fi'; then
      echo "  (cannot inspect this pod shell)"
    fi
  done
}
```

## Steps

### 1) Deploy baseline with project-scoped secret only

```bash
export ADMIN_BOOTSTRAP_SECRET_VALUE="bhiblee-admin-setup-${RUN_ID}"
export TARGET_DOMAIN="$CLUSTER_DOMAIN"

# Configure only project-scoped keys
 eve secrets set ADMIN_BOOTSTRAP_SECRET "$ADMIN_BOOTSTRAP_SECRET_VALUE" --project "$PROJECT_ID"
eve secrets set CORS_ALLOWED_HOSTS "$TARGET_DOMAIN" --project "$PROJECT_ID"

eve env deploy "$PROJECT_ENV" --ref main --repo-dir "$REPO_DIR" --project "$PROJECT_ID"
```

Wait for the env to become ready (deploy success in Eve UI/CLI), then run:

```bash
probe_runtime_secret_scope "Project scope"
```

Expected outcome:

- Pods should report `ADMIN_BOOTSTRAP_SECRET=present` and `CORS_ALLOWED_HOSTS=present`.
- If this baseline differs, note scope behavior regression in the bead.

### 2) Switch same keys to org scope and redeploy

```bash
# Keep secret materialization path identical, change scope to org
 eve secrets delete ADMIN_BOOTSTRAP_SECRET --project "$PROJECT_ID"
eve secrets delete CORS_ALLOWED_HOSTS --project "$PROJECT_ID"

eve secrets set ADMIN_BOOTSTRAP_SECRET "$ADMIN_BOOTSTRAP_SECRET_VALUE" --org "$ORG_ID"
eve secrets set CORS_ALLOWED_HOSTS "$TARGET_DOMAIN" --org "$ORG_ID"

eve env deploy "$PROJECT_ENV" --ref main --repo-dir "$REPO_DIR" --project "$PROJECT_ID"
```

Wait for deploy success and run:

```bash
probe_runtime_secret_scope "Org scope"
```

Expected outcome:

- Pod(s) running the app should still report `ADMIN_BOOTSTRAP_SECRET=present` and `CORS_ALLOWED_HOSTS=present`.
- If both project and org are set, project-scope keys should take precedence (verify with different values if possible).

### 3) Optional app-level validation (if the deployed app exposes `/api/v1/auth/bootstrap-admin`)

```bash
# Replace these with your local app credentials if available.
# Keep this as a manual smoke check only.
export APP_API="http://api.${ORG_SLUG}-${PROJECT_SLUG}-${PROJECT_ENV}.${CLUSTER_DOMAIN}"

curl -s -X POST "$APP_API/api/v1/auth/bootstrap-admin" \
  -H "Content-Type: application/json" \
  -d '{"email":"pierre.davies@example.com","password":"<candidate_pw>","secret":"'$ADMIN_BOOTSTRAP_SECRET_VALUE'"}' | jq .
```

Expected behavior if the app is the Bhiblee bootstrap flow:

- Baseline project-scope and org-scope tests should reach validation path (`200`/`409` depending app-specific existing-admin state).
- If both scopes have different values, project-scope should remain authoritative.

## Success Criteria

- [ ] Project created/synced and `test` environment created.
- [ ] Project-scoped secrets appear in container env at deploy-time.
- [ ] Org-scoped secrets appear in container env at deploy-time.
- [ ] Project-scope and org-scope values are both materialized (where present), with project scope preferred on collision.
- [ ] (Optional) App-level bootstrap check reflects runtime behavior change as expected.
- [ ] Cleanup completed.

## Cleanup

```bash
# Remove project-only and org-only test secrets
 eve secrets delete ADMIN_BOOTSTRAP_SECRET --project "$PROJECT_ID" || true
eve secrets delete CORS_ALLOWED_HOSTS --project "$PROJECT_ID" || true
eve secrets delete ADMIN_BOOTSTRAP_SECRET --org "$ORG_ID" || true
eve secrets delete CORS_ALLOWED_HOSTS --org "$ORG_ID" || true

eve env delete "$PROJECT_ENV" --project "$PROJECT_ID" --force
eve project delete "$PROJECT_ID" --force
rm -rf "$REPO_DIR"
```
