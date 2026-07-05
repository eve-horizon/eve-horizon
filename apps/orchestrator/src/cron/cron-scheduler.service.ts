import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import { eventQueries, projectManifestQueries, projectQueries, scheduleQueries, type Db, type Schedule } from '@eve/db';
import { generateEventId } from '@eve/shared';
import * as yaml from 'yaml';

/**
 * Cron scheduler service for Phase 5.
 *
 * This service manages cron-based triggers. On initialization, it will
 * scan project manifests for cron trigger definitions and schedule them.
 *
 * On startup, we scan latest manifests for cron triggers and register
 * corresponding schedules. Future phases can add live reload on manifest sync.
 *
 * When a cron schedule fires, it creates an event with:
 * - type: 'cron.tick'
 * - source: 'cron'
 * - payload_json: { schedule: '0 * * * *', trigger_name: 'example' }
 * - actor_type: 'system'
 */
type CronTrigger = {
  projectId: string;
  triggerName: string;
  schedule: string;
};

@Injectable()

export class CronSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronSchedulerService.name);
  private cronJobs: Array<{ key: string; job: CronJob }> = [];
  private events: ReturnType<typeof eventQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private schedules: ReturnType<typeof scheduleQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.events = eventQueries(db);
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
    this.schedules = scheduleQueries(db);
  }

  async onModuleInit() {
    this.logger.log('Starting cron scheduler service');
    await this.registerManifestCronJobs();
    await this.registerScheduleCronJobs();
  }

  private async registerScheduleCronJobs(): Promise<void> {
    const schedules = await this.schedules.listAll();
    const enabled = schedules.filter((schedule) => schedule.enabled);
    if (enabled.length === 0) {
      this.logger.log('No enabled schedules found');
      return;
    }

    for (const schedule of enabled) {
      this.registerScheduleCronJob(schedule, 'UTC');
    }
  }

  /**
   * Register cron jobs from the latest project manifests.
   */
  private async registerManifestCronJobs(): Promise<void> {
    const triggers = await this.loadManifestCronTriggers();
    if (triggers.length === 0) {
      this.logger.log('No cron triggers found in manifests');
      return;
    }

    for (const trigger of triggers) {
      this.registerCronJob(trigger.schedule, trigger.triggerName, trigger.projectId, 'UTC');
    }
  }

  private async loadManifestCronTriggers(): Promise<CronTrigger[]> {
    const triggers: CronTrigger[] = [];
    const manifests = await this.manifests.listLatest();

    for (const manifestRecord of manifests) {
      const parsed = this.parseManifest(manifestRecord.manifest_yaml);
      if (!parsed) {
        continue;
      }

      this.collectCronTriggers(parsed.workflows, manifestRecord.project_id, triggers);
      this.collectCronTriggers(parsed.pipelines, manifestRecord.project_id, triggers);
    }

    return triggers;
  }

  private collectCronTriggers(
    section: unknown,
    projectId: string,
    out: CronTrigger[],
  ): void {
    if (!section || typeof section !== 'object') {
      return;
    }

    for (const [name, definition] of Object.entries(section)) {
      if (!definition || typeof definition !== 'object') {
        continue;
      }

      const trigger = (definition as Record<string, unknown>).trigger;
      if (!trigger || typeof trigger !== 'object') {
        continue;
      }

      const cron = (trigger as { cron?: { schedule?: string } }).cron;
      const schedule = cron?.schedule;
      if (!schedule || typeof schedule !== 'string') {
        continue;
      }

      out.push({
        projectId,
        triggerName: name,
        schedule,
      });
    }
  }

  private parseManifest(manifestYaml: string): Record<string, unknown> | null {
    try {
      const parsed = yaml.parse(manifestYaml);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      this.logger.error('Failed to parse manifest YAML for cron triggers:', error instanceof Error ? error.stack : String(error));
      return null;
    }
  }

  /**
   * Handle a cron tick by creating an event.
   *
   * This method is called when a cron schedule fires. It creates an event
   * in the database that will be picked up by the event router.
   *
   * @param schedule - The cron schedule expression (e.g., '0 * * * *')
   * @param triggerName - The name of the trigger from the manifest
   * @param projectId - The project ID this cron belongs to
   */
  private async handleCronTick(
    schedule: string,
    triggerName: string,
    projectId: string,
  ): Promise<void> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      this.logger.warn(
        `Cron trigger "${triggerName}" references missing/deleted project ${projectId}; unregistering`,
      );
      this.unregisterCronJobs((entry) =>
        entry.key.startsWith(`${projectId}:${triggerName}:${schedule}:`),
      );
      return;
    }

    this.logger.log(`Cron tick: schedule="${schedule}" trigger="${triggerName}" project="${projectId}"`);

    const payload = {
      schedule,
      trigger_name: triggerName,
    };
    const dedupeKey = `cron:${projectId}:${triggerName}:${schedule}:${this.currentMinuteKey()}`;
    const eventId = generateEventId();
    await this.events.create({
      id: eventId,
      project_id: projectId,
      type: 'cron.tick',
      source: 'cron',
      env_name: null,
      ref_sha: null,
      ref_branch: null,
      actor_type: 'system',
      actor_id: null,
      payload_json: payload,
      dedupe_key: dedupeKey,
    });

    this.logger.log(`  -> Created event ${eventId} for cron tick`);
  }

  private async handleScheduleTick(schedule: Schedule): Promise<void> {
    const project = await this.projects.findById(schedule.project_id);
    if (!project) {
      this.logger.warn(
        `Schedule "${schedule.id}" references missing/deleted project ${schedule.project_id}; unregistering`,
      );
      this.unregisterCronJobs((entry) =>
        entry.key.startsWith(`schedule:${schedule.project_id}:${schedule.id}:${schedule.cron}:`),
      );
      return;
    }

    this.logger.log(`Schedule tick: schedule="${schedule.cron}" id="${schedule.id}" project="${schedule.project_id}"`);

    const payload = {
      schedule: schedule.cron,
      schedule_id: schedule.id,
    };
    const dedupeKey = `schedule:${schedule.project_id}:${schedule.id}:${this.currentMinuteKey()}`;
    const eventId = generateEventId();
    await this.events.create({
      id: eventId,
      project_id: schedule.project_id,
      type: schedule.event_type,
      source: 'cron',
      env_name: null,
      ref_sha: null,
      ref_branch: null,
      actor_type: 'system',
      actor_id: null,
      payload_json: payload,
      dedupe_key: dedupeKey,
    });

    this.logger.log(`  -> Created event ${eventId} for schedule ${schedule.id}`);
  }

  private currentMinuteKey(): string {
    const now = new Date();
    const minutes = now.getUTCMinutes().toString().padStart(2, '0');
    const hours = now.getUTCHours().toString().padStart(2, '0');
    const date = now.toISOString().slice(0, 10);
    return `${date}T${hours}:${minutes}`;
  }

  /**
   * Register a cron job dynamically.
   *
   * This method will be used in future phases to register cron jobs
   * dynamically when manifests are scanned or updated.
   *
   * @param schedule - Cron schedule expression (e.g., '0 * * * *')
   * @param triggerName - Name of the trigger
   * @param projectId - Project ID
   * @param timezone - Optional timezone (defaults to 'America/New_York')
   */
  public registerCronJob(
    schedule: string,
    triggerName: string,
    projectId: string,
    timezone = 'UTC',
  ): void {
    const key = `${projectId}:${triggerName}:${schedule}:${timezone}`;
    if (this.cronJobs.some((entry) => entry.key === key)) {
      return;
    }

    this.logger.log(`Registering cron job: "${triggerName}" with schedule: ${schedule}`);

    try {
      const job = new CronJob(
        schedule,
        () => {
          this.handleCronTick(schedule, triggerName, projectId).catch((error) => {
            this.logger.error(`Error handling cron tick for ${triggerName}: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
        null, // onComplete
        true, // start immediately
        timezone,
      );

      this.cronJobs.push({ key, job });
      this.logger.log(`Successfully registered cron job: "${triggerName}"`);
    } catch (error) {
      this.logger.error(`Failed to register cron job "${triggerName}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public registerScheduleCronJob(schedule: Schedule, timezone = 'UTC'): void {
    const key = `schedule:${schedule.project_id}:${schedule.id}:${schedule.cron}:${timezone}`;
    if (this.cronJobs.some((entry) => entry.key === key)) {
      return;
    }

    this.logger.log(`Registering schedule: "${schedule.id}" with schedule: ${schedule.cron}`);

    try {
      const job = new CronJob(
        schedule.cron,
        () => {
          this.handleScheduleTick(schedule).catch((error) => {
            this.logger.error(`Error handling schedule tick for ${schedule.id}: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
        null,
        true,
        timezone,
      );

      this.cronJobs.push({ key, job });
      this.logger.log(`Successfully registered schedule: "${schedule.id}"`);
    } catch (error) {
      this.logger.error(`Failed to register schedule "${schedule.id}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private unregisterCronJobs(predicate: (entry: { key: string; job: CronJob }) => boolean): void {
    const keep: Array<{ key: string; job: CronJob }> = [];
    for (const entry of this.cronJobs) {
      if (predicate(entry)) {
        try {
          entry.job.stop();
        } catch (error) {
          this.logger.warn(`Failed stopping cron job "${entry.key}": ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        keep.push(entry);
      }
    }
    this.cronJobs = keep;
  }

  /**
   * Unregister all cron jobs (cleanup on module destroy).
   */
  onModuleDestroy() {
    this.logger.log(`Stopping ${this.cronJobs.length} cron job(s)`);
    for (const entry of this.cronJobs) {
      entry.job.stop();
    }
    this.cronJobs = [];
  }
}
