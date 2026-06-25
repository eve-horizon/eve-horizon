# Project Status Command

> Status: Implemented
> Last Updated: 2026-02-15
> Implementation: CLI-only (no API endpoint needed)

## Problem

From inside a project repo, there's no single command to answer: "what's
deployed where, and how do I reach it?"

Today, discovering a service URL requires five commands and a mental model of
Eve's URL conventions:

```
eve profile list              # which profiles do I have?
eve env list <project>        # which envs exist?
eve env services <project> <env>  # which pods are running? (no URLs)
eve api list <project>        # API sources (internal cluster DNS only)
kubectl get ingress -A        # fall back to k8s primitives for actual URLs
```

This is the #1 friction point for anyone developing on Eve — both humans and
agents. An agent in a project repo that needs to call or test a deployed
service has to guess URL patterns or shell out to kubectl.

## Solution: `eve project status`

A single command, run from the project repo, that iterates all local profiles
and presents a unified dashboard of deployments and their endpoints.

### Target Output

```
$ eve project status

local (active)  http://api.eve.lvh.me
  sandbox   active  persistent
    web   1/1 ready  http://web.epm508487-pm508487-sandbox.lvh.me
    api   1/1 ready  http://api.epm508487-pm508487-sandbox.lvh.me

staging  https://api.eve.example.com
  staging   active  persistent
    web   2/2 ready  https://web.epm-evepm-staging.eve.example.com
    api   2/2 ready  https://api.epm-evepm-staging.eve.example.com
  preview-42   active  temporary
    web   1/1 ready  https://web.epm-evepm-preview-42.eve.example.com
    api   1/1 ready  https://api.epm-evepm-preview-42.eve.example.com
```

Flags:
- `--json` — machine-readable output (for agents)
- `--profile <name>` — show only one profile instead of all
- `--env <name>` — show only one environment

### JSON Output Shape

```json
{
  "profiles": [
    {
      "name": "local",
      "active": true,
      "api_url": "http://api.eve.lvh.me",
      "project_id": "proj_xxx",
      "environments": [
        {
          "name": "sandbox",
          "status": "active",
          "type": "persistent",
          "services": [
            {
              "name": "web",
              "pods_ready": 1,
              "pods_total": 1,
              "status": "ready",
              "url": "http://web.epm508487-pm508487-sandbox.lvh.me"
            },
            {
              "name": "api",
              "pods_ready": 1,
              "pods_total": 1,
              "status": "ready",
              "url": "http://api.epm508487-pm508487-sandbox.lvh.me"
            }
          ]
        }
      ]
    }
  ]
}
```

## Design

### Two-Layer Change

1. **API: new endpoint** — `GET /projects/:id/overview`
2. **CLI: new subcommand** — `eve project status`

### Layer 1: API Endpoint

**`GET /projects/:id/overview`**

Returns all environments for a project, each with per-service status and
external endpoint URLs. This keeps the CLI thin — one API call per profile
gives everything needed.

Response shape:

```json
{
  "project": {
    "id": "proj_xxx",
    "name": "eve-pm",
    "slug": "pm508487",
    "org_slug": "epm508487"
  },
  "environments": [
    {
      "name": "sandbox",
      "type": "persistent",
      "status": "active",
      "namespace": "eve-epm508487-pm508487-sandbox",
      "services": [
        {
          "name": "web",
          "pods_ready": 1,
          "pods_total": 1,
          "status": "ready",
          "internal_url": "http://sandbox-web.eve-epm508487-pm508487-sandbox.svc.cluster.local:3000",
          "external_url": "http://web.epm508487-pm508487-sandbox.lvh.me"
        }
      ]
    }
  ]
}
```

**How external URLs are resolved:**

The API already has `ApiRegistrationService.resolveBaseUrls()` which generates
both internal and external URLs from org slug, project slug, env name,
component name, and domain. The domain comes from the deployment target
configuration.

For services that have registered API sources (`project_api_sources` table),
the internal URL is already stored. The external URL can be derived by
rewriting it — the same logic the CLI already uses in
`resolveApiBaseUrlForRuntime` (`packages/cli/src/commands/api.ts:529`).

For services without API sources (e.g., worker processes), we can still infer
the external URL if the service has an ingress definition in the manifest
(`x-eve.ingress.public: true`). The overview endpoint should parse the
manifest to identify which services have public ingress.

