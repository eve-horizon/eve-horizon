import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';
import { ProjectApisController } from './project-apis.controller.js';
import { ProjectGithubController } from './project-github.controller.js';
import { ProjectsService } from './projects.service.js';
import { ManifestService } from './manifest.service.js';
import { AgentsConfigService } from './agents-config.service.js';
import { ProjectApisService } from './project-apis.service.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { EventsModule } from '../events/events.module.js';

@Module({
  imports: [SecretsModule, EventsModule],
  controllers: [ProjectsController, ProjectApisController, ProjectGithubController],
  providers: [ProjectsService, ManifestService, AgentsConfigService, ProjectApisService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
