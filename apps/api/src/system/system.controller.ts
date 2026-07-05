import {
  Controller,
  Get,
  Put,
  Param,
  Query,
  Body,
  DefaultValuePipe,
  ParseIntPipe,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiOkResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { HealthStatus } from '@eve/db';
import { RequirePermission } from '../auth/permission.decorator.js';
import { SystemService } from './system.service.js';
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * System Controller - Remote debugging endpoints
 *
 * Provides endpoints for monitoring and debugging the Eve Horizon deployment:
 * - GET /system/status - API/orchestrator/worker health
 * - GET /system/logs/:service - Recent logs for api/orchestrator/worker/postgres
 * - GET /system/pods - List of pods with status
 * - GET /system/events - Recent cluster events
 * - GET /system/config - Deployment config summary
 *
 * RBAC:
 * - org_admin: Can only see pods/logs/events for their org (filtered by eve.org_id label)
 * - system_admin: Full cluster visibility
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system')
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @RequirePermission('system:read')
  @Get('status')
  @ApiOperation({ summary: 'Get system health status' })
  @ApiOkResponse({ description: 'System status including API, orchestrator, worker, and postgres' })
  async getStatus(@CurrentUser() caller: AuthUser | undefined) {
    const user = this.extractUser(caller);
    return this.systemService.getStatus(user.role, user.orgId);
  }

  @RequirePermission('system:read')
  @Get('envs')
  @ApiOperation({ summary: 'List environments across projects (admin scope)' })
  @ApiQuery({ name: 'org_id', required: false, description: 'Filter by org id' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Filter by project id' })
  @ApiQuery({ name: 'limit', required: false, description: 'Limit results (default: 50)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Offset results (default: 0)' })
  @ApiOkResponse({ description: 'List of environments (admin scope)' })
  async getEnvs(
    @Query('org_id') orgId: string | undefined,
    @Query('project_id') projectId: string | undefined,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() caller: AuthUser | undefined,
  ) {
    const user = this.extractUser(caller);
    return this.systemService.listEnvs(
      { orgId, projectId, limit, offset },
      user.role,
      user.orgId,
    );
  }

  @RequirePermission('system:read')
  @Get('logs/:service')
  @ApiOperation({ summary: 'Get recent logs for a service' })
  @ApiParam({
    name: 'service',
    enum: ['api', 'orchestrator', 'worker', 'agent-runtime', 'postgres'],
    description: 'Service name',
  })
  @ApiQuery({
    name: 'tail',
    required: false,
    type: Number,
    description: 'Number of recent lines to return (default: 100)',
  })
  @ApiOkResponse({ description: 'Recent log entries' })
  async getLogs(
    @Param('service') service: 'api' | 'orchestrator' | 'worker' | 'agent-runtime' | 'postgres',
    @Query('tail', new DefaultValuePipe(100), ParseIntPipe) tail: number,
    @CurrentUser() caller: AuthUser | undefined,
  ) {
    const user = this.extractUser(caller);
    return this.systemService.getLogs(service, user.role, user.orgId, tail);
  }

  @RequirePermission('system:read')
  @Get('pods')
  @ApiOperation({ summary: 'List pods with status' })
  @ApiOkResponse({ description: 'List of pods with status, labels, and metadata' })
  async getPods(@CurrentUser() caller: AuthUser | undefined) {
    const user = this.extractUser(caller);
    return this.systemService.getPods(user.role, user.orgId);
  }

  @RequirePermission('system:read')
  @Get('events')
  @ApiOperation({ summary: 'Get recent cluster events' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max number of events to return (default: 50)',
  })
  @ApiOkResponse({ description: 'Recent cluster events' })
  async getEvents(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @CurrentUser() caller: AuthUser | undefined,
  ) {
    const user = this.extractUser(caller);
    return this.systemService.getEvents(user.role, user.orgId, limit);
  }

  @RequirePermission('system:read')
  @Get('config')
  @ApiOperation({ summary: 'Get deployment configuration summary' })
  @ApiOkResponse({ description: 'Cluster and deployment configuration' })
  async getConfig(@CurrentUser() caller: AuthUser | undefined) {
    const user = this.extractUser(caller);
    return this.systemService.getConfig(user.role, user.orgId);
  }

  @RequirePermission('system:admin')
  @Get('users')
  @ApiOperation({ summary: 'List all users with org memberships (system_admin only)' })
  @ApiOkResponse({ description: 'List of all users with their org roles' })
  async getUsers(@CurrentUser() caller: AuthUser | undefined) {
    this.extractSystemAdmin(caller);
    return this.systemService.listUsers();
  }

  @RequirePermission('system:admin')
  @Get('settings')
  @ApiOperation({ summary: 'Get all system settings (system_admin only)' })
  @ApiOkResponse({ description: 'List of all system settings' })
  async getSettings(@CurrentUser() caller: AuthUser | undefined) {
    const user = this.extractSystemAdmin(caller);
    return this.systemService.getSettings();
  }

  @RequirePermission('system:admin')
  @Get('settings/:key')
  @ApiOperation({ summary: 'Get a specific system setting (system_admin only)' })
  @ApiOkResponse({ description: 'System setting value' })
  async getSetting(@Param('key') key: string, @CurrentUser() caller: AuthUser | undefined) {
    const user = this.extractSystemAdmin(caller);
    return this.systemService.getSetting(key);
  }

  @RequirePermission('system:admin')
  @Put('settings/:key')
  @ApiOperation({ summary: 'Set a system setting (system_admin only)' })
  @ApiOkResponse({ description: 'Updated system setting' })
  async setSetting(
    @Param('key') key: string,
    @Body() body: { value: string; description?: string },
    @CurrentUser() caller: AuthUser | undefined,
  ) {
    const user = this.extractSystemAdmin(caller);
    return this.systemService.setSetting(key, body.value, user.userId ?? 'admin', body.description);
  }

  @RequirePermission('system:read')
  @Get('env-health')
  @ApiOperation({ summary: 'Get environment health status across all orgs' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by health status (healthy, degraded, critical)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Limit results (default: 100)' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Offset results (default: 0)' })
  @ApiOkResponse({ description: 'Environment health summary and details' })
  async getEnvHealth(
    @Query('status') status?: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.systemService.getEnvHealth({
      status: status as HealthStatus | undefined,
      limit,
      offset,
    });
  }

  /**
   * Extract user info from request and enforce admin scope
   */
  private extractUser(user: AuthUser | undefined): { role?: string; orgId?: string; userId?: string } {
    // If no user (auth disabled), allow all operations as system_admin
    if (!user) {
      return { role: 'system_admin', orgId: undefined, userId: 'admin' };
    }

    // Extract role and org_id from user
    let role = user.role ?? (user.is_admin ? 'system_admin' : undefined);
    if (role === 'admin') {
      role = 'org_admin';
    }
    const orgId = user.org_id;
    const userId = (user as { id?: string }).id;

    // Require admin scope (org_admin or system_admin)
    if (role !== 'org_admin' && role !== 'system_admin') {
      throw new ForbiddenException('Admin scope required (org_admin or system_admin)');
    }

    return { role, orgId, userId };
  }

  /**
   * Extract user info and enforce system_admin scope only
   */
  private extractSystemAdmin(user: AuthUser | undefined): { role?: string; userId?: string } {
    // If no user (auth disabled), allow all operations as system_admin
    if (!user) {
      return { role: 'system_admin', userId: 'admin' };
    }

    // Extract role and id from user
    const role = user.role;
    const userId = (user as { id?: string }).id;

    // Require system_admin scope
    if (role !== 'system_admin') {
      throw new ForbiddenException('System admin scope required');
    }

    return { role, userId };
  }
}
