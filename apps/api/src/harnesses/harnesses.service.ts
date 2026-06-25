import { Injectable, NotFoundException } from '@nestjs/common';
import {
  getHarnessAuthStatus,
  getHarnessInfo,
  getHarnessCapability,
  listHarnesses,
  listHarnessVariants,
  resolveHarnessName,
  extractSecretRefs,
  type EnvOverrides,
  type HarnessProfileValidateRequest,
  type HarnessProfileValidateResponse,
  type InlineProfileBundle,
  type SecretRefReport,
  type HarnessValidateWarning,
} from '@eve/shared';
import type { HarnessInfoResponse, HarnessListResponse } from '@eve/shared';
import { SecretsService } from '../secrets/secrets.service.js';

export interface HarnessListOptions {
  orgId?: string;
  projectId?: string;
}

export interface ValidateInlineOverrideOptions {
  projectId: string;
  userId?: string;
  request: HarnessProfileValidateRequest;
}

@Injectable()
export class HarnessesService {
  constructor(private readonly secretsService: SecretsService) {}

  async list(options?: HarnessListOptions): Promise<HarnessListResponse> {
    const env = await this.resolveEnv(options);
    const data = listHarnesses().map((harness) => this.formatHarness(harness, env));
    return { data };
  }

  async get(name: string, options?: HarnessListOptions): Promise<HarnessInfoResponse> {
    const canonical = resolveHarnessName(name);
    if (!canonical) {
      throw new NotFoundException(`Unknown harness: ${name}`);
    }

    const harness = getHarnessInfo(canonical);
    if (!harness) {
      throw new NotFoundException(`Unknown harness: ${name}`);
    }

    const env = await this.resolveEnv(options);
    return this.formatHarness(harness, env);
  }

  /**
   * Dry-run validate an inline harness profile override + env_overrides
   * without creating a job or spending any inference budget.
   *
   * Intentionally does NOT return a command-line argv preview — that would
   * couple the API image to the harness-runner package
   * (`@eve/eve-agent-cli`) and every adapter change would shake this
   * service. Callers who want the would-be argv can invoke
   * `eve-agent-cli --build-command-only` client-side.
   *
   * docs/plans/per-job-harness-override-plan.md §3.5
   */
  async validateInlineOverride(
    options: ValidateInlineOverrideOptions,
  ): Promise<HarnessProfileValidateResponse> {
    const { projectId, userId, request } = options;
    const override: InlineProfileBundle | undefined = request.harness_profile_override;
    const envOverrides: EnvOverrides | undefined = request.env_overrides;

    const warnings: HarnessValidateWarning[] = [];

    // 1. Harness resolution + auth check (only when override present).
    const requestedName = override?.harness ?? '';
    const canonicalName = requestedName ? resolveHarnessName(requestedName) ?? null : null;
    const harnessReport = {
      requested: requestedName,
      canonical: canonicalName,
      auth: null as HarnessInfoResponse['auth'] | null,
    };

    // 2. Resolve project secrets once (scope metadata on each item).
    const resolved = await this.secretsService.resolveForProject(projectId, userId);
    const resolvedEnv: Record<string, string> = Object.fromEntries(
      resolved.map((s) => [s.key, s.value]),
    );
    const resolvedScope = new Map<string, 'system' | 'org' | 'user' | 'project'>(
      resolved.map((s) => [s.key, s.scope_type]),
    );

    if (override && canonicalName) {
      harnessReport.auth = getHarnessAuthStatus(canonicalName, resolvedEnv);
    } else if (override && !canonicalName) {
      warnings.push({
        code: 'harness.unknown',
        message: `Unknown harness "${requestedName}". Known harnesses: ${listHarnesses().map((h) => h.name).join(', ')}`,
      });
    }

    // 3. Per-secret-ref status with scope.
    const secretRefs = envOverrides ? extractSecretRefs(envOverrides) : [];
    const envReports: SecretRefReport[] = secretRefs.map((key) => {
      const scope = resolvedScope.get(key);
      if (scope) {
        return { key, status: 'resolved' as const, resolved_at: scope };
      }
      return {
        key,
        status: 'missing' as const,
        hint: `Set secret ${key} at org or project scope (eve secrets set ${key} <value> --project ${projectId}).`,
      };
    });

    const authOk = override ? harnessReport.auth?.available === true : true;
    const harnessKnown = override ? canonicalName !== null : true;
    const envOk = envReports.every((r) => r.status === 'resolved');

    return {
      ok: harnessKnown && authOk && envOk,
      harness: harnessReport,
      env_overrides: envReports,
      warnings,
    };
  }

  private async resolveEnv(options?: HarnessListOptions): Promise<Record<string, string> | undefined> {
    if (!options) return undefined;

    // Project scope takes precedence over org scope
    if (options.projectId) {
      const secrets = await this.secretsService.resolveForProject(options.projectId);
      return Object.fromEntries(secrets.map((s) => [s.key, s.value]));
    }

    if (options.orgId) {
      const secrets = await this.secretsService.resolveForOrg(options.orgId);
      return Object.fromEntries(secrets.map((s) => [s.key, s.value]));
    }

    return undefined;
  }

  private formatHarness(
    harness: NonNullable<ReturnType<typeof getHarnessInfo>>,
    env?: Record<string, string>,
  ): HarnessInfoResponse {
    return {
      name: harness.name,
      aliases: harness.aliases,
      description: harness.description,
      variants: listHarnessVariants(harness),
      auth: getHarnessAuthStatus(harness.name, env),
      capabilities: getHarnessCapability(harness.name),
    };
  }
}
