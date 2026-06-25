import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { DeployerService, type DeploymentOptions, type DeploymentStatus } from './deployer.service';

interface DeployRequestBody {
  env_id: string;
  release_id: string;
  image_tag?: string; // Convenience field, merged into options
  options?: DeploymentOptions;
}

interface DeleteEnvironmentRequestBody {
  env_id: string;
}

@Controller()
export class DeployerController {
  constructor(private readonly deployerService: DeployerService) {}

  @Post('deploy')
  @HttpCode(200)
  async deploy(@Body() body: DeployRequestBody): Promise<DeploymentStatus> {
    if (!body?.env_id || !body?.release_id) {
      throw new BadRequestException('env_id and release_id are required');
    }

    // Merge image_tag into options for convenience
    const options: DeploymentOptions = {
      ...body.options,
      imageTag: body.image_tag ?? body.options?.imageTag,
    };

    return this.deployerService.deploy(body.env_id, body.release_id, options);
  }

  @Post('environments/delete')
  @HttpCode(200)
  async deleteEnvironment(@Body() body: DeleteEnvironmentRequestBody): Promise<{ deleted: boolean }> {
    if (!body?.env_id) {
      throw new BadRequestException('env_id is required');
    }

    await this.deployerService.deleteEnvironment(body.env_id);
    return { deleted: true };
  }
}
