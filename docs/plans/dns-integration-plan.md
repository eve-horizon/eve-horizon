# DNS Integration: Platform Subdomains + Custom Domains

> Status: Plan
> Created: 2026-02-11
> Extracted from: `docs/plans/platform-agents.md` (Phase 6, section 5)
>
> Dependencies: None — standalone feature. Can proceed in parallel with all other platform work.
>
> References:
> - `apps/worker/src/deployer/` (environment deployment)
> - `k8s/base/` (K8s manifests)
> - `docs/system/deployment.md` (deployment docs)

## Overview

Eve apps need friendly, discoverable domain names. This plan delivers two flows:

1. **Platform-managed subdomains** — automatic, zero-config. Every deployed environment gets a URL.
2. **Custom domains** — user-managed, with DNS validation, TLS provisioning, and lifecycle management.

---

## Platform-Managed Subdomains

Every deployed environment automatically gets a subdomain under the Eve platform domain:

```
<service>.<env>.<project>.<org>.eve.example.com
```

For single-service environments (the common case), the service prefix is omitted:

```
<env>.<project>.<org>.eve.example.com
```

### How It Works

1. **Wildcard DNS**: A single `*.eve.example.com` DNS record points to the platform's ingress controller IP. No per-subdomain DNS records needed.
2. **Wildcard TLS**: cert-manager with a DNS-01 challenge solver provisions a wildcard certificate for `*.eve.example.com` (and deeper wildcards as needed). All platform subdomains share this cert.
3. **Ingress rules**: When a service is deployed to an environment, the worker creates an Ingress resource with:
   - `host: <service>.<env>.<project>.<org>.eve.example.com`
   - `tls` referencing the wildcard cert secret
   - Backend pointing to the service's ClusterIP

This is zero-config for the user. The URL is deterministic from the project/env/service names and is returned in `eve env services` output.

### Implementation

- Extend the worker's service provisioning step to create/update an Ingress resource alongside the K8s Service.
- Wildcard cert is a one-time cluster setup (cert-manager ClusterIssuer + Certificate). Document in staging overlay or provision via infra provisioner bootstrap runbook.
- No `domains` table entry needed for platform subdomains — the URL is derived, not stored. Environment metadata should include the resolved URL for CLI display.
- URL derivation function: `buildPlatformSubdomain(org, project, env, service?, platformDomain)` — pure function, unit-testable.

---

## Custom Domains

Users can map their own domain names to their Eve deployments:

```bash
eve domain add --project my-app --env production --type custom --hostname app.mycompany.com
```

### Validation Flow

1. **Register**: User calls `eve domain add --type custom --hostname <fqdn>`. Platform creates a `domains` row with status `pending_validation` and generates a validation record:
   - CNAME validation: `_eve-verify.<fqdn>` → `<token>.verify.eve.example.com`
   - Alternative: TXT record on `_eve-verify.<fqdn>` with a platform-signed token.

2. **User configures DNS**: The user adds the validation record at their registrar. They also add a CNAME (or A record) pointing their domain to the platform ingress:
   - `app.mycompany.com` CNAME `ingress.eve.example.com`

3. **Verify**: Platform verifies:
   - The verification record exists and contains the correct token.
   - The domain resolves to the platform ingress IP.
   - Update domain status: `pending_validation` → `validated`.

4. **Provision TLS**: cert-manager provisions a certificate for the custom domain using HTTP-01 challenge (the domain already points to our ingress, so HTTP-01 works). Status: `validated` → `cert_provisioning` → `active`.

5. **Configure Ingress**: Create/update an Ingress resource with:
   - `host: app.mycompany.com`
   - `tls` with the custom domain's cert secret
   - Backend pointing to the environment's service.

6. **Ongoing**: System health agent (when deployed) monitors cert expiry and DNS resolution. If the user removes their CNAME, the domain goes to `dns_error` status but the record is preserved (user can re-point and it auto-heals).

### Domain Lifecycle States

```
pending_validation → validated → cert_provisioning → active
                  ↘ validation_failed (retryable)
active → dns_error (auto-recoverable) → active
active → cert_error (auto-recoverable via re-issue) → active
active → removed (explicit user action)
```

---

## Database Migration

