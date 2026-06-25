# Custom Domains for Eve-Deployed Apps

> **Status**: Plan
> **Created**: 2026-03-27
> **Updated**: 2026-03-27 — Fixed deployer code patterns, Zod schema, GC, rollback, apex DNS guidance
> **Supersedes**: `dns-integration-plan.md` (custom domains section only — platform subdomains are already implemented)
>
> **Motivation**: Pierre wants `limelee.com` for his Eve-deployed ingest app. Any Eve user should be able to bring their own domain.
>
> **Dependencies**: cert-manager (already deployed), Traefik ingress controller (already deployed)

---

## The Problem

Today, Eve-deployed apps get two kinds of URLs:

| Type | Example | How |
|------|---------|-----|
| **Primary** | `web.pierre-ingest-prod.eve.example.com` | Auto-generated from org/project/env |
| **Alias** | `ingest.eve.example.com` | Declared via `x-eve.ingress.alias` |

Both live under the platform domain (`eve.example.com`). There's no way to use your own domain.

**What we want**: Pierre declares `limelee.com` in his manifest, points his DNS, and Eve handles everything — validation, TLS, ingress routing.

---

## Design Principles

1. **Manifest-driven** — Domains are declared in `.eve/manifest.yaml`, version-controlled alongside everything else. No snowflake configuration.
2. **Zero-trust DNS** — We validate domain ownership before routing traffic. No domain hijacking.
3. **cert-manager does the heavy lifting** — HTTP-01 challenges work automatically once DNS points to our ingress. We don't need DNS provider integrations.
4. **Build on what exists** — The alias ingress machinery (database tracking, deployer generation, garbage collection) is the foundation. Custom domains are the same pattern with a full FQDN instead of a short alias.

---

## How It Works

### User Flow

```
1. Pierre adds to his manifest:
   services:
     web:
       x-eve:
         ingress:
           public: true
           domains:
             - limelee.com
             - www.limelee.com

2. `eve project sync` registers the domains (parallel to alias sync):
   → Eve returns: "Point these domains to ingress.eve.example.com (CNAME)
                    or 52.xx.xx.xx (A record)"
   (Domains are claimed at project level during sync, bound to environments during deploy)

3. Pierre updates his DNS at his registrar:
   limelee.com      A     52.xx.xx.xx
   www.limelee.com  CNAME ingress.eve.example.com

4. `eve domain verify limelee.com`:
   → Eve performs real DNS resolution server-side → marks domain as `dns_verified`
   → User redeploys: `eve env deploy production --ref main`
   → Deployer creates Ingress with cert-manager annotation
   → cert-manager provisions Let's Encrypt cert via HTTP-01
   → Traffic flows

5. `eve domain list --project pierre-ingest`:
   HOSTNAME           SERVICE  STATUS  VERIFIED
   limelee.com        web      active  2026-03-28
   www.limelee.com    web      active  2026-03-28
```

### Architecture

```
                                    ┌──────────────────┐
  limelee.com ──DNS──> Ingress IP ──┤  Traefik Ingress │
                                    │  (Host matching)  │
                                    └────────┬─────────┘
                                             │
                              ┌──────────────┤
                              │              │
                    ┌─────────▼──┐   ┌───────▼────────┐
                    │ Primary    │   │ Custom Domain   │
                    │ Ingress    │   │ Ingress         │
                    │            │   │                 │
                    │ web.pierre │   │ limelee.com     │
                    │ -ingest-   │   │ + TLS (HTTP-01) │
                    │ prod.example.. │   │                 │
                    └─────┬──────┘   └────────┬────────┘
                          │                   │
                          └─────────┬─────────┘
                                    │
                              ┌─────▼──────┐
                              │ K8s Service │
                              │ (web)       │
                              └─────────────┘
```

Each custom domain gets its own Ingress resource and its own TLS certificate (cert-manager provisions them individually via HTTP-01).

---

## Manifest Schema

Extend `IngressConfigSchema` with an optional `domains` array:

