import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { loadConfig } from '@eve/shared';
import { Public } from '../auth/auth.decorator.js';
import { WorkflowsService } from './workflows.service.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { WorkflowInvokeRequestSchema, type WorkflowInvokeRequest } from '@eve/shared';

const INTERNAL_HEADER = 'x-eve-internal-token';

function validateInternalToken(token: string | undefined): void {
  const config = loadConfig();
  if (!config.EVE_INTERNAL_API_KEY || token !== config.EVE_INTERNAL_API_KEY) {
    throw new UnauthorizedException('Invalid internal token');
  }
}

@ApiTags('internal')
@Controller('internal')
export class WorkflowsInternalController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Public()
  @Post('projects/:id/workflows/:name/invoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Invoke a workflow (internal)' })
  @ApiBody({ schema: zodSchemaToOpenApi(WorkflowInvokeRequestSchema, 'WorkflowInvokeRequest') })
  @ApiOkResponse({ description: 'Workflow invoked' })
  async invoke(
    @Param('id') projectId: string,
    @Param('name') workflowName: string,
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body(new ZodValidationPipe(WorkflowInvokeRequestSchema))
    body?: WorkflowInvokeRequest,
  ): Promise<{ job_id: string; status: string }> {
    validateInternalToken(token);
    if (body?.env_overrides) {
      throw new BadRequestException('Internal workflow invocation does not accept request-supplied env_overrides');
    }
    if (body?.scope) {
      throw new BadRequestException('Internal workflow invocation does not accept request-supplied scope');
    }
    const invokeBody = body?.input ? { input: body.input } : undefined;
    const response = await this.workflowsService.invoke(projectId, workflowName, invokeBody, false, undefined);
    return response as { job_id: string; status: string };
  }
}
