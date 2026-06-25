import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { TraceQueryResponseSchema, type TraceQueryResponse } from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { RequirePermission } from '../auth/permission.decorator.js';
import { TracesService } from './traces.service.js';

@ApiTags('traces')
@ApiBearerAuth()
@Controller('projects/:id/traces')
export class TracesController {
  constructor(private readonly tracesService: TracesService) {}

  @RequirePermission('envs:read')
  @Get('query')
  @ApiOperation({ summary: 'Query project traces' })
  @ApiQuery({ name: 'service', required: false })
  @ApiQuery({ name: 'request_id', required: false })
  @ApiQuery({ name: 'trace_id', required: false })
  @ApiQuery({ name: 'since', required: false, description: 'Duration such as 5m, 1h, or seconds' })
  @ApiQuery({ name: 'error', required: false })
  @ApiQuery({ name: 'route', required: false })
  @ApiQuery({ name: 'p99', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'no_cache', required: false })
  @ApiOkResponse({
    description: 'Trace query result',
    schema: zodSchemaToOpenApi(TraceQueryResponseSchema, 'TraceQueryResponse'),
  })
  async query(
    @Param('id') projectId: string,
    @Query('service') service?: string,
    @Query('request_id') requestId?: string,
    @Query('trace_id') traceId?: string,
    @Query('since') since?: string,
    @Query('error') error?: string,
    @Query('route') route?: string,
    @Query('p99') p99?: string,
    @Query('limit') limit?: string,
    @Query('no_cache') noCache?: string,
  ): Promise<TraceQueryResponse> {
    if (!requestId && !traceId && !since && !error && !route) {
      throw new BadRequestException('Provide --request-id, --trace-id, --since, --error, or --route');
    }
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.tracesService.query({
      projectId,
      service,
      requestId,
      traceId,
      sinceSeconds: since ? parseDurationSeconds(since) : undefined,
      error: error === 'true' || error === '1',
      route,
      p99: p99 === 'true' || p99 === '1',
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      noCache: noCache === 'true' || noCache === '1',
    });
  }
}

export function parseDurationSeconds(value: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)([smhd])?$/i);
  if (!match) {
    throw new BadRequestException('since must be a duration like 300, 5m, 1h, or 1d');
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier = unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1;
  return amount * multiplier;
}
