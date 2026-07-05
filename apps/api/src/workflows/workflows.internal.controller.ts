import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { WorkflowsService } from './workflows.service.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { WorkflowInvokeRequestSchema, type WorkflowInvokeRequest } from '@eve/shared';

@ApiTags('internal')
@Controller('internal')
@UseGuards(InternalTokenGuard)
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
    @Body(new ZodValidationPipe(WorkflowInvokeRequestSchema))
    body?: WorkflowInvokeRequest,
  ): Promise<{ job_id: string; status: string }> {
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
