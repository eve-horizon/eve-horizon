import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { buildQueries, projectManifestQueries, projectQueries } from '@eve/db';
import {
  generateBuildId,
  generateBuildRunId,
  type BuildArtifactListResponse,
  type BuildArtifactResponse,
  type BuildLogsResponse,
  type BuildRunListResponse,
  type BuildRunResponse,
  type BuildSpecListResponse,
  type BuildSpecResponse,
  type CancelBuildRunRequest,
  type CreateBuildRunRequest,
  type CreateBuildSpecRequest,
} from '@eve/shared';

@Injectable()
export class BuildsService {
  private builds: ReturnType<typeof buildQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.builds = buildQueries(db);
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
  }

  async createSpec(
    projectId: string,
    request: CreateBuildSpecRequest,
    createdBy?: string,
  ): Promise<BuildSpecResponse> {
    await this.ensureProjectExists(projectId);

    const manifest = await this.manifests.findByProjectAndHash(projectId, request.manifest_hash);
    if (!manifest) {
      throw new BadRequestException('manifest_hash not found for project');
    }
    if (manifest.git_sha && manifest.git_sha !== request.git_sha) {
      throw new BadRequestException('manifest_hash does not match git_sha');
    }

    const spec = await this.builds.createSpec({
      id: generateBuildId(),
      project_id: projectId,
      git_sha: request.git_sha,
      manifest_hash: request.manifest_hash,
      services_json: request.services ?? null,
      inputs_json: request.inputs ?? null,
      registry_json: request.registry ?? null,
      cache_json: request.cache ?? null,
      created_by: createdBy ?? null,
    });

    return this.toSpecResponse(spec);
  }

  async listSpecs(
    projectId: string,
    options: { limit?: number; offset?: number },
  ): Promise<BuildSpecListResponse> {
    await this.ensureProjectExists(projectId);
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const specs = await this.builds.listSpecs({ project_id: projectId, limit, offset });

    return {
      data: specs.map((spec) => this.toSpecResponse(spec)),
      pagination: {
        limit,
        offset,
        count: specs.length,
      },
    };
  }

  async getSpec(buildId: string): Promise<BuildSpecResponse> {
    const spec = await this.builds.findSpecById(buildId);
    if (!spec) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }
    return this.toSpecResponse(spec);
  }

  async createRun(buildId: string, request: CreateBuildRunRequest): Promise<BuildRunResponse> {
    const spec = await this.builds.findSpecById(buildId);
    if (!spec) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }

    const run = await this.builds.createRun({
      id: generateBuildRunId(),
      build_id: buildId,
      status: 'queued',
      backend: request.backend ?? 'buildkit',
      runner_ref: request.runner_ref ?? null,
      logs_ref: null,
      error_message: null,
      error_code: null,
      started_at: null,
      completed_at: null,
    });

    return this.toRunResponse(run);
  }

  async listRuns(
    buildId: string,
    options: { limit?: number; offset?: number },
  ): Promise<BuildRunListResponse> {
    const spec = await this.builds.findSpecById(buildId);
    if (!spec) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }

    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const runs = await this.builds.listRuns({ build_id: buildId, limit, offset });

    return {
      data: runs.map((run) => this.toRunResponse(run)),
      pagination: {
        limit,
        offset,
        count: runs.length,
      },
    };
  }

  async listArtifacts(
    buildId: string,
    options: { limit?: number; offset?: number },
  ): Promise<BuildArtifactListResponse> {
    const spec = await this.builds.findSpecById(buildId);
    if (!spec) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }

    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const artifacts = await this.builds.listArtifacts({ build_id: buildId, limit, offset });

    return {
      data: artifacts.map((artifact) => this.toArtifactResponse(artifact)),
      pagination: {
        limit,
        offset,
        count: artifacts.length,
      },
    };
  }

  async getLogs(
    buildId: string,
    options: { run_id?: string; after?: number },
  ): Promise<BuildLogsResponse> {
    const spec = await this.builds.findSpecById(buildId);
    if (!spec) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }

    const run = options.run_id
      ? await this.builds.findRunById(options.run_id)
      : await this.builds.findLatestRunByBuildId(buildId);

    if (options.run_id && (!run || run.build_id !== buildId)) {
      throw new NotFoundException(`Build run ${options.run_id} not found for build ${buildId}`);
    }

    if (!run || run.build_id !== buildId) {
      return { logs: [] };
    }

    const entries = await this.builds.listLogs(run.id, options.after);
    if (entries.length === 0) {
      const timestamp = run.completed_at?.toISOString?.() ?? run.started_at?.toISOString?.() ?? new Date().toISOString();
      return {
        logs: [
          {
            sequence: 0,
            timestamp,
            line: {
              message: 'No build logs recorded for this run.',
              build_run_id: run.id,
              build_id: buildId,
              status: run.status,
              backend: run.backend,
              error_message: run.error_message ?? null,
              timestamp,
            },
          },
        ],
      };
    }

    const logs = entries.map((entry) => {
      const content = entry.content as Record<string, unknown>;
      return {
        sequence: entry.seq,
        timestamp: (content.timestamp as string) || entry.created_at.toISOString(),
        line: content,
      };
    });

    return { logs };
  }

  async cancelRun(buildId: string, request: CancelBuildRunRequest): Promise<BuildRunResponse> {
    const spec = await this.builds.findSpecById(buildId);
    if (!spec) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }

    const run = request.run_id
      ? await this.builds.findRunById(request.run_id)
      : await this.builds.findLatestRunByBuildId(buildId);

    if (!run || run.build_id !== buildId) {
      throw new NotFoundException(`Build run not found for build ${buildId}`);
    }

    const updated = await this.builds.updateRun(run.id, {
      status: 'cancelled',
      error_message: request.reason ?? run.error_message,
      completed_at: new Date(),
    });

    if (!updated) {
      throw new NotFoundException(`Build run ${run.id} not found`);
    }

    return this.toRunResponse(updated);
  }

  async delete(buildId: string): Promise<void> {
    const spec = await this.builds.findSpecById(buildId);
    if (!spec) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }
    await this.builds.hardDelete(buildId);
  }

  async prune(projectId: string, keep: number): Promise<{ deleted: number }> {
    await this.ensureProjectExists(projectId);
    const specs = await this.builds.listSpecs({ project_id: projectId, limit: 10000, offset: 0 });
    if (specs.length <= keep) {
      return { deleted: 0 };
    }
    const toDelete = specs.slice(keep);
    let deleted = 0;
    for (const spec of toDelete) {
      const ok = await this.builds.hardDelete(spec.id);
      if (ok) deleted++;
    }
    return { deleted };
  }

  private async ensureProjectExists(projectId: string): Promise<void> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }

  private toSpecResponse(spec: Awaited<ReturnType<typeof this.builds.findSpecById>> & object): BuildSpecResponse {
    return {
      id: spec.id,
      project_id: spec.project_id,
      git_sha: spec.git_sha,
      manifest_hash: spec.manifest_hash,
      services: spec.services_json,
      inputs: spec.inputs_json,
      registry: spec.registry_json,
      cache: spec.cache_json,
      created_by: spec.created_by,
      created_at: spec.created_at.toISOString(),
    };
  }

  private toRunResponse(run: Awaited<ReturnType<typeof this.builds.findRunById>> & object): BuildRunResponse {
    return {
      id: run.id,
      build_id: run.build_id,
      status: run.status,
      backend: run.backend,
      runner_ref: run.runner_ref,
      logs_ref: run.logs_ref,
      error_message: run.error_message,
      started_at: run.started_at?.toISOString() ?? null,
      completed_at: run.completed_at?.toISOString() ?? null,
      created_at: run.created_at.toISOString(),
      updated_at: run.updated_at.toISOString(),
    };
  }

  private toArtifactResponse(
    artifact: Awaited<ReturnType<typeof this.builds.createArtifact>>
  ): BuildArtifactResponse {
    return {
      id: artifact.id,
      build_id: artifact.build_id,
      service_name: artifact.service_name,
      image_ref: artifact.image_ref,
      digest: artifact.digest,
      platforms: artifact.platforms_json,
      size_bytes: artifact.size_bytes,
      sbom_ref: artifact.sbom_ref,
      provenance_ref: artifact.provenance_ref,
      created_at: artifact.created_at.toISOString(),
    };
  }
}
