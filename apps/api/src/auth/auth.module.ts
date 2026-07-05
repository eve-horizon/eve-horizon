import { Module, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Db } from '@eve/db';
import { replayStoreQueries } from '@eve/db';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthInternalController } from './auth.internal.controller.js';
import { AuthInvitesController } from './auth.invites.controller.js';
import { AuthAccessRequestsController } from './auth.access-requests.controller.js';
import { ServicePrincipalsController } from './auth.service-principals.controller.js';
import { AccessController } from './auth.access.controller.js';
import { AccessRolesController } from './auth.access-roles.controller.js';
import { AccessGroupsController } from './auth.access-groups.controller.js';
import { AuthService } from './auth.service.js';
import { MagicLinkService } from './magic-link.service.js';
import { AppAuthService } from './app-auth.service.js';
import { TokenVerifierService } from './token-verifier.service.js';
import { BootstrapService } from './bootstrap.service.js';
import { AuthKeysController } from './auth.keys.controller.js';
import { RbacService } from './rbac.service.js';
import { AccessService } from './access.service.js';
import { ScopedAccessService } from './scoped-access.service.js';
import { PermissionGuard } from './permission.guard.js';
import { AppAuthPolicyService } from './app-auth-policy.service.js';
import { IdentityProviderRegistry, SshIdentityProvider, NostrIdentityProvider } from './providers/index.js';
import { MailerModule } from '../mailer/mailer.module.js';
import { EventsModule } from '../events/events.module.js';

const REPLAY_PURGE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Magic-link confirmation wraps are short-lived (1h TTL by default). We
// retain consumed/expired rows for 24h so support can still see scanner
// telemetry (get_count > 1) after the fact without pinning bearer URLs
// indefinitely.
const MAGIC_LINK_WRAP_PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAGIC_LINK_WRAP_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

@Module({
  imports: [MailerModule, EventsModule],
  controllers: [AuthController, AuthInternalController, AuthKeysController, AuthInvitesController, AuthAccessRequestsController, ServicePrincipalsController, AccessController, AccessRolesController, AccessGroupsController],
  providers: [
    AuthService,
    MagicLinkService,
    AppAuthService,
    TokenVerifierService,
    BootstrapService,
    RbacService,
    AccessService,
    ScopedAccessService,
    AppAuthPolicyService,
    IdentityProviderRegistry,
    SshIdentityProvider,
    NostrIdentityProvider,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
  ],
  exports: [AuthService, RbacService, AccessService, ScopedAccessService, AppAuthPolicyService, IdentityProviderRegistry],
})
export class AuthModule implements OnModuleInit, OnModuleDestroy {
  private replayPurgeTimer?: ReturnType<typeof setInterval>;
  private magicLinkWrapPurgeTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly registry: IdentityProviderRegistry,
    private readonly sshProvider: SshIdentityProvider,
    private readonly nostrProvider: NostrIdentityProvider,
    private readonly authService: AuthService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.sshProvider);
    this.registry.register(this.nostrProvider);

    // Periodic cleanup of expired replay-protection entries
    this.replayPurgeTimer = setInterval(() => {
      replayStoreQueries(this.db).purgeExpired().catch(() => {});
    }, REPLAY_PURGE_INTERVAL_MS);

    this.magicLinkWrapPurgeTimer = setInterval(() => {
      const cutoff = new Date(Date.now() - MAGIC_LINK_WRAP_RETENTION_MS);
      this.authService.pruneExpiredMagicLinkWraps(cutoff).catch(() => {});
    }, MAGIC_LINK_WRAP_PURGE_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.replayPurgeTimer) {
      clearInterval(this.replayPurgeTimer);
    }
    if (this.magicLinkWrapPurgeTimer) {
      clearInterval(this.magicLinkWrapPurgeTimer);
    }
  }
}
