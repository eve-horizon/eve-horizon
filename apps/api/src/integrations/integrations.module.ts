import { Module } from '@nestjs/common';
import { GitHubController } from './github.controller.js';
import { OrgIntegrationsController, IntegrationsController, MembershipRequestsController } from './org-integrations.controller.js';
import { IntegrationsInternalController } from './integrations.internal.controller.js';
import { IdentityLinkController } from './identity-link.controller.js';
import { SlackOAuthController } from './slack-oauth.controller.js';
import { OAuthAppConfigController } from './oauth-app-config.controller.js';
import { EventsModule } from '../events/events.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { IntegrationsService } from './integrations.service.js';

@Module({
  imports: [EventsModule, SecretsModule],
  controllers: [
    GitHubController,
    OrgIntegrationsController,
    IntegrationsController,
    MembershipRequestsController,
    IntegrationsInternalController,
    IdentityLinkController,
    SlackOAuthController,
    OAuthAppConfigController,
  ],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
