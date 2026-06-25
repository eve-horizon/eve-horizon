import { Injectable, Inject, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { ingestRecordQueries, projectQueries, orgQueries, type IngestRecord } from '@eve/db';
import { generateIngestId } from '@eve/shared';
import { StorageService } from '../storage/storage.service.js';
import { EventsService } from '../events/events.service.js';

const UPLOAD_TTL_SECONDS = 300;
const DOWNLOAD_TTL_SECONDS = 300;
const MAX_UPLOAD_BYTES = 524288000; // 500 MB

const ALLOWED_SOURCE_CHANNELS = new Set(['upload', 'cli', 'slack', 'api']);

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  private ingests: ReturnType<typeof ingestRecordQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private orgs: ReturnType<typeof orgQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly storage: StorageService,
    private readonly events: EventsService,
  ) {
    this.ingests = ingestRecordQueries(db);
    this.projects = projectQueries(db);
    this.orgs = orgQueries(db);
  }

  async create(
    projectId: string,
    body: {
      file_name: string;
      mime_type: string;
      size_bytes: number;
      title?: string;
      description?: string;
      instructions?: string;
      tags?: string[];
      source_channel?: string;
      callback_url?: string;
    },
    actorType: string,
    actorId?: string | null,
  ) {
    // Validate project exists and resolve org
    const project = await this.projects.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    // Validate file size
    if (body.size_bytes > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(`File size exceeds maximum of ${MAX_UPLOAD_BYTES} bytes`);
    }

    // Validate source channel
    if (body.source_channel && !ALLOWED_SOURCE_CHANNELS.has(body.source_channel)) {
      throw new BadRequestException(`Invalid source_channel: ${body.source_channel}`);
    }

    const ingestId = generateIngestId();
    const storageKey = `ingest/${ingestId}/${body.file_name}`;

    // Create ingest record in DB
    const record = await this.ingests.create({
      id: ingestId,
      org_id: project.org_id,
      project_id: projectId,
      file_name: body.file_name,
      mime_type: body.mime_type,
      size_bytes: body.size_bytes,
      storage_key: storageKey,
      actor_type: actorType,
      actor_id: actorId,
      source_channel: body.source_channel ?? 'upload',
      title: body.title,
      description: body.description,
      instructions: body.instructions,
      tags: body.tags,
      callback_url: body.callback_url,
    });

    // Resolve org for bucket name
    const org = await this.orgs.findById(project.org_id);
    if (!org) throw new NotFoundException(`Org not found for project ${projectId}`);

    const bucketName = await this.storage.ensureOrgBucket(org.slug);

    // Generate presigned upload URL
    const uploadUrl = await this.storage.getPresignedUploadUrl(bucketName, storageKey, {
      contentType: body.mime_type,
      expiresInSeconds: UPLOAD_TTL_SECONDS,
    });

    this.logger.log(`Ingest record created: ${record.id} for project ${projectId}`);

    return {
      ingest_id: record.id,
      upload_url: uploadUrl,
      upload_method: 'PUT' as const,
      upload_expires_at: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
      max_bytes: MAX_UPLOAD_BYTES,
      storage_key: storageKey,
    };
  }

  async confirm(projectId: string, ingestId: string, options?: { force?: boolean }) {
    const record = await this.ingests.findById(ingestId);
    if (!record) throw new NotFoundException(`Ingest record ${ingestId} not found`);
    if (record.project_id !== projectId) {
      throw new NotFoundException(`Ingest record ${ingestId} not found in project ${projectId}`);
    }

    // Idempotent: if already processing or done, return current state
    if (record.status === 'processing' || record.status === 'done') {
      return {
        ingest_id: record.id,
        status: record.status,
        event_id: record.event_id,
        job_id: record.job_id,
      };
    }

    if (record.status !== 'pending') {
      throw new ConflictException(`Ingest record ${ingestId} is in status ${record.status}`);
    }

    // Verify file exists in object store before proceeding
    const org = await this.orgs.findById(record.org_id);
    if (!org) throw new NotFoundException(`Org not found`);

    const bucketName = this.storage.getOrgBucketName(org.slug);
    const metadata = await this.storage.getObjectMetadata(bucketName, record.storage_key);
    if (!metadata) {
      await this.ingests.updateStatus(ingestId, 'failed', {
        error_message: 'File not found in object store. Upload may not have completed.',
      });
      throw new BadRequestException('File not found in object store. Please upload the file first.');
    }

    // Content deduplication: check for existing records with same ETag fingerprint
    const fingerprint = (metadata as any).etag?.replace(/"/g, '');

    if (!options?.force && fingerprint) {
      const existing = await this.db<{ id: string; status: string }[]>`
        SELECT id, status FROM ingest_records
        WHERE project_id = ${record.project_id}
          AND content_fingerprint = ${fingerprint}
          AND id != ${record.id}
          AND status IN ('processing', 'done')
        ORDER BY created_at DESC
        LIMIT 1
      `;

      if (existing.length > 0) {
        // Mark this record as done (deduplicated), link to original
        await this.db`
          UPDATE ingest_records
          SET status = 'done',
              content_fingerprint = ${fingerprint},
              completed_at = NOW(),
              updated_at = NOW()
          WHERE id = ${record.id}
        `;
        this.logger.log(`Ingest deduplicated: ${ingestId} matches ${existing[0].id}`);
        return {
          ingest_id: record.id,
          status: 'done' as const,
          event_id: null,
          job_id: null,
          deduplicated: true,
          original_id: existing[0].id,
        };
      }
    }

    // Save fingerprint on this record regardless
    if (fingerprint) {
      await this.db`
        UPDATE ingest_records
        SET content_fingerprint = ${fingerprint}, updated_at = NOW()
        WHERE id = ${record.id}
      `;
    }

    // Emit system.doc.ingest event so the orchestrator can trigger a processing workflow
    const event = await this.events.create(record.project_id, {
      type: 'system.doc.ingest',
      source: 'system',
      actor_type: (record.actor_type as 'user' | 'system' | 'app') ?? null,
      actor_id: record.actor_id,
      payload_json: {
        org_id: record.org_id,
        project_id: record.project_id,
        ingest_id: record.id,
        file_name: record.file_name,
        mime_type: record.mime_type,
        size_bytes: record.size_bytes,
        storage_key: record.storage_key,
        title: record.title,
        description: record.description,
        instructions: record.instructions,
        tags: record.tags,
        source_channel: record.source_channel,
        callback_url: record.callback_url,
      },
      dedupe_key: `ingest:${record.id}`,
    });

    // Update status to processing with the event ID
    const updated = await this.ingests.updateStatus(ingestId, 'processing', {
      event_id: event.id,
    });

    this.logger.log(`Ingest confirmed: ${ingestId}, event=${event.id}`);

    return {
      ingest_id: updated?.id ?? ingestId,
      status: 'processing' as const,
      event_id: event.id,
      job_id: null, // filled in when orchestrator triggers the workflow
    };
  }

  async findById(projectId: string, ingestId: string) {
    const record = await this.ingests.findById(ingestId);
    if (!record || record.project_id !== projectId) {
      throw new NotFoundException(`Ingest record ${ingestId} not found`);
    }

    const response = this.toResponse(record);

    // Enrich with presigned download URL when storage is available and file exists
    if (this.storage.isConfigured && record.storage_key) {
      const org = await this.orgs.findById(record.org_id);
      if (org) {
        const bucket = this.storage.getOrgBucketName(org.slug);
        const downloadUrl = await this.storage.getPresignedDownloadUrl(bucket, record.storage_key, DOWNLOAD_TTL_SECONDS);
        return {
          ...response,
          download_url: downloadUrl,
          download_url_expires_at: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
        };
      }
    }

    return { ...response, download_url: null, download_url_expires_at: null };
  }

  async list(
    projectId: string,
    options?: { status?: string; limit?: number; offset?: number },
  ) {
    const project = await this.projects.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const records = await this.ingests.findByProjectId(projectId, options);
    const total = await this.ingests.countByProjectId(projectId, options?.status);

    return {
      items: records.map((r: IngestRecord) => this.toResponse(r)),
      total,
    };
  }

  async getDownloadUrl(projectId: string, ingestId: string): Promise<string> {
    const record = await this.ingests.findById(ingestId);
    if (!record || record.project_id !== projectId) {
      throw new NotFoundException(`Ingest record ${ingestId} not found`);
    }
    if (!record.storage_key) {
      throw new NotFoundException(`Ingest record ${ingestId} has no stored file`);
    }

    const org = await this.orgs.findById(record.org_id);
    if (!org) throw new NotFoundException(`Org not found for project ${projectId}`);

    const bucket = this.storage.getOrgBucketName(org.slug);
    return this.storage.getPresignedDownloadUrl(bucket, record.storage_key, DOWNLOAD_TTL_SECONDS);
  }

  private toResponse(record: IngestRecord) {
    return {
      id: record.id,
      org_id: record.org_id,
      project_id: record.project_id,
      file_name: record.file_name,
      mime_type: record.mime_type,
      size_bytes: Number(record.size_bytes),
      storage_key: record.storage_key,
      actor_type: record.actor_type,
      actor_id: record.actor_id,
      source_channel: record.source_channel,
      title: record.title,
      description: record.description,
      instructions: record.instructions,
      tags: record.tags,
      callback_url: record.callback_url,
      status: record.status,
      error_message: record.error_message,
      event_id: record.event_id,
      job_id: record.job_id,
      created_at: record.created_at instanceof Date ? record.created_at.toISOString() : String(record.created_at),
      updated_at: record.updated_at instanceof Date ? record.updated_at.toISOString() : String(record.updated_at),
      completed_at: record.completed_at instanceof Date ? record.completed_at.toISOString() : record.completed_at ? String(record.completed_at) : null,
    };
  }
}
