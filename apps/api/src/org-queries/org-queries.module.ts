import { Module } from '@nestjs/common';
import { OrgQueriesController } from './org-queries.controller.js';
import { OrgQueriesService } from './org-queries.service.js';

@Module({
  controllers: [OrgQueriesController],
  providers: [OrgQueriesService],
  exports: [OrgQueriesService],
})
export class OrgQueriesModule {}
