# App Service Eve API Access

> Status: Current
> Last Updated: 2026-03-25
> Purpose: How deployed app services authenticate to the Eve REST API.

## Overview

Every deployed service automatically receives an `EVE_SERVICE_TOKEN` — a 90-day JWT scoped to the service's org, project, environment, and service name. The token refreshes on every deploy.

**No manual secret setup is required.** The platform mints and injects the token during deployment.

## Default Permissions (Read-Only)

Service tokens grant read-only access by default:

| Permission | What It Allows |
|-----------|---------------|
| `projects:read` | Read project configuration |
| `jobs:read` | List and inspect jobs |
| `threads:read` | Read threads |
| `envs:read` | Read environment state |
| `secrets:read` | Read secrets (values redacted) |
| `builds:read` | Read build status |
| `pipelines:read` | Read pipeline runs |
| `agents:read` | Read agent definitions |
| `events:read` | Read event history |

## Requesting Write Permissions

Services that need write access declare additional permissions in the manifest via `x-eve.permissions`:

```yaml
services:
  api:
    x-eve:
      permissions: [jobs:write, events:write, threads:write]
```

Declared permissions are **merged** with the read-only defaults. You only list the extra scopes you need.

**Common write permissions:**

| Permission | Use Case |
|-----------|----------|
| `jobs:write` | Create or update jobs (trigger agent workflows) |
| `events:write` | Emit app events (trigger event-driven workflows) |
| `threads:write` | Create or reply to threads |
| `envdb:write` | Write to managed databases via API |

After updating the manifest, **redeploy** to mint a new token with the updated scopes.

## Using the Token

The token is available as `EVE_SERVICE_TOKEN` in the service environment. Use it with `EVE_API_URL` for server-to-server calls:

```bash
curl -X POST "$EVE_API_URL/projects/$EVE_PROJECT_ID/jobs" \
  -H "Authorization: Bearer $EVE_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Run a code change job from the app",
    "env_name": "'"$EVE_ENV_NAME"'"
  }'
```

## Platform-Injected Variables

These are always available — do not redeclare them as `${secret.*}`:

| Variable | Description |
|----------|-------------|
| `EVE_API_URL` | Internal cluster API URL |
| `EVE_PUBLIC_API_URL` | Public API URL (for browser-facing code) |
| `EVE_SSO_URL` | SSO URL (if configured) |
| `EVE_PROJECT_ID` | Project TypeID |
| `EVE_ORG_ID` | Org TypeID |
| `EVE_ENV_NAME` | Environment name |
| `EVE_SERVICE_TOKEN` | 90-day scoped JWT |

## Token Lifecycle

- **Minted** on every deploy, scoped to the specific service
- **TTL**: 90 days (renewed on each deploy)
- **Type**: `service` (distinct from `user` and `job` tokens)
- **Subject**: `service:<service-name>`

No manual rotation needed — regular deploys keep the token fresh.

## Troubleshooting

**403 "Missing required permission"**: The service token doesn't have the required scope. Add the missing permission to `x-eve.permissions` in the manifest and redeploy.

**Empty `EVE_SERVICE_TOKEN`**: Check that `EVE_INTERNAL_API_KEY` is configured in the platform. The deployer logs a warning if token minting fails.
