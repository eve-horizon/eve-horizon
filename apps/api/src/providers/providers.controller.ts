import { Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorator.js';
import { ProviderDiscoveryService } from './provider-discovery.service.js';
import {
  listProviders,
  getProvider,
  toProviderJson,
  type ProviderDefinitionJson,
  type DiscoveryResult,
} from '@eve/shared';

@ApiTags('providers')
@Controller('providers')
export class ProvidersController {
  constructor(private readonly discoveryService: ProviderDiscoveryService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'List all registered providers' })
  async list(): Promise<{ providers: ProviderDefinitionJson[] }> {
    return {
      providers: listProviders().map(toProviderJson),
    };
  }

  @Get(':name')
  @Public()
  @ApiOperation({ summary: 'Get provider details' })
  async get(@Param('name') name: string): Promise<ProviderDefinitionJson> {
    const provider = getProvider(name);
    if (!provider) throw new NotFoundException(`Provider "${name}" not found`);
    return toProviderJson(provider);
  }

  @Get(':name/models')
  @Public()
  @ApiOperation({ summary: 'Discover available models from a provider' })
  @ApiQuery({ name: 'org_id', required: false, description: 'Organization ID for credential resolution' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Project ID for credential resolution' })
  async discoverModels(
    @Param('name') name: string,
    @Query('org_id') orgId?: string,
    @Query('project_id') projectId?: string,
  ): Promise<DiscoveryResult> {
    const provider = getProvider(name);
    if (!provider) throw new NotFoundException(`Provider "${name}" not found`);
    if (!provider.discovery) {
      return {
        provider: provider.name,
        models: [],
        fetched_at: new Date().toISOString(),
        ttl_seconds: 0,
        source: 'static_fallback',
      };
    }
    return this.discoveryService.discoverModels(provider, { orgId, projectId });
  }
}
