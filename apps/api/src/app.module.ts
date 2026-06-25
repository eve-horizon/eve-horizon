import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { OrgsModule } from './orgs/orgs.module';
import { ProjectsModule } from './projects/projects.module';
import { JobsModule } from './jobs/jobs.module';
import { AttemptsModule } from './attempts/attempts.module';
import { HarnessesModule } from './harnesses/harnesses.module';
import { SecretsModule } from './secrets/secrets.module';
import { SystemModule } from './system/system.module';
import { EnvironmentsModule } from './environments/environments.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { EventsModule } from './events/events.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { BuildsModule } from './builds/builds.module';
import { ThreadsModule } from './threads/threads.module';
import { ChatModule } from './chat/chat.module';
import { ConversationsModule } from './conversations/conversations.module';
import { AgentRuntimeModule } from './agent-runtime/agent-runtime.module';
import { PricingModule } from './pricing/pricing.module';
import { BillingModule } from './billing/billing.module';

import { RegistryModule } from './registry/registry.module';
import { JobAttachmentsModule } from './job-attachments/job-attachments.module';
import { OrgQueriesModule } from './org-queries/org-queries.module';
import { OrgDocumentsModule } from './org-documents/org-documents.module';
import { OrgFsSyncModule } from './org-fs-sync/org-fs-sync.module';
import { ResourcesModule } from './resources/resources.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ProvidersModule } from './providers/providers.module';

import { AgentMemoryModule } from './agent-memory/agent-memory.module';
import { IngressAliasesModule } from './ingress-aliases/ingress-aliases.module';
import { CustomDomainsModule } from './custom-domains/custom-domains.module';
import { StorageModule } from './storage/storage.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { UsersModule } from './users/users.module.js';
import { PrivateEndpointsModule } from './private-endpoints/private-endpoints.module.js';
import { CloudFsModule } from './cloud-fs/cloud-fs.module.js';
import { PlatformNotifyModule } from './platform-notify/platform-notify.module.js';
import { TracesModule } from './traces/traces.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { AppLinksModule } from './app-links/app-links.module.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    HealthModule,
    OrgsModule,
    ProjectsModule,
    JobsModule,
    AttemptsModule, // Re-added for internal API endpoints
    HarnessesModule,
    SecretsModule,
    SystemModule,
    EnvironmentsModule,
    PipelinesModule,
    WorkflowsModule,
    EventsModule,
    IntegrationsModule,
    BuildsModule,
    ThreadsModule,
    ChatModule,
    ConversationsModule,
    AgentRuntimeModule,
    PricingModule,
    BillingModule,

    RegistryModule,
    JobAttachmentsModule,
    OrgQueriesModule,
    OrgDocumentsModule,
    OrgFsSyncModule,
    ResourcesModule,
    WebhooksModule,
    AnalyticsModule,
    ProvidersModule,

    AgentMemoryModule,
    IngressAliasesModule,
    CustomDomainsModule,
    StorageModule,
    IngestModule,
    UsersModule,
    PrivateEndpointsModule,
    CloudFsModule,
    PlatformNotifyModule,
    TracesModule,
    NotificationsModule,
    AppLinksModule,
  ],
})
export class AppModule {}
