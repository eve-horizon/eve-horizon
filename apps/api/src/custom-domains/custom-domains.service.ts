import { Inject, Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { customDomainQueries, environmentQueries, projectManifestQueries } from '@eve/db';
import { loadConfig, isPlatformDomainHostname, generateCustomDomainId, type Manifest } from '@eve/shared';
import * as dns from 'node:dns/promises';
import * as yaml from 'yaml';
import { ensureManifestEnvironment } from '../environments/manifest-environment.js';

@Injectable()
export class CustomDomainsService {
  private customDomains: ReturnType<typeof customDomainQueries>;
  private environments: ReturnType<typeof environmentQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.customDomains = customDomainQueries(db);
    this.environments = environmentQueries(db);
    this.manifests = projectManifestQueries(db);
  }

  async listByProject(projectId: string) {
    const domains = await this.customDomains.findByProject(projectId);
    const serialized = await Promise.all(domains.map((d) => this.serializeWithEnv(d)));
    return { data: serialized };
  }

  async getByHostname(projectId: string, hostname: string) {
    const domain = await this.customDomains.findByHostname(hostname.toLowerCase());
    if (!domain || domain.project_id !== projectId) {
      throw new NotFoundException(`Domain "${hostname}" not found for this project`);
    }
    return this.serializeWithEnv(domain);
  }

  async transfer(projectId: string, hostname: string, body: { to_environment: string }) {
    const normalized = hostname.trim().toLowerCase();
    const domain = await this.customDomains.findByHostname(normalized);
    if (!domain || domain.project_id !== projectId) {
      throw new NotFoundException(`Domain "${hostname}" not found for this project`);
    }

    const target = await this.resolveEnvironment(projectId, body.to_environment);
    if (!target) {
      throw new NotFoundException(
        `Environment "${body.to_environment}" not found in this project`,
      );
    }

    const previousEnvId = domain.environment_id;
    const previousEnvName = previousEnvId
      ? (await this.environments.findById(previousEnvId))?.name ?? null
      : null;

    if (previousEnvId === target.id) {
      // No-op: already bound to target
      return {
        hostname: domain.hostname,
        previous_environment_id: previousEnvId,
        previous_environment_name: previousEnvName,
        new_environment_id: target.id,
        new_environment_name: target.name,
        unchanged: true,
        next_steps: `Domain already bound to "${target.name}" — no action taken.`,
      };
    }

    const updated = await this.customDomains.transferToEnvironment(
      normalized,
      projectId,
      target.id,
    );

    if (!updated) {
      throw new ConflictException(`Failed to transfer "${hostname}"`);
    }

    const next = previousEnvName
      ? `Redeploy both envs to reconcile ingresses: \`eve env deploy ${previousEnvName}\` removes the stale ingress, \`eve env deploy ${target.name}\` creates the new one.`
      : `Deploy \`${target.name}\` to create the ingress for this hostname.`;

    return {
      hostname: updated.hostname,
      previous_environment_id: previousEnvId,
      previous_environment_name: previousEnvName,
      new_environment_id: target.id,
      new_environment_name: target.name,
      unchanged: false,
      next_steps: next,
    };
  }

  async unbind(projectId: string, hostname: string) {
    const normalized = hostname.trim().toLowerCase();
    const domain = await this.customDomains.findByHostname(normalized);
    if (!domain || domain.project_id !== projectId) {
      throw new NotFoundException(`Domain "${hostname}" not found for this project`);
    }

    const previousEnvId = domain.environment_id;
    const previousEnvName = previousEnvId
      ? (await this.environments.findById(previousEnvId))?.name ?? null
      : null;

    if (!previousEnvId) {
      return {
        hostname: domain.hostname,
        previous_environment_id: null,
        previous_environment_name: null,
        unchanged: true,
        next_steps: 'Domain was already unbound — any env deploy can claim it next.',
      };
    }

    const updated = await this.customDomains.unbindHostname(normalized, projectId);
    if (!updated) {
      throw new ConflictException(`Failed to unbind "${hostname}"`);
    }

    return {
      hostname: updated.hostname,
      previous_environment_id: previousEnvId,
      previous_environment_name: previousEnvName,
      unchanged: false,
      next_steps: previousEnvName
        ? `Redeploy \`${previousEnvName}\` to remove its stale ingress. The next env deploy that declares this domain will claim it.`
        : 'The next env deploy that declares this domain will claim it.',
    };
  }

  private async resolveEnvironment(projectId: string, envRef: string) {
    const byName = await this.environments.findByProjectAndName(projectId, envRef);
    if (byName) return byName;
    const byId = await this.environments.findById(envRef);
    if (byId && byId.project_id === projectId) return byId;
    return null;
  }

  async register(projectId: string, body: { hostname: string; service_name: string; environment?: string }) {
    const hostname = body.hostname.trim().toLowerCase();

    // Validate not a platform domain
    const config = loadConfig();
    const platformDomain = config.EVE_DEFAULT_DOMAIN ?? '';
    if (platformDomain && isPlatformDomainHostname(hostname, platformDomain)) {
      throw new BadRequestException(
        `"${hostname}" is under the platform domain — use ingress alias instead`,
      );
    }

    const existing = await this.customDomains.findByHostname(hostname);
    if (existing && existing.project_id !== projectId) {
      throw new ConflictException(`Domain "${hostname}" is already claimed by another project`);
    }

    const targetEnvironment = body.environment
      ? await this.resolveOrEnsureManifestEnvironment(projectId, body.environment)
      : null;

    // Rate limit
    const maxDomains = config.EVE_MAX_CUSTOM_DOMAINS_PER_PROJECT ?? 10;
    const count = existing ? 0 : await this.customDomains.countByProject(projectId);
    if (!existing && count >= maxDomains) {
      throw new ConflictException(
        `Project has ${count} custom domains (max ${maxDomains})`,
      );
    }

    const result = await this.customDomains.claimOrUpdate({
      id: generateCustomDomainId(),
      hostname,
      project_id: projectId,
      service_name: body.service_name,
      source: 'manual',
    });

    if (!result) {
      throw new ConflictException(`Domain "${hostname}" is already claimed by another project`);
    }

    if (targetEnvironment) {
      if (result.environment_id && result.environment_id !== targetEnvironment.id) {
        const owner = await this.environments.findById(result.environment_id);
        const ownerName = owner?.name ?? result.environment_id;
        throw new ConflictException(
          `Domain "${hostname}" is already owned by environment "${ownerName}". ` +
          `To move it, run: eve domain transfer ${hostname} --to ${targetEnvironment.name}`,
        );
      }

      const wasUnchanged = result.environment_id === targetEnvironment.id;
      const bound = await this.customDomains.bindToEnvironment(
        hostname,
        projectId,
        targetEnvironment.id,
        body.service_name,
        'manual',
      );
      if (!bound) {
        throw new ConflictException(
          `Domain "${hostname}" is already owned by another environment. ` +
          `Run eve domain transfer ${hostname} --to ${targetEnvironment.name}`,
        );
      }

      const serialized = await this.serializeWithEnv(bound);
      if (!serialized) {
        throw new ConflictException(`Failed to register "${hostname}"`);
      }
      return {
        ...serialized,
        unchanged: wasUnchanged,
        next_steps: wasUnchanged
          ? `Domain already bound to "${targetEnvironment.name}" — no action taken.`
          : `Point DNS at the platform ingress, then run: eve domain verify ${hostname}`,
      };
    }

    const serialized = await this.serializeWithEnv(result);
    if (!serialized) {
      throw new ConflictException(`Failed to register "${hostname}"`);
    }
    return {
      ...serialized,
      unchanged: Boolean(existing),
      next_steps: result.environment_id
        ? `Domain is already bound to an environment. Use eve domain transfer ${hostname} --to <env> to move it.`
        : `Domain registered unbound. The next deploy that declares "${hostname}" can claim it, or run eve domain transfer ${hostname} --to <env>.`,
    };
  }

  async verify(projectId: string, hostname: string) {
    const domain = await this.customDomains.findByHostname(hostname.toLowerCase());
    if (!domain || domain.project_id !== projectId) {
      throw new NotFoundException(`Domain "${hostname}" not found for this project`);
    }

    const target = this.getPlatformIngressTarget();

    // Perform actual DNS resolution
    const dnsResult = await this.verifyDns(hostname, target);

    // Update status if DNS now resolves correctly
    if (dnsResult.ok && (domain.status === 'pending_dns' || domain.status === 'dns_error')) {
      await this.customDomains.updateStatus(hostname.toLowerCase(), 'dns_verified');
    } else if (!dnsResult.ok && domain.status === 'dns_verified') {
      await this.customDomains.updateStatus(hostname.toLowerCase(), 'pending_dns');
    }

    // Re-read after potential status update
    const updated = await this.customDomains.findByHostname(hostname.toLowerCase());

    const current = updated ?? domain;

    // Build actionable instructions
    let instructions: string;
    const warnings: string[] = [];
    if (dnsResult.ok) {
      instructions = `DNS verified (${dnsResult.resolvedTo}). Redeploy to activate: eve env deploy`;
      if (!current.environment_id) {
        warnings.push('Domain is not bound to an environment — deploy or re-sync manifest to bind it');
      }
    } else {
      instructions = this.getDnsInstructions(hostname, target);
    }

    return {
      ...(await this.serializeWithEnv(current)),
      platform_ingress: {
        ips: target.ips.length > 0 ? target.ips : undefined,
        hostname: target.hostname || undefined,
      },
      dns_result: dnsResult.ok
        ? { verified: true, resolved_to: dnsResult.resolvedTo }
        : { verified: false },
      instructions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async remove(projectId: string, hostname: string) {
    const domain = await this.customDomains.findByHostname(hostname.toLowerCase());
    if (!domain || domain.project_id !== projectId) {
      throw new NotFoundException(`Domain "${hostname}" not found for this project`);
    }

    await this.customDomains.release(hostname, projectId);

    return {
      hostname: domain.hostname,
      removed: true,
    };
  }

  private serialize(domain: Awaited<ReturnType<ReturnType<typeof customDomainQueries>['findByHostname']>>) {
    if (!domain) return null;
    const states = this.deriveStatusStates(domain.status);
    return {
      id: domain.id,
      hostname: domain.hostname,
      project_id: domain.project_id,
      environment_id: domain.environment_id,
      environment_name: null as string | null,
      owner_env: null as { id: string; name: string } | null,
      service_name: domain.service_name,
      status: domain.status,
      dns_state: states.dns_state,
      cert_state: states.cert_state,
      last_verified_at: domain.verified_at?.toISOString() ?? null,
      ingress_name: domain.ingress_name,
      verified_at: domain.verified_at?.toISOString() ?? null,
      created_at: domain.created_at.toISOString(),
      updated_at: domain.updated_at.toISOString(),
    };
  }

  private async serializeWithEnv(
    domain: Awaited<ReturnType<ReturnType<typeof customDomainQueries>['findByHostname']>>,
  ) {
    const base = this.serialize(domain);
    if (!base || !base.environment_id) return base;
    try {
      const env = await this.environments.findById(base.environment_id);
      return {
        ...base,
        environment_name: env?.name ?? null,
        owner_env: env ? { id: env.id, name: env.name } : null,
      };
    } catch {
      return base;
    }
  }

  private deriveStatusStates(status: string): {
    dns_state: 'pending' | 'verified' | 'error' | 'unknown';
    cert_state: 'not_requested' | 'provisioning' | 'active' | 'error' | 'unknown';
  } {
    switch (status) {
      case 'pending_dns':
        return { dns_state: 'pending', cert_state: 'not_requested' };
      case 'dns_verified':
        return { dns_state: 'verified', cert_state: 'not_requested' };
      case 'cert_provisioning':
        return { dns_state: 'verified', cert_state: 'provisioning' };
      case 'active':
        return { dns_state: 'verified', cert_state: 'active' };
      case 'dns_error':
        return { dns_state: 'error', cert_state: 'unknown' };
      case 'cert_error':
        return { dns_state: 'verified', cert_state: 'error' };
      default:
        return { dns_state: 'unknown', cert_state: 'unknown' };
    }
  }

  private async resolveOrEnsureManifestEnvironment(projectId: string, envRef: string) {
    const existing = await this.resolveEnvironment(projectId, envRef);
    if (existing) return existing;

    const manifestRecord = await this.manifests.findLatestByProject(projectId);
    const manifest = manifestRecord ? yaml.parse(manifestRecord.manifest_yaml) as Manifest : null;
    if (manifest?.environments?.[envRef]) {
      const materialized = await ensureManifestEnvironment(this.environments, projectId, envRef, manifest);
      if (materialized) return materialized;
    }

    throw new NotFoundException(
      `Environment "${envRef}" does not exist for this project. Add it to environments.${envRef} in the manifest and run eve project sync, or create it with eve env create ${envRef} --project ${projectId}.`,
    );
  }

  private getPlatformIngressTarget(): { ips: string[]; hostname: string } {
    const config = loadConfig();
    const rawIp = config.EVE_PLATFORM_INGRESS_IP ?? '';
    const ips = rawIp.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      ips,
      hostname: config.EVE_PLATFORM_INGRESS_HOSTNAME ?? '',
    };
  }

  private async verifyDns(
    hostname: string,
    target: { ips: string[]; hostname: string },
  ): Promise<{ ok: boolean; resolvedTo?: string }> {
    if (target.ips.length === 0 && !target.hostname) {
      return { ok: false };
    }

    try {
      // Check A records
      try {
        const addresses = await dns.resolve4(hostname);
        const matchedIp = target.ips.find((ip) => addresses.includes(ip));
        if (matchedIp) {
          return { ok: true, resolvedTo: `A ${matchedIp}` };
        }
      } catch {
        // No A records
      }

      // Check CNAME
      try {
        const cnames = await dns.resolveCname(hostname);
        if (target.hostname && cnames.some((c) => c === target.hostname)) {
          return { ok: true, resolvedTo: `CNAME ${target.hostname}` };
        }

        // Follow CNAME chain to check if it resolves to our IPs
        if (target.ips.length > 0) {
          for (const cname of cnames) {
            try {
              const cnameAddresses = await dns.resolve4(cname);
              const matchedIp = target.ips.find((ip) => cnameAddresses.includes(ip));
              if (matchedIp) {
                return { ok: true, resolvedTo: `CNAME ${cname} → A ${matchedIp}` };
              }
            } catch {
              // CNAME target doesn't resolve
            }
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

  private getDnsInstructions(hostname: string, target: { ips: string[]; hostname: string }): string {
    const isApex = hostname.split('.').length === 2;

    if (isApex) {
      if (target.ips.length > 0) {
        const records = target.ips.map((ip) => `${hostname} → A ${ip}`).join(', ');
        return `Add A record(s): ${records}`;
      }
      return 'Configure EVE_PLATFORM_INGRESS_IP to get DNS instructions';
    }

    if (target.hostname) {
      return `Add a CNAME record: ${hostname} → ${target.hostname}`;
    }
    if (target.ips.length > 0) {
      const records = target.ips.map((ip) => `${hostname} → A ${ip}`).join(', ');
      return `Add A record(s): ${records}`;
    }
    return 'Configure EVE_PLATFORM_INGRESS_IP or EVE_PLATFORM_INGRESS_HOSTNAME';
  }
}
