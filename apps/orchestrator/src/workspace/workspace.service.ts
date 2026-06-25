import { Injectable } from '@nestjs/common';
import { loadConfig } from '@eve/shared';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Workspace service that manages job attempt workspaces.
 *
 * Creates isolated workspace directories for each job attempt:
 * `WORKSPACE_ROOT/{projectId}/{jobNumber}/{attemptNumber}/`
 */
@Injectable()
export class WorkspaceService {
  private readonly workspaceRoot: string;

  constructor() {
    const config = loadConfig();
    this.workspaceRoot = config.WORKSPACE_ROOT;
  }

  /**
   * Creates a workspace directory for a job attempt.
   *
   * @param projectId - The project ID (e.g., "proj_xxx")
   * @param jobNumber - The job number within the project
   * @param attemptNumber - The attempt number for this job
   * @returns The full path to the created workspace directory
   */
  async createWorkspace(
    projectId: string,
    jobNumber: number,
    attemptNumber: number,
  ): Promise<string> {
    const workspacePath = join(
      this.workspaceRoot,
      projectId,
      String(jobNumber),
      String(attemptNumber),
    );

    await mkdir(workspacePath, { recursive: true });

    return workspacePath;
  }
}
