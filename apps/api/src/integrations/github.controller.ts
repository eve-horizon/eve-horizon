import {
  Controller,
  Post,
  Body,
  Headers,
  Param,
  BadRequestException,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiParam,
  ApiHeader,
  ApiResponse,
} from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'crypto';
import { EventsService } from '../events/events.service.js';
import { Public } from '../auth/auth.decorator.js';
import { loadConfig } from '@eve/shared';
import { SecretsService } from '../secrets/secrets.service.js';

// GitHub webhook payload types
interface GitHubPushPayload {
  ref: string; // e.g., "refs/heads/main"
  after: string; // commit SHA
  sender: {
    login: string;
  };
  [key: string]: unknown;
}

interface GitHubPullRequestPayload {
  action: string;
  pull_request: {
    head: {
      sha: string;
      ref: string; // branch name without refs/heads/ prefix
    };
  };
  sender: {
    login: string;
  };
  [key: string]: unknown;
}

type GitHubWebhookPayload = GitHubPushPayload | GitHubPullRequestPayload;

@ApiTags('integrations')
@Controller('integrations/github')
export class GitHubController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly secretsService: SecretsService,
  ) {}

  @Post('events/:projectId')
  @Public() // Webhooks don't use bearer auth
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'GitHub webhook endpoint',
    description: 'Receives GitHub webhook events and normalizes them into Eve events',
  })
  @ApiParam({
    name: 'projectId',
    description: 'The Eve project ID to associate with the event',
  })
  @ApiHeader({
    name: 'X-GitHub-Event',
    description: 'GitHub event type (e.g., "push", "pull_request")',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Event processed successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or unsupported event',
  })
  async handleWebhook(
    @Param('projectId') projectId: string,
    @Headers('x-github-event') githubEvent: string,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Body() payload: GitHubWebhookPayload,
    @Req() request: { rawBody?: string },
  ): Promise<{ ok: boolean; event_id?: string }> {
    const config = loadConfig();
    const projectSecret = await this.secretsService.resolveProjectSecretValue(
      projectId,
      'GITHUB_WEBHOOK_SECRET',
    );
    const secret = projectSecret ?? config.EVE_GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      throw new UnauthorizedException('GitHub webhook secret not configured');
    }

    const rawBody = request.rawBody ?? '';
    if (!signature || !rawBody) {
      throw new UnauthorizedException('Missing GitHub webhook signature');
    }

    if (!verifyGitHubSignature(secret, rawBody, signature)) {
      throw new UnauthorizedException('Invalid GitHub webhook signature');
    }

    if (!githubEvent) {
      throw new BadRequestException('Missing X-GitHub-Event header');
    }

    // Normalize GitHub event to Eve event format
    let eveEventType: string;
    let refSha: string;
    let refBranch: string;
    let actorId: string;

    switch (githubEvent.toLowerCase()) {
      case 'push': {
        const pushPayload = payload as GitHubPushPayload;
        eveEventType = 'github.push';
        refSha = pushPayload.after;
        // Extract branch name from refs/heads/branch-name
        refBranch = pushPayload.ref.replace(/^refs\/heads\//, '');
        actorId = pushPayload.sender.login;
        break;
      }

      case 'pull_request': {
        const prPayload = payload as GitHubPullRequestPayload;
        eveEventType = 'github.pull_request';
        refSha = prPayload.pull_request.head.sha;
        // GitHub PR payloads already have the branch name without refs/heads/
        refBranch = prPayload.pull_request.head.ref;
        actorId = prPayload.sender.login;
        break;
      }

      default:
        throw new BadRequestException(
          `Unsupported GitHub event type: ${githubEvent}`,
        );
    }

    // Create Eve event
    const event = await this.eventsService.create(projectId, {
      type: eveEventType,
      source: 'github',
      ref_sha: refSha,
      ref_branch: refBranch,
      payload_json: payload as Record<string, unknown>,
      actor_type: 'user',
      actor_id: actorId,
      dedupe_key: deliveryId ? `github:${deliveryId}` : null,
    });

    return {
      ok: true,
      event_id: event.id,
    };
  }
}

function verifyGitHubSignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}
