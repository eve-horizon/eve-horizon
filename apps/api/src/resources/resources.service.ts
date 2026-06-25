import { Injectable, Inject } from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  orgQueries,
  orgDocumentQueries,
  jobAttachmentQueries,
  jobQueries,
  projectQueries,
} from '@eve/db';
import {
  parseResourceUri,
  type ApiListResponse,
  type ResolvedResource,
  type ResolveResourcesRequest,
} from '@eve/shared';
import { buildApiError } from '../system/api-errors.js';

@Injectable()
export class ResourcesService {
  private orgs: ReturnType<typeof orgQueries>;
  private documents: ReturnType<typeof orgDocumentQueries>;
  private attachments: ReturnType<typeof jobAttachmentQueries>;
  private jobs: ReturnType<typeof jobQueries>;
  private projects: ReturnType<typeof projectQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.orgs = orgQueries(this.db);
    this.documents = orgDocumentQueries(this.db);
    this.attachments = jobAttachmentQueries(this.db);
    this.jobs = jobQueries(this.db);
    this.projects = projectQueries(this.db);
  }

  private async resolveOrgId(orgIdOrSlug: string): Promise<string> {
    const byId = await this.orgs.findById(orgIdOrSlug);
    if (byId) return byId.id;
    const bySlug = await this.orgs.findBySlug(orgIdOrSlug);
    if (bySlug) return bySlug.id;
    throw buildApiError(404, 'resource_not_found', `Organization ${orgIdOrSlug} not found`);
  }

  async resolveResources(
    orgIdOrSlug: string,
    data: ResolveResourcesRequest,
    requestId?: string,
  ): Promise<ApiListResponse<ResolvedResource>> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const resolvedAt = new Date().toISOString();

    const results: ResolvedResource[] = [];
    for (const uri of data.uris) {
      const parsed = parseResourceUri(uri);
      if (!parsed) {
        throw buildApiError(400, 'resource_uri_invalid', `Invalid resource URI: ${uri}`, {
          requestId,
          details: { uri },
        });
      }

      if (parsed.scheme === 'org_docs') {
        const document = await this.documents.findByOrgAndPath(orgId, parsed.path);
        if (!document) {
          throw buildApiError(404, 'resource_not_found', `Resource not found: ${uri}`, {
            requestId,
            details: { uri },
          });
        }

        let content = document.content;
        let contentHash = document.content_hash;
        let version = parsed.version;

        if (parsed.version) {
          const versionRow = await this.documents.findVersion(document.id, parsed.version);
          if (!versionRow) {
            throw buildApiError(404, 'resource_not_found', `Resource not found: ${uri}`, {
              requestId,
              details: { uri },
            });
          }
          content = versionRow.content;
          contentHash = versionRow.content_hash;
          version = versionRow.version;
        } else {
          const latest = await this.documents.getLatestVersionInfo(document.id);
          version = latest?.version;
        }

        results.push({
          uri,
          ...(data.include_content ? { content } : {}),
          content_hash: `sha256:${contentHash}`,
          mime_type: document.mime_type,
          ...(version ? { version } : {}),
          resolved_at: resolvedAt,
        });
        continue;
      }

      if (parsed.scheme === 'ingest') {
        // Ingest resources are resolved by the worker via S3, not the API resource resolver
        throw buildApiError(400, 'resource_uri_invalid', `Ingest URIs cannot be resolved via the resource API: ${uri}`, {
          requestId,
          details: { uri },
        });
      }

      const job = await this.jobs.findById(parsed.jobId);
      if (!job) {
        throw buildApiError(404, 'resource_not_found', `Resource not found: ${uri}`, {
          requestId,
          details: { uri },
        });
      }

      const project = await this.projects.findById(job.project_id);
      if (!project || project.org_id !== orgId) {
        throw buildApiError(403, 'resource_access_denied', `Access denied for resource: ${uri}`, {
          requestId,
          details: { uri },
        });
      }

      const attachment = await this.attachments.findByJobIdAndName(parsed.jobId, parsed.name);
      if (!attachment) {
        throw buildApiError(404, 'resource_not_found', `Resource not found: ${uri}`, {
          requestId,
          details: { uri },
        });
      }

      results.push({
        uri,
        ...(data.include_content ? { content: attachment.content } : {}),
        content_hash: `sha256:${attachment.content_hash}`,
        mime_type: attachment.mime_type,
        resolved_at: resolvedAt,
      });
    }

    return { data: results };
  }
}