```typescript
// FQDN pattern — case-insensitive input, lowercase output
export const CustomDomainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

export const IngressConfigSchema = z.object({
  public: z.boolean().optional(),
  port: z.number().optional(),
  alias: z.string().min(3).max(63).regex(IngressAliasPattern).optional(),
  // NEW: Custom domain names (full FQDNs)
  domains: z.array(
    z.string()
      .min(4)              // a.co minimum
      .max(253)            // DNS max
      .regex(CustomDomainPattern)  // validate before transform (regex runs on ZodString, not ZodEffects)
      .transform((v) => v.toLowerCase())
  ).max(10).optional(),    // max per-service; overall project limit enforced at API layer
}).passthrough();
```

**Zod note**: `.transform()` returns a `ZodEffects` which doesn't have `.regex()`. Validate with `.regex()` first (case-insensitive pattern), then `.transform()` to lowercase.

### Manifest Examples

**Single domain (common case):**
```yaml
services:
  web:
    image: ${EVE_REGISTRY}/web:${EVE_RELEASE_TAG}
    ports: [3000]
    x-eve:
      ingress:
        public: true
        domains:
          - limelee.com
```

**Multiple domains with www redirect:**
```yaml
services:
  web:
    image: ${EVE_REGISTRY}/web:${EVE_RELEASE_TAG}
    ports: [3000]
    x-eve:
      ingress:
        public: true
        alias: limelee            # limelee.eve.example.com still works
        domains:
          - limelee.com
          - www.limelee.com
```

**Multi-service app:**
```yaml
services:
  web:
    x-eve:
      ingress:
        public: true
        domains:
          - limelee.com
          - www.limelee.com
  api:
    x-eve:
      ingress:
        public: true
        domains:
          - api.limelee.com
```

All three domain types coexist: primary (auto), alias (vanity), and custom domains.

---

## Database

### Migration: `custom_domains`

```sql
CREATE TABLE custom_domains (
  id             TEXT PRIMARY KEY,
  hostname       TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  service_name   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending_dns'
    CHECK (status IN (
      'pending_dns',       -- Registered, waiting for DNS to point to us
      'dns_verified',      -- DNS resolves to our ingress
      'cert_provisioning', -- cert-manager is issuing the certificate
      'active',            -- Serving traffic with valid TLS
      'dns_error',         -- Was active, DNS no longer resolves (auto-recoverable)
      'cert_error',        -- Certificate issue/renewal failed (auto-recoverable)
      'removed'            -- Soft-deleted by user
    )),
  ingress_name     TEXT,            -- K8s Ingress resource name (set when created)
  cert_secret_name TEXT,            -- TLS secret name (set when cert issued)
  verified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hostname)
);

CREATE INDEX idx_custom_domains_project ON custom_domains(project_id);
CREATE INDEX idx_custom_domains_env ON custom_domains(environment_id);
CREATE INDEX idx_custom_domains_status ON custom_domains(status);
```

**Note**: `ON DELETE CASCADE` on `project_id` matches the `ingress_aliases` pattern — deleting a project cleans up its domain records. `ON DELETE SET NULL` on `environment_id` preserves domain reservations when environments are deleted (the domain can be re-bound on next deploy).

**Key decisions:**
- **No validation tokens** — We don't need CNAME verification records. If the domain's DNS resolves to our ingress IP, the user controls it. cert-manager's HTTP-01 challenge is the proof of control (Let's Encrypt won't issue a cert otherwise).
- **Hostname is globally unique** — One domain can only be claimed by one project, enforced at the database level.
- **Soft delete** — `removed` status preserves the record so we can clean up K8s resources gracefully.

### Why Not Reuse `ingress_aliases`?

The `ingress_aliases` table stores short aliases (3-63 chars, single label). Custom domains are full FQDNs with dots, have lifecycle states, and need cert tracking. Separate tables keep both clean.

---

## Implementation

### Phase 1: Core (What Pierre Needs)

**Files to change:**

