import { Injectable, Logger } from '@nestjs/common';
import yaml from 'yaml';
import { loadConfig, resolveProjectSecrets } from '@eve/shared';
import { RegistryAuth, RegistryConfig } from './image-builder.interface.js';

@Injectable()
export class RegistryAuthService {
  private readonly logger = new Logger(RegistryAuthService.name);

  /**
   * Resolve registry authentication from manifest and project secrets.
   *
   * Two paths:
   * - `registry: "eve"` — requests a push-scoped JWT from the Eve API internal endpoint
   * - `registry: { host, ... }` — resolves username/token from project secrets (BYO registry)
   */
  async resolve(
    projectId: string,
    manifestYaml: string,
  ): Promise<{ auth: RegistryAuth; config: RegistryConfig }> {
    const parsed = yaml.parse(manifestYaml) as {
      registry?:
        | string
        | {
            host?: string;
            namespace?: string;
            auth?: { username_secret?: string; token_secret?: string };
          };
    } | null;

    const registry = parsed?.registry;

    // ── Eve-native registry ─────────────────────────────────────────────
    if (registry === 'eve') {
      return this.resolveEveRegistry();
    }

    // ── BYO registry (existing path) ────────────────────────────────────
    const registryObj =
      typeof registry === 'object' ? registry : undefined;
    return this.resolveByoRegistry(projectId, registryObj);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Eve-native registry: fetch a push-scoped token from the internal API
  // ────────────────────────────────────────────────────────────────────────

  private async resolveEveRegistry(): Promise<{
    auth: RegistryAuth;
    config: RegistryConfig;
  }> {
    const config = loadConfig();
    const host = config.EVE_REGISTRY_HOST;

    if (!host) {
      throw new Error(
        'Eve registry not configured: EVE_REGISTRY_HOST is not set',
      );
    }

    if (!config.EVE_INTERNAL_API_KEY) {
      throw new Error(
        'Eve registry requires EVE_INTERNAL_API_KEY for BuildKit auth',
      );
    }

    // Use the internal API key as the docker config password.
    // BuildKit follows the Docker v2 token auth flow: the registry challenges
    // with 401, BuildKit GETs the token endpoint with Basic auth (these creds),
    // and the API issues a scoped JWT.
    const username = 'eve-token';
    const password = config.EVE_INTERNAL_API_KEY;

    const dockerConfigJson = this.buildDockerConfigJson(host, username, password);

    const registryConfig: RegistryConfig = { host };
    const registryAuth: RegistryAuth = {
      host,
      username,
      token: password,
      dockerConfigJson,
    };

    this.logger.log(`Resolved Eve-native registry auth for ${host}`);

    return { auth: registryAuth, config: registryConfig };
  }

  /**
   * Request a push-scoped JWT token from the Eve API internal registry endpoint.
   */
  private async requestRegistryToken(config: {
    EVE_API_URL: string;
    EVE_INTERNAL_API_KEY?: string;
  }): Promise<string> {
    const url = `${config.EVE_API_URL}/internal/registry/token`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.EVE_INTERNAL_API_KEY
          ? { 'x-eve-internal-token': config.EVE_INTERNAL_API_KEY }
          : {}),
      },
      body: JSON.stringify({
        scope: 'repository:*:push,pull',
        service: 'eve-registry',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Failed to obtain Eve registry token: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
      );
    }

    const data = (await response.json()) as { token: string; expires_in: number };

    if (!data.token) {
      throw new Error(
        'Eve registry token response missing "token" field',
      );
    }

    return data.token;
  }

  // ────────────────────────────────────────────────────────────────────────
  // BYO registry: resolve credentials from project secrets
  // ────────────────────────────────────────────────────────────────────────

  private async resolveByoRegistry(
    projectId: string,
    registry:
      | {
          host?: string;
          namespace?: string;
          auth?: { username_secret?: string; token_secret?: string };
        }
      | undefined,
  ): Promise<{ auth: RegistryAuth; config: RegistryConfig }> {
    const host = registry?.host;

    if (!host) {
      throw new Error('Registry host not configured in manifest');
    }

    // Resolve secrets via internal API
    const result = await resolveProjectSecrets(projectId);
    if (!result.resolved) {
      throw new Error(
        `Cannot resolve secrets for registry auth: ${result.error}`,
      );
    }

    const usernameKey = registry?.auth?.username_secret ?? 'GHCR_USERNAME';
    const tokenKey = registry?.auth?.token_secret ?? 'GITHUB_TOKEN';

    const username = result.secrets.find(
      (secret) => secret.key === usernameKey,
    )?.value;
    const token =
      result.secrets.find((secret) => secret.key === tokenKey)?.value ??
      result.secrets.find((secret) => secret.key === 'GH_TOKEN')?.value;

    if (!username || !token) {
      throw new Error(
        `Registry auth missing for ${host}. Expected secrets: ${usernameKey} and ${tokenKey}`,
      );
    }

    const dockerConfigJson = this.buildDockerConfigJson(host, username, token);

    const registryConfig: RegistryConfig = {
      host,
      namespace: registry?.namespace,
      auth: registry?.auth
        ? {
            username_secret: registry.auth.username_secret,
            token_secret: registry.auth.token_secret,
          }
        : undefined,
    };

    const registryAuth: RegistryAuth = {
      host,
      username,
      token,
      dockerConfigJson,
    };

    this.logger.log(`Resolved registry auth for ${host}`);

    return { auth: registryAuth, config: registryConfig };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Shared helpers
  // ────────────────────────────────────────────────────────────────────────

  private buildDockerConfigJson(
    host: string,
    username: string,
    password: string,
  ): string {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const dockerConfig = {
      auths: {
        [host]: { username, password, auth },
      },
    };
    return Buffer.from(JSON.stringify(dockerConfig)).toString('base64');
  }
}
