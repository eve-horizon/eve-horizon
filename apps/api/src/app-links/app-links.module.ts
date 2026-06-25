import { Module } from '@nestjs/common';
import { AppLinksController } from './app-links.controller.js';
import { AppLinksService } from './app-links.service.js';

@Module({
  controllers: [AppLinksController],
  providers: [AppLinksService],
  exports: [AppLinksService],
})
export class AppLinksModule {}