| File | Change |
|------|--------|
| `packages/shared/src/schemas/manifest.ts` | Add `domains` to `IngressConfigSchema`, `CustomDomainPattern`, `getManifestCustomDomains()`, `assertUniqueManifestCustomDomains()` |
| `packages/shared/src/config/schema.ts` | Add `EVE_PLATFORM_INGRESS_IP`, `EVE_PLATFORM_INGRESS_HOSTNAME`, `EVE_MAX_CUSTOM_DOMAINS_PER_PROJECT` |
| `packages/db/migrations/00XXX_custom_domains.sql` | Create `custom_domains` table |
| `packages/db/src/queries/custom-domains.ts` | CRUD queries (mirror `ingress-aliases.ts` patterns) |
| `apps/worker/src/deployer/deployer.service.ts` | Generate custom domain Ingress, DNS verify, GC, rollback |
| `apps/worker/src/deployer/k8s.service.ts` | Add `listCustomDomainIngresses()` |
| `apps/api/src/custom-domains/` | New module: API endpoints (CRUD + verify) |
| `packages/cli/src/commands/domain/` | New CLI commands (`list`, `verify`, `status`, `remove`) |

#### 1a. Manifest Schema Extension

Add `domains` to `IngressConfigSchema` in `packages/shared/src/schemas/manifest.ts`.

Add `getManifestCustomDomains()` helper (parallel to existing `getManifestIngressAliases()`):
- Extracts all `{hostname, serviceName}` mappings from manifest
- Validates no duplicate hostnames across all services (same pattern as `assertUniqueManifestIngressAliases()`)
- Rejects hostnames that end with the platform domain (those should use `alias`)

Add `assertUniqueManifestCustomDomains(domains)` — throws if the same hostname appears on multiple services within the same manifest. Called during `eve project sync` and before deploy.

#### 1b. Database + Queries

Create migration and query file. Key operations (mirror `ingress-aliases.ts` patterns):
- `claimOrUpdate(hostname, projectId, serviceName)` — Claim a domain (idempotent for same project, returns null if claimed by different project)
- `bindToEnvironment(hostname, projectId, envId, serviceName)` — Bind to env on deploy (returns null if cross-project conflict)
- `updateStatus(hostname, status, opts?)` — Lifecycle transitions; `opts` can include `ingressName`, `certSecretName`, `verifiedAt`
- `findByProject(projectId)` — List domains for a project
- `findByEnvironment(envId)` — List domains bound to an env
- `findByHostname(hostname)` — Global lookup
- `countByProject(projectId)` — For rate limit enforcement
- `unbindAliasesForEnvironment(envId, hostnames[])` — Selective unbind (for deploy rollback)
- `release(hostname, projectId)` — Delete domain record

All inputs normalized with `hostname.trim().toLowerCase()` before query (matches alias pattern).

#### 1c. Deployer Extension

In `deployer.service.ts`, within the existing per-service ingress loop (after alias ingress generation at ~line 982), add custom domain ingress generation. This runs inside the same `Object.entries(deployableServices).forEach(...)` loop that generates primary and alias ingresses, so it has access to `resourceName`, `labels`, `ingressPort`, etc.

```typescript
// Custom domain ingresses — after alias ingress block
const serviceDomains = this.resolveIngressDomains(ingressConfig);
for (const hostname of serviceDomains) {
  // Resource name: hash the hostname to avoid 63-char truncation collisions
  // Long hostnames like "www.really-long-subdomain.example.com" would collide
  // after toK8sName truncation without a unique suffix
  const hostnameSlug = hostname.replace(/\./g, '-');
  const domainResourceName = this.toK8sName(
    `${resourceName}-cd-${hostnameSlug}`,
    'resource'
  );
  const domainCertSecretName = `${domainResourceName}-tls`;

  const domainAnnotations: Record<string, string> = {};
  // Custom domains MUST use cert-manager (cluster issuer) — the platform's
  // wildcard cert (EVE_DEFAULT_TLS_SECRET) doesn't cover custom FQDNs.
  // If tlsClusterIssuer isn't configured, custom domains get no TLS.
  if (tlsClusterIssuer) {
    domainAnnotations['cert-manager.io/cluster-issuer'] = tlsClusterIssuer;
  }

  const domainIngress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: domainResourceName,
      labels: {
        ...labels,
        'eve.custom_domain': 'true',
        'eve.domain_hostname': this.toK8sLabelValue(hostname, 'hostname'),
      },
      annotations: Object.keys(domainAnnotations).length > 0
        ? domainAnnotations : undefined,
    },
    spec: {
      ingressClassName: ingressClassName || undefined,
      rules: [{
        host: hostname,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              // Same backend as primary + alias ingresses.
              // resourceName IS the K8s Service name (from combineK8sName).
              service: { name: resourceName, port: { number: ingressPort } },
            },
          }],
        },
      }],
      // Explicitly ignore tlsSecretOverride (EVE_DEFAULT_TLS_SECRET) —
      // wildcard certs don't cover custom domains.
      tls: tlsClusterIssuer
        ? [{ hosts: [hostname], secretName: domainCertSecretName }]
        : undefined,
    },
  };

  customDomainIngresses.push({
    hostname,
    serviceName: name,
    ingressManifest: yaml.stringify(domainIngress),
    ingressName: domainResourceName,
    certSecretName: domainCertSecretName,
  });
}
```

