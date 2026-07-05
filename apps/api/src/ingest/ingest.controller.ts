import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import type { AuthUser } from '../auth/auth.service.js';
import { IngestService } from './ingest.service.js';
import { CurrentUser } from '../common/request-decorators.js';

@ApiTags('ingest')
@ApiBearerAuth()
@Controller('projects/:project_id/ingest')
export class IngestController {
  constructor(private readonly service: IngestService) {}

  @RequirePermission('projects:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create ingest record and get upload URL' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  async create(
    @Param('project_id') projectId: string,
    @Body() body: {
      file_name: string;
      mime_type: string;
      size_bytes: number;
      title?: string;
      description?: string;
      instructions?: string;
      tags?: string[];
      source_channel?: string;
      callback_url?: string;
    },
    @CurrentUser() caller: AuthUser | undefined,
  ) {
    const actorType = caller?.is_service_principal ? 'app' : 'user';
    const actorId = caller?.user_id ?? null;
    return this.service.create(projectId, body, actorType, actorId);
  }

  @RequirePermission('projects:write')
  @Post(':ingest_id/confirm')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Confirm upload and trigger processing' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiParam({ name: 'ingest_id', description: 'Ingest record ID', type: String })
  @ApiQuery({ name: 'force', required: false, description: 'Skip content deduplication check' })
  async confirm(
    @Param('project_id') projectId: string,
    @Param('ingest_id') ingestId: string,
    @Query('force') force?: string,
  ) {
    return this.service.confirm(projectId, ingestId, {
      force: force === 'true' || force === '1',
    });
  }

  @RequirePermission('projects:read')
  @Get()
  @ApiOperation({ summary: 'List ingest records for a project' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async list(
    @Param('project_id') projectId: string,
    @Query('status') status?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.service.list(projectId, { status, limit, offset });
  }

  @RequirePermission('projects:read')
  @Get(':ingest_id')
  @ApiOperation({ summary: 'Get ingest record details' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiParam({ name: 'ingest_id', description: 'Ingest record ID', type: String })
  async show(
    @Param('project_id') projectId: string,
    @Param('ingest_id') ingestId: string,
  ) {
    return this.service.findById(projectId, ingestId);
  }

  @RequirePermission('projects:read')
  @Get(':ingest_id/download')
  @ApiOperation({ summary: 'Redirect to presigned download URL for ingested file' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiParam({ name: 'ingest_id', description: 'Ingest record ID', type: String })
  async download(
    @Param('project_id') projectId: string,
    @Param('ingest_id') ingestId: string,
    @Res() res: { status(code: number): { redirect(url: string): void } },
  ) {
    const url = await this.service.getDownloadUrl(projectId, ingestId);
    res.status(302).redirect(url);
  }
}
