import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { pipelineRunQueries, projectManifestQueries, projectQueries } from '@eve/db';
import type { PipelineListResponse, PipelineResponse } from '@eve/shared';
import * as yaml from 'yaml';

@Injectable()
export class PipelinesService {
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private runs: ReturnType<typeof pipelineRunQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
    this.runs = pipelineRunQueries(db);
  }

  async list(projectId: string): Promise<PipelineListResponse> {
    await this.ensureProjectExists(projectId);
    const manifest = await this.manifests.findLatestByProject(projectId);
    if (!manifest) {
      return { data: [] };
    }

    const pipelines = this.parsePipelines(manifest.manifest_yaml);
    const data = Object.entries(pipelines)
      .map(([name, definition]) => ({
        project_id: projectId,
        name,
        definition,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { data };
  }

  async findByName(projectId: string, name: string): Promise<PipelineResponse> {
    await this.ensureProjectExists(projectId);
    const manifest = await this.manifests.findLatestByProject(projectId);
    if (!manifest) {
      throw new NotFoundException(`No manifest synced for project ${projectId}`);
    }

    const pipelines = this.parsePipelines(manifest.manifest_yaml);
    const definition = pipelines[name];
    if (!definition) {
      throw new NotFoundException(`Pipeline "${name}" not found for project ${projectId}`);
    }

    return {
      project_id: projectId,
      name,
      definition,
    };
  }

  async delete(projectId: string, name: string): Promise<void> {
    await this.ensureProjectExists(projectId);
    await this.runs.hardDeleteByPipelineName(projectId, name);
  }

  private parsePipelines(manifestYaml: string): Record<string, Record<string, unknown>> {
    try {
      const parsed = yaml.parse(manifestYaml) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }

      const pipelines = (parsed as Record<string, unknown>).pipelines;
      if (!pipelines || typeof pipelines !== 'object') {
        return {};
      }

      return pipelines as Record<string, Record<string, unknown>>;
    } catch (error) {
      throw new BadRequestException(
        `Invalid manifest YAML: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  }

  private async ensureProjectExists(projectId: string): Promise<void> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }
}
