import { Module } from '@nestjs/common';
import { CloudFsController } from './cloud-fs.controller.js';
import { GoogleDriveOAuthController } from './google-drive-oauth.controller.js';
import { CloudFsService } from './cloud-fs.service.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [IntegrationsModule, AuthModule],
  controllers: [CloudFsController, GoogleDriveOAuthController],
  providers: [CloudFsService],
  exports: [CloudFsService],
})
export class CloudFsModule {}
