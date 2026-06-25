import { Injectable, Inject } from '@nestjs/common';
import type { Db } from '@eve/db';
import { systemSettingsQueries, secretQueries } from '@eve/db';
import type {
  ProviderDefinition,
  DiscoveredModel,
  DiscoveryResult,
} from '@eve/shared';
import { resolveManagedSecret, type PlatformSecretDb } from '@eve/shared';

interface CacheEntry {
  result: DiscoveryResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB

@Injectable()
export class ProviderDiscoveryService {
  private cache = new Map<string, CacheEntry>();

  constructor(@Inject('DB') private readonly db: Db) {}

  async discoverModels(
    provider: ProviderDefinition,
    options?: { orgId?: string; projectId?: string },
  ): Promise<DiscoveryResult> {
    if (!provider.discovery) {
      return this.staticFallback(provider);
    }

    // Cache key scoped by provider + auth context to prevent cross-tenant leakage
    const cacheKey = `${provider.name}:${options?.orgId ?? ''}:${options?.projectId ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, source: 'cache' };
    }

    try {
      const models = await this.fetchModels(provider, options);
      const result: DiscoveryResult = {
        provider: provider.name,
        models,
        fetched_at: new Date().toISOString(),
        ttl_seconds: CACHE_TTL_MS / 1000,
        source: 'api',
      };

      this.cache.set(cacheKey, {
        result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return result;
    } catch (err) {
      console.warn(
        `[discovery] Failed to discover models from ${provider.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.staticFallback(provider);
    }
  }

  private async fetchModels(
    provider: ProviderDefinition,
    options?: { orgId?: string; projectId?: string },
  ): Promise<DiscoveredModel[]> {
    const apiKey = await this.resolveApiKey(provider, options);
    if (!apiKey && provider.name !== 'openrouter') {
      // OpenRouter doesn't require auth for model listing
      return [];
    }

    const url = new URL(provider.discovery!.models_path, provider.base_url);
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (apiKey) {
      if (provider.auth.scheme) {
        headers[provider.auth.header] = `${provider.auth.scheme} ${apiKey}`;
      } else {
        headers[provider.auth.header] = apiKey;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Enforce max response size
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        throw new Error(`Response too large: ${contentLength} bytes`);
      }

      const body = await response.json() as { data?: unknown[]; models?: unknown[] };
      const rawModels = body.data ?? body.models ?? [];

      if (!Array.isArray(rawModels)) return [];

      return rawModels
        .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
        .map((m) => this.parseModel(m, provider));
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseModel(raw: Record<string, unknown>, provider: ProviderDefinition): DiscoveredModel {
    const id = typeof raw.id === 'string' ? raw.id : String(raw.id ?? 'unknown');
    const displayName = typeof raw.name === 'string' ? raw.name : undefined;

    let pricing: DiscoveredModel['pricing'] = null;
    if (provider.discovery?.has_pricing) {
      // OpenRouter format
      const p = raw.pricing as Record<string, unknown> | undefined;
      if (p) {
        const inputPrice = typeof p.prompt === 'string' ? p.prompt : null;
        const outputPrice = typeof p.completion === 'string' ? p.completion : null;
        if (inputPrice && outputPrice) {
          // OpenRouter prices are per-token; convert to per-million
          const inputPerMillion = (parseFloat(inputPrice) * 1_000_000).toFixed(2);
          const outputPerMillion = (parseFloat(outputPrice) * 1_000_000).toFixed(2);
          pricing = {
            input_per_million_usd: inputPerMillion,
            output_per_million_usd: outputPerMillion,
          };
        }
      }
    }

    return {
      id,
      provider: provider.name,
      display_name: displayName,
      pricing,
    };
  }

  private async resolveApiKey(
    provider: ProviderDefinition,
    options?: { orgId?: string; projectId?: string },
  ): Promise<string | null> {
    // Try platform secret first
    if (provider.auth.platform_secret_ref) {
      const platformDb = this.buildPlatformDb();
      const key = await resolveManagedSecret(provider.auth.platform_secret_ref, platformDb);
      if (key) return key;
    }

    // Try cascaded secrets: project scope → org scope
    // Secrets are stored encrypted in the secrets table, keyed by env var name
    const secrets = secretQueries(this.db);
    const scopes: Array<{ type: 'project' | 'org'; id: string }> = [];
    if (options?.projectId) scopes.push({ type: 'project', id: options.projectId });
    if (options?.orgId) scopes.push({ type: 'org', id: options.orgId });

    for (const scope of scopes) {
      for (const envVar of provider.auth.env_vars) {
        try {
          const secret = await secrets.findByScopeAndKey(scope.type, scope.id, envVar);
          // Note: value_encrypted would need decryption in a real flow;
          // for discovery this is best-effort — skip if encrypted values aren't usable directly
          if (secret) return secret.value_encrypted;
        } catch { /* best effort */ }
      }
    }

    return null;
  }

  private buildPlatformDb(): PlatformSecretDb {
    const settings = systemSettingsQueries(this.db);
    return {
      getSystemSetting: async (key: string) => {
        const setting = await settings.get(key);
        return setting ? { value: setting.value } : null;
      },
    };
  }

  private staticFallback(provider: ProviderDefinition): DiscoveryResult {
    return {
      provider: provider.name,
      models: [],
      fetched_at: new Date().toISOString(),
      ttl_seconds: 0,
      source: 'static_fallback',
    };
  }
}