The domain is determined from the API server's own configuration
(`EVE_DEFAULT_DOMAIN` or inferred from the API URL hostname).

**Implementation location:**

- New method in `apps/api/src/environments/environments.service.ts`
- Exposed via `apps/api/src/environments/environments.controller.ts`
- Leverages existing `diagnose` logic for pod/service status
- Leverages existing `ApiRegistrationService.resolveBaseUrls()` for URL
  generation

### Layer 2: CLI Command

**`eve project status`**

New handler in `packages/cli/src/commands/project.ts` (add `status` case to
the existing switch).

Logic:

```
1. Load all profiles from .eve/profile.yaml
2. For each profile (or --profile filter):
   a. Build a temporary ResolvedContext for that profile
   b. Skip if no project_id configured
   c. Skip if no auth token available (show "not authenticated")
   d. Call GET /projects/{projectId}/overview
   e. Collect results
3. Format and display
```

**Cross-profile context building:**

The CLI currently resolves a single context from flags + env + active profile.
For `project status`, we need to temporarily resolve context for each profile.
Add a small helper:

```typescript
function resolveContextForProfile(
  profileName: string,
  profile: ProfileConfig,
  credentials: CredentialsFile,
): ResolvedContext
```

This is a simplified version of `resolveContext` that takes an explicit profile
instead of reading from flags/env. It needs access to `credentials` to look up
auth tokens per profile.

**Handling auth per profile:**

Each profile may target a different Eve API (local vs staging vs production).
The credentials file stores tokens keyed by `authKey` (which is the API URL).
The helper resolves the auth token from `credentials.tokens[apiUrl]`.

If a profile has no valid token, the command should show the profile but
indicate "not authenticated" rather than failing the entire command.

**Handling unreachable APIs:**

If a profile's API is unreachable (e.g., staging is down), catch the error and
display it inline rather than aborting. The command should always show
something for every profile.

### What About Agents?

The `--json` output makes this fully agent-native. An agent in a project repo
can run `eve project status --json` and parse the result to find the URL for
any service in any environment. No kubectl, no URL guessing, no multi-step
discovery.

## Implementation Plan

### Phase 1: API Endpoint

1. Add `getProjectOverview` method to `EnvironmentsService`
   - Fetch all environments for the project
   - For each active environment, call existing diagnose/health logic
   - Resolve external URLs using manifest + domain config
   - Return the unified response

2. Add `GET /projects/:id/overview` route to `EnvironmentsController`

3. Add integration test for the endpoint

### Phase 2: CLI Command

4. Add `resolveContextForProfile` helper to `packages/cli/src/lib/context.ts`

5. Add `status` case to `handleProject` in `packages/cli/src/commands/project.ts`
   - Iterate profiles
   - Call overview endpoint per profile
   - Format table output and JSON output

6. Update CLI help text to include `status` in the project subcommand list

### Phase 3: Polish

7. Handle edge cases:
   - Profile with no project_id configured
   - Profile with expired/missing auth token
   - API server unreachable
   - Environment with no running services (just deployed, or suspended)
   - Environment in "suspended" state

8. Test with multiple profiles (local + staging)

## Files Modified

| File | Change |
|------|--------|
| `apps/api/src/environments/environments.service.ts` | Add `getProjectOverview()` method |
| `apps/api/src/environments/environments.controller.ts` | Add `GET /projects/:id/overview` route |
| `packages/cli/src/commands/project.ts` | Add `status` subcommand handler |
| `packages/cli/src/lib/context.ts` | Add `resolveContextForProfile()` helper |
| `packages/cli/src/lib/help.ts` | Update help text for `eve project` |

## Open Questions

1. **Should we also extend `eve env services` to show URLs?** — Could add
   `--urls` flag or always show them. Lower priority since `project status`
   covers the primary use case, but would be a nice incremental improvement.

2. **Domain resolution on multi-cluster setups** — For a single cluster the
   domain is straightforward (inferred from API URL). When Eve manages
   multiple clusters with different domains, the API needs to know each
   cluster's ingress domain. For now, single-domain-per-API-server is
   sufficient.

3. **Should suspended environments show in the output?** — Leaning yes, but
   with a clear `suspended` status indicator and no service rows.
