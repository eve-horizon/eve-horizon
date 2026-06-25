import type { GatewayProvider, ProviderConfig } from './gateway-provider.interface.js';
import { createJsonLogger } from '@eve/shared';

const logger = createJsonLogger('gateway');

/**
 * Factory that creates a fresh GatewayProvider instance for each integration.
 * Each integration gets its own provider instance so that connection state,
 * tokens, and signing secrets are naturally isolated.
 */
export interface GatewayProviderFactory {
  create(): GatewayProvider;
}

/**
 * Registry for gateway provider factories and active instances.
 *
 * Lifecycle:
 *   1. On gateway boot, register factories for each known provider type.
 *   2. Fetch active integrations from the API and call initializeAll().
 *   3. On shutdown, call shutdownAll() for graceful cleanup.
 *
 * For webhook providers the registry is a lookup table -- the webhook
 * controller fetches the provider by name and delegates validation/parsing.
 *
 * For subscription providers, initialize() starts relay connections and
 * the provider manages its own event loop.
 */
export class GatewayProviderRegistry {
  /** Provider factories: provider name -> factory */
  private factories = new Map<string, GatewayProviderFactory>();

  /** Active instances: "provider:account_id" -> initialized instance */
  private instances = new Map<string, GatewayProvider>();

  registerFactory(name: string, factory: GatewayProviderFactory): void {
    this.factories.set(name, factory);
  }

  /** Get an active instance by provider name + account_id */
  getInstance(provider: string, accountId: string): GatewayProvider | undefined {
    return this.instances.get(`${provider}:${accountId}`);
  }

  /**
   * Get any active instance by provider name.
   *
   * Useful for webhook routing where the account_id is unknown until the
   * payload is parsed (e.g. Slack team_id is inside the event body, not in
   * the URL). Returns the first match.
   */
  getByProvider(provider: string): GatewayProvider | undefined {
    for (const [key, instance] of this.instances) {
      if (key.startsWith(`${provider}:`)) return instance;
    }
    return undefined;
  }

  /** Initialize all integrations. Called on gateway startup. */
  async initializeAll(integrations: IntegrationRow[]): Promise<void> {
    for (const integration of integrations) {
      await this.initializeOne(integration);
    }
  }

  /** Initialize a single integration (or re-initialize on config change). */
  async initializeOne(integration: IntegrationRow): Promise<void> {
    const factory = this.factories.get(integration.provider);
    if (!factory) return;

    const key = `${integration.provider}:${integration.account_id}`;

    // Shutdown existing instance if reinitializing
    const existing = this.instances.get(key);
    if (existing) {
      await existing.shutdown();
    }

    const settings = {
      ...(integration.tokens_json ?? {}),
      ...(integration.provider === 'webchat' ? (integration.settings_json ?? {}) : {}),
    };
    // Merge signing secret from integration settings_json (populated from per-org oauth_app_configs by the API)
    if (integration.provider === 'slack' && integration.settings_json?.signing_secret) {
      settings.signing_secret = integration.settings_json.signing_secret;
    }
    const config: ProviderConfig = {
      integration,
      settings,
    };

    const instance = factory.create();
    await instance.initialize(config);
    this.instances.set(key, instance);
  }

  // ---------------------------------------------------------------------------
  // Periodic sync — hot-load new integrations without restart
  // ---------------------------------------------------------------------------

  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncFn: (() => Promise<IntegrationRow[]>) | null = null;

  /**
   * Start polling for new integrations. Calls the fetcher every `intervalMs`
   * and initializes any integrations not yet in the registry.
   */
  startSync(fetcher: () => Promise<IntegrationRow[]>, intervalMs = 30_000): void {
    this.syncFn = fetcher;
    this.syncTimer = setInterval(() => this.sync(), intervalMs);
  }

  private async sync(): Promise<void> {
    if (!this.syncFn) return;
    try {
      const integrations = await this.syncFn();
      const activeKeys = new Set<string>();

      for (const integration of integrations) {
        const key = `${integration.provider}:${integration.account_id}`;
        activeKeys.add(key);

        if (!this.instances.has(key)) {
          logger.log({ event: 'gateway.integration.hot_loaded', provider: integration.provider, accountId: integration.account_id });
          await this.initializeOne(integration);
        }
      }

      // Remove instances for integrations no longer in the active list
      for (const key of [...this.instances.keys()]) {
        if (!activeKeys.has(key)) {
          logger.log({ event: 'gateway.integration.removed', key });
          const instance = this.instances.get(key);
          if (instance) await instance.shutdown();
          this.instances.delete(key);
        }
      }
    } catch {
      // Silent — transient API failures shouldn't crash the gateway
    }
  }

  /** Graceful shutdown of all active instances. */
  async shutdownAll(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    for (const instance of this.instances.values()) {
      await instance.shutdown();
    }
    this.instances.clear();
  }
}

type IntegrationRow = { id: string; org_id: string; provider: string; account_id: string; tokens_json: Record<string, unknown> | null; settings_json?: Record<string, unknown>; status: string };
