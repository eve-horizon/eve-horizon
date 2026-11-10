import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { jobAttachmentQueries, jobQueries, type Job, type JobAttachment } from '@eve/db';
import {
  MAX_ATTACHMENT_SIZE,
  MAX_TOTAL_ATTACHMENTS_SIZE,
  type JobAttachmentResponse,
  type JobAttachmentDetailResponse,
  type JobAttachmentListResponse,
  type CreateJobAttachmentRequest,
} from '@eve/shared';
import { JobsService } from '../jobs/jobs.service.js';
import type { AuthUser } from '../auth/auth.types.js';

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class JobAttachmentsService {
  private attachments: ReturnType<typeof jobAttachmentQueries>;
  private jobs: ReturnType<typeof jobQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly jobsService: JobsService,
  ) {
    this.attachments = jobAttachmentQueries(db);
    this.jobs = jobQueries(db);
  }

  /**
   * Validate that a job exists, throw NotFoundException if not.
   */
  private async requireJob(jobId: string): Promise<Job> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }
    return job;
  }

  /**
   * A job's attachments are what its children (agent_context.parent_attachments)
   * and jobs that reference them (job_attachments: resource refs) take in, so
   * adding or removing one is judged and applied like a change to what the job
   * runs (see JobsService.changeWhatJobRuns). Each reader also takes in only
   * the attachments its own actor created.
   */
  private changeAttachments<T>(
    job: Job,
    caller: AuthUser | undefined,
    change: (attachments: ReturnType<typeof jobAttachmentQueries>) => Promise<T>,
  ): Promise<T> {
    if (!caller) {
      return change(this.attachments);
    }
    return this.jobsService.changeWhatJobRuns(job, caller, (tx) => change(jobAttachmentQueries(tx)));
  }

  /**
   * Create a new attachment on a job.
   */
  async create(
    jobId: string,
    data: CreateJobAttachmentRequest,
    caller?: AuthUser,
  ): Promise<JobAttachmentDetailResponse> {
    const job = await this.requireJob(jobId);

    // Enforce single-attachment size limit
    const contentSize = Buffer.byteLength(data.content, 'utf8');
    if (contentSize > MAX_ATTACHMENT_SIZE) {
      throw new BadRequestException(
        `Attachment size (${contentSize} bytes) exceeds maximum of ${MAX_ATTACHMENT_SIZE} bytes (1 MB)`,
      );
    }

    // Enforce total-attachments size limit for the job
    const currentTotal = await this.attachments.totalSizeForJob(jobId);
    if (currentTotal + contentSize > MAX_TOTAL_ATTACHMENTS_SIZE) {
      throw new BadRequestException(
        `Adding this attachment would exceed the total limit of ${MAX_TOTAL_ATTACHMENTS_SIZE} bytes (10 MB) for job ${jobId}`,
      );
    }

    const attachment = await this.changeAttachments(job, caller, (attachments) => attachments.create({
      job_id: jobId,
      name: data.name,
      mime_type: data.mime_type ?? 'text/plain',
      content: data.content,
      created_by: caller?.user_id ?? null,
    }));

    return this.toDetailResponse(attachment);
  }

  /**
   * List all attachments for a job (metadata only).
   */
  async list(jobId: string): Promise<JobAttachmentListResponse> {
    await this.requireJob(jobId);

    const attachments = await this.attachments.findByJobId(jobId);
    return {
      attachments: attachments.map(a => this.toResponse(a)),
    };
  }

  /**
   * Get a single attachment by ID (with content).
   */
  async findById(jobId: string, attachmentId: string): Promise<JobAttachmentDetailResponse> {
    await this.requireJob(jobId);

    const attachment = await this.attachments.findById(attachmentId);
    if (!attachment || attachment.job_id !== jobId) {
      throw new NotFoundException(`Attachment not found: ${attachmentId}`);
    }

    return this.toDetailResponse(attachment);
  }

  /**
   * Delete an attachment by ID.
   */
  async delete(jobId: string, attachmentId: string, caller?: AuthUser): Promise<{ success: boolean; message: string }> {
    const job = await this.requireJob(jobId);

    // Verify the attachment belongs to this job
    const attachment = await this.attachments.findById(attachmentId);
    if (!attachment || attachment.job_id !== jobId) {
      throw new NotFoundException(`Attachment not found: ${attachmentId}`);
    }

    await this.changeAttachments(job, caller, async (attachments) => {
      if (!(await attachments.delete(attachmentId))) {
        throw new NotFoundException(`Attachment not found: ${attachmentId}`);
      }
    });

    return { success: true, message: `Attachment ${attachmentId} deleted` };
  }

  // --------------------------------------------------------------------------
  // Response Mappers
  // --------------------------------------------------------------------------

  private toResponse(a: JobAttachment): JobAttachmentResponse {
    return {
      id: a.id,
      job_id: a.job_id,
      name: a.name,
      mime_type: a.mime_type,
      content_hash: a.content_hash,
      created_by: a.created_by,
      created_at: a.created_at instanceof Date ? a.created_at.toISOString() : String(a.created_at),
    };
  }

  private toDetailResponse(a: JobAttachment): JobAttachmentDetailResponse {
    return {
      ...this.toResponse(a),
      content: a.content,
    };
  }
}
