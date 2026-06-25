import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';

/**
 * Workspace module for Phase 3.
 *
 * Provides workspace directory creation and management for job attempts.
 */
@Module({
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
