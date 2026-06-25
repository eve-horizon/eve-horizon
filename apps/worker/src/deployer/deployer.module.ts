import { Module } from '@nestjs/common';
import { DeployerService } from './deployer.service';
import { K8sService } from './k8s.service';
import { DeployerController } from './deployer.controller';

@Module({
  controllers: [DeployerController],
  providers: [DeployerService, K8sService],
  exports: [DeployerService, K8sService],
})
export class DeployerModule {}