**Key differences from alias ingresses:**
1. **TLS**: Explicitly ignores `EVE_DEFAULT_TLS_SECRET` (`tlsSecretOverride`). The platform's wildcard cert can't cover `limelee.com`. Each custom domain gets its own cert via HTTP-01.
2. **Labels**: Uses `eve.custom_domain=true` + `eve.domain_hostname` (parallel to `eve.ingress_alias=true` + `eve.alias`).
3. **Backend**: Points to the same K8s Service as primary/alias ingresses — `resourceName` from `combineK8sName(envSlug, componentSlug)`.

**Prerequisite**: If `tlsClusterIssuer` is not set, custom domains will have no TLS. In production, `EVE_DEFAULT_TLS_CLUSTER_ISSUER` **must** be configured. The ClusterIssuer should support HTTP-01 challenges (see [ClusterIssuer Configuration](#clusterissuer-configuration)).

**Return type update**: `renderManifest()` return value extends from `{ manifestYaml, services, aliasIngresses }` to also include `customDomainIngresses`:
```typescript
interface CustomDomainIngressCandidate {
  hostname: string;
  serviceName: string;
  ingressManifest: string;
  ingressName: string;
  certSecretName: string;
}
```

#### 1d. Domain Binding During Deploy

Parallel to the existing alias binding flow. Includes rate limiting, rollback on failure, and ingress metadata tracking:

```typescript
// After renderManifest, bind custom domains
const desiredDomains = new Set<string>();
const newlyBoundDomains = new Set<string>();
const domainDocuments: string[] = [];

// Rate limit check — before binding any domains
const currentCount = await this.customDomains.countByProject(params.projectId);
const maxDomains = config.EVE_MAX_CUSTOM_DOMAINS_PER_PROJECT ?? 10;
if (currentCount + renderResult.customDomainIngresses.length > maxDomains) {
  this.logger.warn(
    `Project exceeds custom domain limit (${maxDomains}). ` +
    `Has ${currentCount}, trying to add ${renderResult.customDomainIngresses.length}.`
  );
  // Don't fail the deploy — just skip domain processing
}

for (const candidate of renderResult.customDomainIngresses) {
  const bound = await this.customDomains.bindToEnvironment(
    candidate.hostname,
    params.projectId,
    params.environmentId,
    candidate.serviceName,
  );

  if (!bound) {
    this.logger.warn(`Custom domain ${candidate.hostname} claimed by another project`);
    continue;
  }

  desiredDomains.add(candidate.hostname);

  // Track newly-bound domains for rollback on deploy failure
  const existing = await this.customDomains.findByHostname(candidate.hostname);
  if (!existing || existing.environment_id !== params.environmentId) {
    newlyBoundDomains.add(candidate.hostname);
  }

  // Check if DNS resolves to our ingress before applying
  const dnsOk = await this.verifyDns(candidate.hostname);
  if (dnsOk) {
    await this.customDomains.updateStatus(candidate.hostname, 'dns_verified', {
      ingressName: candidate.ingressName,
      certSecretName: candidate.certSecretName,
    });
    // Apply the ingress — cert-manager will handle TLS
    await this.k8sService.applyManifest(namespace, candidate.ingressManifest);
    await this.customDomains.updateStatus(candidate.hostname, 'cert_provisioning');
    domainDocuments.push(candidate.ingressManifest);
  } else {
    await this.customDomains.updateStatus(candidate.hostname, 'pending_dns', {
      ingressName: candidate.ingressName,
      certSecretName: candidate.certSecretName,
    });
    this.logger.warn(
      `Custom domain ${candidate.hostname}: DNS not yet pointing to platform. ` +
      `Point it to ${platformIngressTarget} and re-deploy, or run: eve domain verify ${candidate.hostname}`
    );
  }
}

// Garbage collect custom domain ingresses no longer in manifest
await this.garbageCollectCustomDomainIngresses(namespace, [...desiredDomains]);
```

**Rollback on deploy failure** (parallel to alias rollback):
```typescript
// In the deploy error handler:
if (newlyBoundDomains.size > 0) {
  await this.customDomains.unbindDomainsForEnvironment(
    params.environmentId,
    [...newlyBoundDomains],
  );
}
```

**DNS verification** is a simple DNS lookup — resolve the hostname, check if it points to the platform's ingress IP (A record) or ingress hostname (CNAME). No validation tokens needed.

**Apex domain handling**: Apex domains (e.g., `limelee.com`) cannot use CNAME records per RFC 1034. The DNS verification logic accepts both A and CNAME, but the CLI instructions should recommend A records for apex domains and CNAME for subdomains (e.g., `www.limelee.com`).

#### 1e. Garbage Collection

Parallel to `garbageCollectAliasIngresses()`, add `garbageCollectCustomDomainIngresses()`. Uses the `eve.custom_domain=true` label to find existing custom domain ingresses in the namespace, then deletes any that are no longer in the manifest:

```typescript
private async garbageCollectCustomDomainIngresses(
  namespace: string,
  desiredHostnames: string[],
): Promise<void> {
  const desired = new Set(desiredHostnames.map((h) => h.toLowerCase()));
  const existing = await this.k8sService.listCustomDomainIngresses(namespace);

  for (const ingress of existing) {
    const hostname = ingress.hostname?.toLowerCase();
    if (!hostname || desired.has(hostname)) continue;

    await this.k8sService.deleteIngress(namespace, ingress.name);
    this.logger.log(`Deleted stale custom domain ingress ${ingress.name} (${hostname}) from ${namespace}`);

    // Update DB — mark as removed so we don't keep trying to verify
    await this.customDomains.updateStatus(hostname, 'removed');
  }
}
```

Add to `k8s.service.ts`:
```typescript
async listCustomDomainIngresses(namespace: string): Promise<Array<{ name: string; hostname: string | null }>> {
  const response = await this.networkingApi.listNamespacedIngress(
    namespace,
    undefined, undefined, undefined, undefined,
    'eve.custom_domain=true',  // Label selector
  );
  return (response.body.items ?? []).map((item) => ({
    name: item.metadata?.name ?? '',
    hostname: item.metadata?.labels?.['eve.domain_hostname'] ?? null,
  })).filter((item) => item.name.length > 0);
}
```

#### 1f. API Endpoints

```
POST   /projects/:id/domains              — Register domain(s) from manifest or CLI
GET    /projects/:id/domains              — List domains for project
GET    /projects/:id/domains/:hostname    — Domain detail + status
POST   /projects/:id/domains/:hostname/verify  — Re-check DNS + activate
DELETE /projects/:id/domains/:hostname    — Remove domain + clean up ingress
```

Rate limit enforcement: `POST /projects/:id/domains` checks `countByProject()` against `EVE_MAX_CUSTOM_DOMAINS_PER_PROJECT` before allowing registration.

#### 1g. CLI Commands

```bash
# List domains for a project
eve domain list [--project <slug>] [--json]

# Check DNS and activate (also creates Ingress if DNS is verified)
eve domain verify <hostname> [--project <slug>]

# Show domain status with troubleshooting hints
eve domain status <hostname>

# Remove a custom domain
eve domain remove <hostname> [--project <slug>]
```

**Deferred to Phase 2**: `eve domain add <hostname>` (imperative registration without manifest). Phase 1 is manifest-first only — domains are registered during `eve project sync` and activated during deploy or via `eve domain verify`. This avoids two registration paths and keeps the design simple.

**`eve domain verify`** output example:
```
Checking DNS for limelee.com...
  ✓ limelee.com resolves to 52.18.xx.xx (matches platform ingress)
  ✓ TLS certificate issued by Let's Encrypt
  ✓ Ingress active in namespace eve-pierre-ingest-prod

Status: active
URL: https://limelee.com
```

**`eve domain verify`** when DNS isn't ready (apex domain):
```
Checking DNS for limelee.com...
  ✗ limelee.com does not resolve to platform ingress

To activate this domain, add a DNS record at your registrar:

  limelee.com  A  52.18.xx.xx

  (Apex domains like limelee.com require an A record.
   CNAME records are not allowed at the zone apex per RFC 1034.)

Then run: eve domain verify limelee.com
```

**`eve domain verify`** when DNS isn't ready (subdomain):
```
Checking DNS for www.limelee.com...
  ✗ www.limelee.com does not resolve to platform ingress

To activate this domain, add a DNS record at your registrar:

  Option A (CNAME — recommended for subdomains):
    www.limelee.com  CNAME  ingress.eve.example.com

  Option B (A record):
    www.limelee.com  A  52.18.xx.xx

Then run: eve domain verify www.limelee.com
```

The CLI detects apex vs subdomain by checking if the hostname has exactly one dot (apex) or more (subdomain), and adjusts the DNS instructions accordingly.

### Phase 2: Automation (Nice-to-Have)

- **Periodic DNS re-check**: A cron job that re-verifies `pending_dns` domains every 10 minutes and auto-activates when DNS is ready. This eliminates the manual `eve domain verify` step.
- **Certificate readiness check**: Monitor cert-manager Certificate resources to transition `cert_provisioning` → `active` when the cert is Ready. Without this (Phase 1), `eve domain verify` handles the full transition.
- **Health monitoring**: Check `active` domains for DNS drift — if a domain stops resolving, mark as `dns_error` and alert.
- **`eve domain verify --all`**: Verify all pending domains for a project in one shot.
- **`eve domain add`**: Imperative registration without manifest (for users who want to test DNS before committing to manifest).
- **www redirect**: Optionally generate a redirect Ingress (`www.limelee.com` → `limelee.com` via 301) when both are declared.
- **Environment cleanup**: When an environment is deleted, garbage-collect its custom domain Ingress resources from K8s (the DB records are preserved via `ON DELETE SET NULL`).

#### Recommended status transitions

- `pending_dns` → `dns_verified` when the DNS check confirms platform ownership.
- `dns_verified` → `cert_provisioning` as soon as the ingress is applied.
- `cert_provisioning` → `active` when cert-manager reports the certificate Ready (Phase 2), or when `eve domain verify` confirms both DNS + cert (Phase 1).
- `active` → `dns_error` if periodic DNS checks fail.
- `cert_provisioning`/`active` → `cert_error` if cert issuance or renewal fails.

**Phase 1 shortcut**: `eve domain verify` checks DNS, applies the Ingress if not already applied, then checks the Certificate resource status. If both DNS and cert are good, transitions directly to `active`. This collapses the `dns_verified` → `cert_provisioning` → `active` chain into a single user action.

---

## ClusterIssuer Configuration

Custom domains require HTTP-01 challenges (the user's DNS points to our ingress, and Let's Encrypt validates by hitting `http://<hostname>/.well-known/acme-challenge/...`).

If the platform's existing ClusterIssuer only uses DNS-01 (for wildcard certs like `*.eve.example.com`), custom domains won't work with it — DNS-01 requires DNS provider API credentials, which the platform won't have for user-owned domains.

**Recommended setup**: A single ClusterIssuer with multiple solvers:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      # DNS-01 for platform wildcard certs
      - dns01:
          route53:
            region: eu-west-1
        selector:
          dnsNames:
            - "*.eve.example.com"
      # HTTP-01 for everything else (custom domains + per-host platform certs)
      - http01:
          ingress:
            ingressClassName: traefik
```

cert-manager selects the solver by matching `dnsNames` — platform wildcards use DNS-01, all other hostnames (including custom domains) use HTTP-01.

**If the platform only uses HTTP-01** (no wildcard certs): no changes needed — the existing ClusterIssuer already works for custom domains.

**Verification**: After ClusterIssuer setup, confirm HTTP-01 solver is available:
```bash
kubectl describe clusterissuer letsencrypt-prod
# Look for: "Solver 1: HTTP-01, Ingress class: traefik"
```

---

## DNS Verification Logic

```typescript
import * as dns from 'node:dns/promises';

async verifyDns(hostname: string): Promise<{ ok: boolean; resolvedTo?: string }> {
  const platformTarget = this.getPlatformIngressTarget();
  // platformTarget = { ip: '52.18.xx.xx', hostname: 'ingress.eve.example.com' }

  try {
    // Check A records first — works for both apex and subdomains
    try {
      const addresses = await dns.resolve4(hostname);
      if (addresses.includes(platformTarget.ip)) {
        return { ok: true, resolvedTo: `A ${platformTarget.ip}` };
      }
    } catch {
      // No A records — try CNAME (subdomains only, apex can't have CNAME)
    }

    // Check CNAME — only valid for non-apex hostnames
    try {
      const cnames = await dns.resolveCname(hostname);
      if (cnames.some(c => c === platformTarget.hostname)) {
        return { ok: true, resolvedTo: `CNAME ${platformTarget.hostname}` };
      }

      // CNAME chain: the CNAME might resolve to our IP indirectly
      for (const cname of cnames) {
        const cnameAddresses = await dns.resolve4(cname);
        if (cnameAddresses.includes(platformTarget.ip)) {
          return { ok: true, resolvedTo: `CNAME ${cname} → A ${platformTarget.ip}` };
        }
      }
    } catch {
      // No CNAME records
    }

    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// Helper: detect apex domains (for DNS instruction generation)
isApexDomain(hostname: string): boolean {
  // Apex = exactly one dot: "example.com", not "www.example.com"
  // Edge case: "co.uk" style TLDs — not handled, but acceptable for instructions
  const dots = hostname.split('.').length - 1;
  return dots === 1;
}

// Synchronous — reads from config, no async needed
getPlatformIngressTarget(): { ip: string; hostname: string } {
  const config = loadConfig();
  return {
    ip: config.EVE_PLATFORM_INGRESS_IP ?? '',
    hostname: config.EVE_PLATFORM_INGRESS_HOSTNAME ?? '',
  };
}
```

The return value now includes `resolvedTo` for better `eve domain verify` output (shows the user what DNS record matched).

The platform ingress target comes from new env vars:
```
EVE_PLATFORM_INGRESS_IP=52.18.xx.xx
EVE_PLATFORM_INGRESS_HOSTNAME=ingress.eve.example.com
```

**Note**: At least one of `EVE_PLATFORM_INGRESS_IP` or `EVE_PLATFORM_INGRESS_HOSTNAME` must be set for DNS verification to work. If neither is configured, `verifyDns()` always returns `{ ok: false }` and domains stay in `pending_dns` — they can still be manually activated via the API once the config is set.

---

## Security

| Concern | Mitigation |
|---------|------------|
| **Domain takeover** | DNS must resolve to our ingress before we create the Ingress resource. cert-manager HTTP-01 is the ultimate proof of control — Let's Encrypt won't issue a cert if you don't control the domain. |
| **Hostname collision** | `UNIQUE(hostname)` in database — first project to claim wins. |
| **Platform domain abuse** | Reject hostnames ending with the platform domain (those use `alias`). |
| **Rate limiting** | Max 10 custom domains per project (configurable). Let's Encrypt rate limits protect against cert abuse. |
| **Stale domains** | If DNS stops resolving, domain goes to `dns_error` — ingress stays but cert renewal will fail naturally. Admin can clean up via `eve admin domains` or the domain owner can remove. |

---

## Config Changes

### New Environment Variables

| Variable | Example | Purpose | Required |
|----------|---------|---------|----------|
| `EVE_PLATFORM_INGRESS_IP` | `52.18.xx.xx` | Platform ingress IP for A record verification | Yes (at least one of IP or hostname) |
| `EVE_PLATFORM_INGRESS_HOSTNAME` | `ingress.eve.example.com` | CNAME target for DNS verification | Yes (at least one of IP or hostname) |
| `EVE_MAX_CUSTOM_DOMAINS_PER_PROJECT` | `10` | Rate limit (default: 10) | No |

These go in the config schema (`packages/shared/src/config/schema.ts`) alongside the existing `EVE_DEFAULT_DOMAIN` etc.:

```typescript
EVE_PLATFORM_INGRESS_IP: z.string().optional(),      // Ingress controller IP for DNS verification
EVE_PLATFORM_INGRESS_HOSTNAME: z.string().optional(), // Ingress controller hostname for CNAME verification
EVE_MAX_CUSTOM_DOMAINS_PER_PROJECT: z.coerce.number().int().min(1).default(10),
```

These go in the worker and API deployments. For k3d local dev, the ingress IP is the k3d load balancer IP (typically `127.0.0.1` or the Docker bridge IP).

---

## What Pierre Does

Once implemented:

```yaml
# .eve/manifest.yaml (ingest project)
services:
  web:
    image: ${EVE_REGISTRY}/web:${EVE_RELEASE_TAG}
    ports: [3000]
    x-eve:
      ingress:
        public: true
        alias: limelee
        domains:
          - limelee.com
          - www.limelee.com
```

```bash
# Deploy
eve env deploy pierre-ingest prod

# Eve says: "Custom domains pending DNS. Point limelee.com to ingress.eve.example.com"

# Pierre updates DNS at his registrar, then:
eve domain verify limelee.com
eve domain verify www.limelee.com

# Both come back active. Done.
# https://limelee.com now serves his app with valid Let's Encrypt TLS.
```

---

## Testing

### Unit Tests
- Manifest parsing: `domains` array validation (valid FQDNs, rejects platform domain suffixes, length limits)
- Manifest parsing: rejects duplicate hostnames across services within same manifest
- Manifest parsing: `.max(10)` per-service array limit
- Zod schema: case-insensitive input normalizes to lowercase output
- DNS verification logic: mock DNS resolution scenarios (A match, CNAME match, CNAME chain, no match, DNS error)
- Apex domain detection: `limelee.com` → apex, `www.limelee.com` → subdomain
- Ingress generation: custom domain ingress has correct host, TLS, labels, backend service name
- Ingress generation: `EVE_DEFAULT_TLS_SECRET` is NOT used for custom domain TLS (only `tlsClusterIssuer`)
- Ingress generation: no TLS block when `tlsClusterIssuer` is not set
- Resource naming: long hostnames don't cause truncation collisions

### Integration Tests
- Deploy with domains in manifest → registers domains as `pending_dns`
- Hostnames under platform domain (e.g., `foo.eve.example.com`) rejected during manifest validation
- Duplicate hostnames in a single manifest are rejected before deploy
- `eve domain verify` with DNS pointing correctly → transitions to `active`
- `eve domain verify` with DNS not ready → stays `pending_dns` with correct instructions (A for apex, CNAME for subdomain)
- Hostname uniqueness: second project claiming same hostname gets rejected
- `eve domain remove` cleans up database record and K8s Ingress
- Re-deploy without domain in manifest → garbage collects the K8s Ingress (label-based)
- Rate limit: project with 10 domains rejects 11th
- Deploy rollback: newly-bound domains are unbound on deploy failure
- Project deletion cascades to custom_domains records
- Environment deletion nullifies environment_id but preserves domain record

### Manual Tests (Staging)
- End-to-end with a real domain pointing to staging ingress
- cert-manager issues cert within ~60 seconds of Ingress creation
- HTTPS works with valid certificate (no browser warnings)
- `eve domain list` shows all domains with correct status
- `eve domain verify` provides actionable instructions for pending domains

---

## Migration Path from `dns-integration-plan.md`

The original plan had two halves:
1. **Platform subdomains** — Already implemented via the existing `{component}.{org}-{project}-{env}.{domain}` pattern
2. **Custom domains** — This plan supersedes that section with a simpler, more practical design

Key simplifications from the original plan:
- **No validation tokens** — DNS resolution + HTTP-01 challenge is sufficient proof of ownership
- **No `domains` type field** — Everything in this table is a custom domain (platform subdomains are derived, not stored)
- **No `platform` type records** — Platform subdomains don't need database entries
- **Simpler lifecycle** — 7 states → 7 states but `pending_dns` replaces `pending_validation` (more descriptive)
- **Manifest-first** — Domains live in `x-eve.ingress.domains` alongside `alias`, not in a separate `environments.domains` block
