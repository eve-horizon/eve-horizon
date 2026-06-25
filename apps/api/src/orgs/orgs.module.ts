import { Module } from '@nestjs/common';
import { OrgsController } from './orgs.controller.js';
import { OrgsInternalController } from './orgs.internal.controller.js';
import { OrgsService } from './orgs.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { MailerModule } from '../mailer/mailer.module.js';

@Module({
  imports: [AuthModule, MailerModule],
  controllers: [OrgsController, OrgsInternalController],
  providers: [OrgsService],
})
export class OrgsModule {}
