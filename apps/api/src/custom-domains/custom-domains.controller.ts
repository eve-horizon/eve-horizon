import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../auth/permission.decorator.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { CustomDomainsService } from './custom-domains.service.js';

const RegisterDomainSchema = z.object({
  hostname: z.string().min(4).max(253),
  service_name: z.string().min(1),
  environment: z.string().min(1).optional(),
});

type RegisterDomainRequest = z.infer<typeof RegisterDomainSchema>;

const TransferDomainSchema = z.object({
  to_environment: z.string().min(1),
});

type TransferDomainRequest = z.infer<typeof TransferDomainSchema>;

@ApiTags('custom-domains')
@ApiBearerAuth()
@Controller('projects/:project_id/domains')
export class CustomDomainsController {
  constructor(private readonly customDomains: CustomDomainsService) {}

  @RequirePermission('projects:read')
  @Get()
  @ApiOperation({ summary: 'List custom domains for a project' })
  async list(@Param('project_id') projectId: string) {
    return this.customDomains.listByProject(projectId);
  }

  @RequirePermission('projects:read')
  @Get(':hostname')
  @ApiOperation({ summary: 'Get custom domain detail' })
  async get(
    @Param('project_id') projectId: string,
    @Param('hostname') hostname: string,
  ) {
    return this.customDomains.getByHostname(projectId, hostname);
  }

  @RequirePermission('projects:write')
  @Post()
  @ApiOperation({ summary: 'Register a custom domain' })
  async register(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(RegisterDomainSchema)) body: RegisterDomainRequest,
  ) {
    return this.customDomains.register(projectId, body);
  }

  @RequirePermission('projects:write')
  @Post(':hostname/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify DNS and get activation status' })
  async verify(
    @Param('project_id') projectId: string,
    @Param('hostname') hostname: string,
  ) {
    return this.customDomains.verify(projectId, hostname);
  }

  @RequirePermission('projects:write')
  @Post(':hostname/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer domain ownership to another environment' })
  async transfer(
    @Param('project_id') projectId: string,
    @Param('hostname') hostname: string,
    @Body(new ZodValidationPipe(TransferDomainSchema)) body: TransferDomainRequest,
  ) {
    return this.customDomains.transfer(projectId, hostname, body);
  }

  @RequirePermission('projects:write')
  @Post(':hostname/unbind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear env binding so the next deploy can claim the domain' })
  async unbind(
    @Param('project_id') projectId: string,
    @Param('hostname') hostname: string,
  ) {
    return this.customDomains.unbind(projectId, hostname);
  }

  @RequirePermission('projects:write')
  @Delete(':hostname')
  @ApiOperation({ summary: 'Remove a custom domain' })
  async remove(
    @Param('project_id') projectId: string,
    @Param('hostname') hostname: string,
  ) {
    return this.customDomains.remove(projectId, hostname);
  }
}
