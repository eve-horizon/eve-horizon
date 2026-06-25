import { Module, forwardRef } from '@nestjs/common';
import { EnvironmentsController } from './environments.controller.js';
import { EnvironmentsService } from './environments.service.js';
import { EnvDbController } from './env-db.controller.js';
import { EnvDbService } from './env-db.service.js';
import { ManagedDbController } from './managed-db.controller.js';
import { ManagedDbService } from './managed-db.service.js';
import { ManagedDbSnapshotController } from './managed-db-snapshot.controller.js';
import { ManagedDbSnapshotService } from './managed-db-snapshot.service.js';
import { ApiRegistrationService } from './api-registration.service.js';
import { EnvLogsService } from './env-logs.service.js';
import { EnvDiagnosticsService } from './env-diagnostics.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { PipelinesModule } from '../pipelines/pipelines.module.js';
import { EventsModule } from '../events/events.module.js';
import { TracesModule } from '../traces/traces.module.js';
import { MailerModule } from '../mailer/mailer.module.js';

@Module({
  imports: [AuthModule, SecretsModule, forwardRef(() => PipelinesModule), EventsModule, TracesModule, MailerModule],
  controllers: [EnvironmentsController, EnvDbController, ManagedDbController, ManagedDbSnapshotController],
  providers: [EnvironmentsService, EnvDbService, ManagedDbService, ManagedDbSnapshotService, ApiRegistrationService, EnvLogsService, EnvDiagnosticsService],
  exports: [EnvironmentsService, ApiRegistrationService],
})
export class EnvironmentsModule {}
