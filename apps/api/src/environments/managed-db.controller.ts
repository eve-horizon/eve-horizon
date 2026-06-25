import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { ManagedDbService } from './managed-db.service.js';
import {
  RegisterManagedDbInstanceRequestSchema,
  ScaleManagedDbRequestSchema,
  type RegisterManagedDbInstanceRequest,
  type ScaleManagedDbRequest,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';

@ApiTags('managed-db')
@ApiBearerAuth()
@Controller()
export class ManagedDbController {
  constructor(private readonly managedDbService: ManagedDbService) {}

  // -----------------------------------------------------------------------
  // Project/Env scope
  // -----------------------------------------------------------------------

  @RequirePermission('envdb:read')
  @Get('projects/:id/envs/:name/db/managed')
  @ApiOperation({ summary: 'Get managed DB status for environment' })
  async getManagedDb(
    @Param('id') projectId: string,
    @Param('name') envName: string,
  ) {
    return this.managedDbService.getManagedDb(projectId, envName);
  }

  @RequirePermission('envdb:write')
  @Post('projects/:id/envs/:name/db/managed/rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate managed DB credentials' })
  async rotateCredentials(
    @Param('id') projectId: string,
    @Param('name') envName: string,
  ) {
    return this.managedDbService.rotateCredentials(projectId, envName);
  }

  @RequirePermission('envdb:write')
  @Post('projects/:id/envs/:name/db/managed/scale')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Scale managed DB class' })
  async scaleManagedDb(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Body(new ZodValidationPipe(ScaleManagedDbRequestSchema)) body: ScaleManagedDbRequest,
  ) {
    return this.managedDbService.scaleManagedDb(projectId, envName, body.class);
  }

  @RequirePermission('envdb:write')
  @Delete('projects/:id/envs/:name/db/managed')
  @ApiOperation({ summary: 'Destroy managed DB for environment' })
  async destroyManagedDb(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Query('skip_snapshot') skipSnapshot?: string,
  ) {
    return this.managedDbService.destroyManagedDb(projectId, envName, {
      skip_snapshot: skipSnapshot === 'true',
    });
  }

  // -----------------------------------------------------------------------
  // Admin scope
  // -----------------------------------------------------------------------

  @RequirePermission('system:admin')
  @Get('admin/managed-db/instances')
  @ApiOperation({ summary: 'List managed DB instances (admin)' })
  async listInstances() {
    return this.managedDbService.listInstances();
  }

  @RequirePermission('system:admin')
  @Post('admin/managed-db/instances')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register managed DB instance (admin)' })
  async registerInstance(
    @Body(new ZodValidationPipe(RegisterManagedDbInstanceRequestSchema))
    body: RegisterManagedDbInstanceRequest,
  ) {
    return this.managedDbService.registerInstance(body);
  }

  @RequirePermission('system:admin')
  @Get('admin/managed-db/instances/:instanceId')
  @ApiOperation({ summary: 'Get managed DB instance details (admin)' })
  async getInstance(@Param('instanceId') instanceId: string) {
    return this.managedDbService.getInstance(instanceId);
  }
}
