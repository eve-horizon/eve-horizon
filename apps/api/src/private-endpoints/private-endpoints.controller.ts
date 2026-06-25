import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { PrivateEndpointsService } from './private-endpoints.service.js';
import {
  CreatePrivateEndpointRequestSchema,
  PrivateEndpointResponseSchema,
  PrivateEndpointListResponseSchema,
  PrivateEndpointHealthSchema,
  PrivateEndpointDiagnoseSchema,
  type CreatePrivateEndpointRequest,
  type PrivateEndpointResponse,
  type PrivateEndpointListResponse,
  type PrivateEndpointHealth,
  type PrivateEndpointDiagnose,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { RequirePermission } from '../auth/permission.decorator.js';

@ApiTags('private-endpoints')
@ApiBearerAuth()
@Controller('orgs/:org_id/endpoints')
export class PrivateEndpointsController {
  constructor(private readonly service: PrivateEndpointsService) {}

  @RequirePermission('endpoints:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a private endpoint' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreatePrivateEndpointRequestSchema, 'CreatePrivateEndpointRequest') })
  @ApiCreatedResponse({
    description: 'Private endpoint created',
    schema: zodSchemaToOpenApi(PrivateEndpointResponseSchema, 'PrivateEndpointResponse'),
  })
  async create(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreatePrivateEndpointRequestSchema)) body: CreatePrivateEndpointRequest,
  ): Promise<PrivateEndpointResponse> {
    return this.service.create(orgId, body);
  }

  @RequirePermission('endpoints:read')
  @Get()
  @ApiOperation({ summary: 'List private endpoints for an org' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiOkResponse({
    description: 'List of private endpoints',
    schema: zodSchemaToOpenApi(PrivateEndpointListResponseSchema, 'PrivateEndpointListResponse'),
  })
  async list(
    @Param('org_id') orgId: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<PrivateEndpointListResponse> {
    return this.service.list(orgId, limit, offset);
  }

  @RequirePermission('endpoints:read')
  @Get(':name')
  @ApiOperation({ summary: 'Show a private endpoint' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug' })
  @ApiParam({ name: 'name', description: 'Endpoint name' })
  @ApiOkResponse({
    description: 'Private endpoint details',
    schema: zodSchemaToOpenApi(PrivateEndpointResponseSchema, 'PrivateEndpointResponse'),
  })
  async show(
    @Param('org_id') orgId: string,
    @Param('name') name: string,
  ): Promise<PrivateEndpointResponse> {
    return this.service.show(orgId, name);
  }

  @RequirePermission('endpoints:write')
  @Delete(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a private endpoint' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug' })
  @ApiParam({ name: 'name', description: 'Endpoint name' })
  @ApiNoContentResponse({ description: 'Endpoint removed' })
  async remove(
    @Param('org_id') orgId: string,
    @Param('name') name: string,
  ): Promise<void> {
    return this.service.remove(orgId, name);
  }

  @RequirePermission('endpoints:read')
  @Get(':name/health')
  @ApiOperation({ summary: 'Health check a private endpoint' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug' })
  @ApiParam({ name: 'name', description: 'Endpoint name' })
  @ApiOkResponse({
    description: 'Endpoint health status',
    schema: zodSchemaToOpenApi(PrivateEndpointHealthSchema, 'PrivateEndpointHealth'),
  })
  async health(
    @Param('org_id') orgId: string,
    @Param('name') name: string,
  ): Promise<PrivateEndpointHealth> {
    return this.service.healthCheck(orgId, name);
  }

  @RequirePermission('endpoints:read')
  @Get(':name/diagnose')
  @ApiOperation({ summary: 'Diagnose a private endpoint' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug' })
  @ApiParam({ name: 'name', description: 'Endpoint name' })
  @ApiOkResponse({
    description: 'Diagnostic checks for the endpoint',
    schema: zodSchemaToOpenApi(PrivateEndpointDiagnoseSchema, 'PrivateEndpointDiagnose'),
  })
  async diagnose(
    @Param('org_id') orgId: string,
    @Param('name') name: string,
  ): Promise<PrivateEndpointDiagnose> {
    return this.service.diagnose(orgId, name);
  }
}