```sql
-- Migration: 00044_add_domains.sql (adjust number to current highest + 1)
CREATE TABLE domains (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id),
  environment_name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('platform', 'custom')),
  status TEXT NOT NULL DEFAULT 'pending_validation'
    CHECK (status IN ('pending_validation', 'validated', 'cert_provisioning',
                      'active', 'dns_error', 'cert_error', 'validation_failed', 'removed')),
  validation_token TEXT,
  validation_record TEXT,
  cert_secret_name TEXT,
  ingress_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  UNIQUE (hostname)
);

CREATE INDEX idx_domains_project ON domains(project_id);
CREATE INDEX idx_domains_status ON domains(status);
```

---

## API Endpoints

```
POST   /projects/:id/domains              -- register a new domain (platform or custom)
GET    /projects/:id/domains              -- list domains for a project
GET    /projects/:id/domains/:did         -- get domain details
POST   /projects/:id/domains/:did/verify  -- trigger validation check
DELETE /projects/:id/domains/:did         -- remove domain + clean up ingress/cert

GET    /admin/domains                     -- all domains across all projects (admin/system)
GET    /admin/domains/pending             -- domains awaiting validation (admin/system)
```

---

## CLI Commands

```bash
eve domain list --project <project_id> --json
eve domain add --project <project_id> --env <env> --type platform --json
eve domain add --project <project_id> --env <env> --type custom --hostname app.example.com --json
eve domain verify <domain_id> --json
eve domain status <domain_id> --json
eve domain remove <domain_id>

# Admin
eve admin domains list --json
eve admin domains pending --json
```

---

## System Settings

```json
// system_settings["dns"]
{
  "platform_domain": "eve.example.com",
  "ingress_ip": "203.0.113.10",
  "wildcard_cert_secret": "wildcard-example-tls",
  "cert_issuer": "letsencrypt-prod",
  "validation_method": "cname",
  "max_custom_domains_per_project": 5,
  "auto_platform_subdomain": true
}
```

---

## Manifest Integration

Users can declare domains in their project manifest:

```yaml
# .eve/manifest.yaml
environments:
  production:
    domains:
      - type: custom
        hostname: app.mycompany.com
      - type: custom
        hostname: www.mycompany.com
    # Platform subdomain is automatic — no declaration needed
```

`eve project sync` reads the manifest domains and calls the domain registration API. This makes domains declarative and version-controlled alongside the rest of the project config.

---

## Security

- **Custom domain validation prevents domain takeover** — users must prove ownership before the platform routes traffic.
- **Hostname uniqueness constraint** prevents two projects from claiming the same domain.
- **Platform subdomains are deterministic** from project/env/service names — no user-controlled input in the DNS record itself (prevents subdomain injection).
- **TLS certs for custom domains use HTTP-01 challenge** (domain must point to our ingress), not DNS-01 (which would require access to the user's DNS provider).
- **Stale domain records** (user removed their CNAME) are detected and flagged, not auto-deleted — preserves user intent.
- **`max_custom_domains_per_project`** prevents abuse of cert provisioning (Let's Encrypt rate limits).

---

## Tests

- Integration: `eve domain add --type custom` creates domain record with `pending_validation` status and validation token.
- Integration: Domain verification succeeds when DNS records are correct → status transitions to `validated`.
- Integration: Platform subdomain Ingress is created on environment deploy with correct host and TLS.
- Integration: Custom domain cert provisioning triggers cert-manager Certificate resource creation.
- Unit: Platform subdomain URL derivation from org/project/env/service names.
- Unit: Domain hostname uniqueness constraint prevents duplicate registrations.
- Unit: `max_custom_domains_per_project` is enforced.
- Integration: Manifest `domains` entries are synced via `eve project sync`.

---

## Future

- **Multi-level DNS**: Support for deeper subdomain hierarchies (e.g., `api.v2.staging.my-app.acme.eve.example.com`).
- **White-label domains**: Configurable platform domain per deployment (e.g., `*.apps.acmecorp.com`).
- **DNS provider integrations**: Automated DNS validation via provider APIs (Cloudflare, Route53, Google Cloud DNS) instead of manual user action.
- **Infra provisioner integration**: When platform agents are deployed, the infra provisioner handles domain provisioning and TLS cert lifecycle via playbooks.
