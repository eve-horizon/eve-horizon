import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiResponse,
} from '@nestjs/swagger';
import { loadConfig } from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import { ProjectsService } from './projects.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { EventsService } from '../events/events.service.js';

@ApiTags('project-github')
@ApiBearerAuth()
@Controller('projects/:id/github')
export class ProjectGithubController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly secretsService: SecretsService,
    private readonly eventsService: EventsService,
  ) {}

  @RequirePermission('secrets:write')
  @Post('setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set up GitHub webhook integration',
    description:
      'Ensures GITHUB_WEBHOOK_SECRET exists, returns webhook URL and secret for configuring GitHub.',
  })
  @ApiResponse({ status: 200, description: 'Setup info returned' })
  async setup(
    @Param('id') projectId: string,
    @Body() body: { regenerate?: boolean },
  ): Promise<{
    webhook_url: string;
    secret: string;
    project_id: string;
    repo_url: string;
    events: string[];
  }> {
    const project = await this.projectsService.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    if (body.regenerate) {
      try {
        await this.secretsService.delete('project', projectId, 'GITHUB_WEBHOOK_SECRET');
      } catch {
        // Not found — fine, we'll create it
      }
    }

    await this.secretsService.ensureSafeSecrets(projectId, ['GITHUB_WEBHOOK_SECRET']);
    const exported = await this.secretsService.exportSafeSecrets(projectId, ['GITHUB_WEBHOOK_SECRET']);
    const secret = exported[0].value;

    const webhookUrl = buildWebhookUrl(projectId);

    return {
      webhook_url: webhookUrl,
      secret,
      project_id: projectId,
      repo_url: project.repo_url,
      events: ['push', 'pull_request'],
    };
  }

  @RequirePermission('secrets:read')
  @Get('status')
  @ApiOperation({
    summary: 'Check GitHub webhook integration status',
    description: 'Returns whether GITHUB_WEBHOOK_SECRET is configured and the webhook URL.',
  })
  @ApiResponse({ status: 200, description: 'Status returned' })
  async status(
    @Param('id') projectId: string,
  ): Promise<{
    configured: boolean;
    webhook_url: string;
    project_id: string;
  }> {
    const project = await this.projectsService.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const secretValue = await this.secretsService.resolveProjectSecretValue(
      projectId,
      'GITHUB_WEBHOOK_SECRET',
    );

    return {
      configured: secretValue !== null,
      webhook_url: buildWebhookUrl(projectId),
      project_id: projectId,
    };
  }

  @RequirePermission('events:write')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a test GitHub push event',
    description: 'Creates a synthetic github.push event on the project default branch.',
  })
  @ApiResponse({ status: 200, description: 'Test event created' })
  async test(
    @Param('id') projectId: string,
  ): Promise<{ ok: boolean; event_id: string }> {
    const project = await this.projectsService.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const event = await this.eventsService.create(projectId, {
      type: 'github.push',
      source: 'github',
      ref_branch: project.branch,
      ref_sha: '0000000000000000000000000000000000000000',
      actor_type: 'user',
      actor_id: 'eve-github-test',
      payload_json: { test: true, source: 'eve github test' },
      dedupe_key: null,
    });

    return { ok: true, event_id: event.id };
  }
}

function buildWebhookUrl(projectId: string): string {
  const config = loadConfig();
  const apiBase = (config.EVE_PUBLIC_API_URL ?? config.EVE_API_URL).replace(/\/+$/, '');
  return `${apiBase}/integrations/github/events/${projectId}`;
}
