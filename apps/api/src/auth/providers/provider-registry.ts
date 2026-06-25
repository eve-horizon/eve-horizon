import { Injectable, Logger } from '@nestjs/common';
import type { IdentityProvider, ExtractedCredential } from './identity-provider.interface.js';

/**
 * Central registry of identity providers.
 *
 * Providers register themselves at module-init time. The registry is then
 * used by AuthService and AuthGuard to resolve providers by name and to
 * attempt request-level credential extraction across all providers.
 */
@Injectable()
export class IdentityProviderRegistry {
  private readonly logger = new Logger(IdentityProviderRegistry.name);
  private readonly providers = new Map<string, IdentityProvider>();

  /** Register a provider. Duplicate names are rejected. */
  register(provider: IdentityProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Identity provider already registered: ${provider.name}`);
    }
    this.providers.set(provider.name, provider);
    this.logger.log(`Registered identity provider: ${provider.name}`);
  }

  /** Look up a provider by name, or return undefined. */
  get(name: string): IdentityProvider | undefined {
    return this.providers.get(name);
  }

  /** Return all registered providers. */
  list(): IdentityProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Try every provider's `extractFromRequest` in registration order.
   * First match wins. Errors in individual providers are caught and logged
   * so one broken provider doesn't block the rest.
   */
  extractFromRequest(req: { headers: Record<string, string | string[] | undefined> }): ExtractedCredential | null {
    for (const provider of this.providers.values()) {
      if (!provider.extractFromRequest) continue;
      try {
        const credential = provider.extractFromRequest(req);
        if (credential) return credential;
      } catch (err) {
        this.logger.warn(
          `Provider ${provider.name} threw during extractFromRequest: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return null;
  }
}
