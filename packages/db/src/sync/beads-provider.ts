import { execSync } from 'child_process';
import crypto from 'crypto';
import type { Job } from '../queries/jobs.js';
import type {
  SyncProvider,
  ExternalItem,
  ExternalItemParams,
  JobCreateParams,
  JobUpdateParams,
  FetchItemsOptions,
} from './provider.js';

// ============================================================================
// Beads CLI Response Types
// ============================================================================

interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed' | 'wontfix';
  priority: number;
  type?: string;
  labels?: string[];
  assignee?: string;
  parent_id?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
}

interface BeadsListResponse {
  issues: BeadsIssue[];
  total?: number;
}

interface BeadsShowResponse {
  issue: BeadsIssue;
}

interface BeadsCreateResponse {
  id: string;
  issue: BeadsIssue;
}

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Beads status to Job phase mapping
 *
 * - open -> backlog (not yet started)
 * - in_progress -> active (being worked on)
 * - resolved -> done (completed)
 * - closed -> done (completed/archived)
 * - wontfix -> cancelled
 */
const BEADS_STATUS_TO_PHASE: Record<BeadsIssue['status'], Job['phase']> = {
  open: 'backlog',
  in_progress: 'active',
  resolved: 'done',
  closed: 'done',
  wontfix: 'cancelled',
};

/**
 * Job phase to Beads status mapping
 *
 * Multiple phases map to same beads status since beads has fewer states.
 */
const PHASE_TO_BEADS_STATUS: Record<Job['phase'], BeadsIssue['status']> = {
  idea: 'open',
  backlog: 'open',
  ready: 'open',
  active: 'in_progress',
  review: 'in_progress', // Beads doesn't have review state
  done: 'resolved',
  cancelled: 'wontfix',
};

// ============================================================================
// Beads Provider Implementation
// ============================================================================

export interface BeadsProviderOptions {
  /** Working directory for beads CLI (defaults to cwd) */
  cwd?: string;

  /** Timeout for CLI commands in ms (defaults to 30000) */
  timeout?: number;
}

/**
 * BeadsProvider - Sync provider for local Beads issue tracker
 *
 * Uses the `bd` CLI to interact with beads issues stored in `.beads/` directory.
 * Requires beads CLI to be installed and available in PATH.
 *
 * Beads stores issues as YAML files: `.beads/issues/{id}.yaml`
 */
export class BeadsProvider implements SyncProvider {
  readonly name = 'beads';

  private readonly cwd: string;
  private readonly timeout: number;

  constructor(options: BeadsProviderOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.timeout = options.timeout ?? 30000;
  }

  // --------------------------------------------------------------------------
  // CLI Execution
  // --------------------------------------------------------------------------

  /**
   * Execute beads CLI command and parse JSON response
   */
  private exec<T>(command: string): T {
    try {
      const output = execSync(`bd ${command} --format=json`, {
        encoding: 'utf-8',
        cwd: this.cwd,
        timeout: this.timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return JSON.parse(output) as T;
    } catch (error) {
      if (error instanceof Error) {
        // Extract stderr if available
        const execError = error as Error & { stderr?: string };
        const stderr = execError.stderr ?? '';
        throw new Error(`Beads CLI error: ${error.message}${stderr ? `\n${stderr}` : ''}`);
      }
      throw error;
    }
  }

  /**
   * Execute beads CLI command without JSON response
   */
  private execRaw(command: string): string {
    try {
      return execSync(`bd ${command}`, {
        encoding: 'utf-8',
        cwd: this.cwd,
        timeout: this.timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (error instanceof Error) {
        const execError = error as Error & { stderr?: string };
        const stderr = execError.stderr ?? '';
        throw new Error(`Beads CLI error: ${error.message}${stderr ? `\n${stderr}` : ''}`);
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // SyncProvider Implementation
  // --------------------------------------------------------------------------

  async fetchItems(options?: FetchItemsOptions): Promise<ExternalItem[]> {
    let command = 'list';

    // Add filters
    const filters: string[] = [];

    if (options?.status?.length) {
      filters.push(`--status=${options.status.join(',')}`);
    }

    if (options?.labels?.length) {
      filters.push(`--labels=${options.labels.join(',')}`);
    }

    if (options?.includeClosed === false) {
      filters.push('--open');
    }

    if (options?.limit) {
      filters.push(`--limit=${options.limit}`);
    }

    if (filters.length > 0) {
      command += ' ' + filters.join(' ');
    }

    const response = this.exec<BeadsListResponse>(command);
    return response.issues.map((issue) => this.parseBeadsIssue(issue));
  }

  async fetchItem(externalId: string): Promise<ExternalItem | null> {
    try {
      const response = this.exec<BeadsShowResponse>(`show ${externalId}`);
      return this.parseBeadsIssue(response.issue);
    } catch {
      // Issue not found or other error
      return null;
    }
  }

  toJobParams(item: ExternalItem): JobCreateParams {
    return {
      title: item.title,
      description: item.description,
      phase: BEADS_STATUS_TO_PHASE[item.status as BeadsIssue['status']] ?? 'backlog',
      priority: item.priority ?? 2,
      issue_type: item.issueType ?? 'task',
      labels: item.labels ?? [],
      assignee: item.assignee,
      parent_id: item.parentId,
      content_hash: item.contentHash ?? this.computeHash(item),
    };
  }

  toJobUpdateParams(item: ExternalItem): JobUpdateParams {
    const params: JobUpdateParams = {};

    if (item.title) params.title = item.title;
    if (item.description !== undefined) params.description = item.description;
    if (item.status) {
      params.phase = BEADS_STATUS_TO_PHASE[item.status as BeadsIssue['status']] ?? 'backlog';
    }
    if (item.priority !== undefined) params.priority = item.priority;
    if (item.issueType) params.issue_type = item.issueType;
    if (item.labels) params.labels = item.labels;
    if (item.assignee !== undefined) params.assignee = item.assignee;

    params.content_hash = this.computeHash(item);

    return params;
  }

  fromJobParams(job: Job): ExternalItemParams {
    return {
      title: job.title,
      description: job.description ?? undefined,
      status: PHASE_TO_BEADS_STATUS[job.phase],
      priority: job.priority,
      issueType: job.issue_type,
      labels: job.labels,
      assignee: job.assignee ?? undefined,
      parentId: job.parent_id ?? undefined,
    };
  }

  async createItem(params: ExternalItemParams): Promise<string> {
    // Build create command
    const args: string[] = [];

    // Title is required - escape for shell
    const escapedTitle = params.title.replace(/"/g, '\\"');
    args.push(`"${escapedTitle}"`);

    if (params.priority !== undefined) {
      args.push(`--priority=${params.priority}`);
    }

    if (params.issueType) {
      args.push(`--type=${params.issueType}`);
    }

    if (params.labels?.length) {
      args.push(`--labels=${params.labels.join(',')}`);
    }

    if (params.assignee) {
      args.push(`--assignee=${params.assignee}`);
    }

    if (params.parentId) {
      args.push(`--parent=${params.parentId}`);
    }

    const command = `create ${args.join(' ')}`;
    const response = this.exec<BeadsCreateResponse>(command);

    // Set description if provided (separate command)
    if (params.description) {
      const escapedDesc = params.description.replace(/"/g, '\\"');
      this.execRaw(`update ${response.id} --description="${escapedDesc}"`);
    }

    return response.id;
  }

  async updateItem(externalId: string, params: Partial<ExternalItemParams>): Promise<void> {
    const args: string[] = [externalId];

    if (params.title) {
      const escapedTitle = params.title.replace(/"/g, '\\"');
      args.push(`--title="${escapedTitle}"`);
    }

    if (params.description !== undefined) {
      const escapedDesc = params.description.replace(/"/g, '\\"');
      args.push(`--description="${escapedDesc}"`);
    }

    if (params.status) {
      args.push(`--status=${params.status}`);
    }

    if (params.priority !== undefined) {
      args.push(`--priority=${params.priority}`);
    }

    if (params.labels) {
      args.push(`--labels=${params.labels.join(',')}`);
    }

    if (params.assignee !== undefined) {
      args.push(`--assignee=${params.assignee || ''}`);
    }

    if (args.length > 1) {
      this.execRaw(`update ${args.join(' ')}`);
    }
  }

  async pushItem(params: ExternalItemParams, existingId?: string): Promise<string> {
    if (existingId) {
      await this.updateItem(existingId, params);
      return existingId;
    }

    return this.createItem(params);
  }

  async itemExists(externalId: string): Promise<boolean> {
    const item = await this.fetchItem(externalId);
    return item !== null;
  }

  async deleteItem(externalId: string): Promise<void> {
    try {
      this.execRaw(`delete ${externalId} --force`);
    } catch {
      // Ignore errors (item may already be deleted)
    }
  }

  computeHash(item: ExternalItem): string {
    const content = JSON.stringify({
      title: item.title,
      description: item.description ?? '',
      status: item.status,
      priority: item.priority,
      labels: (item.labels ?? []).sort(),
    });

    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Parse beads issue to normalized ExternalItem
   */
  private parseBeadsIssue(issue: BeadsIssue): ExternalItem {
    return {
      id: issue.id,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      issueType: issue.type,
      labels: issue.labels,
      assignee: issue.assignee,
      parentId: issue.parent_id,
      updatedAt: issue.updated_at ? new Date(issue.updated_at) : undefined,
      contentHash: this.computeHashFromBeadsIssue(issue),
    };
  }

  /**
   * Compute content hash from raw beads issue
   */
  private computeHashFromBeadsIssue(issue: BeadsIssue): string {
    const content = JSON.stringify({
      title: issue.title,
      description: issue.description ?? '',
      status: issue.status,
      priority: issue.priority,
      labels: (issue.labels ?? []).sort(),
    });

    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  // --------------------------------------------------------------------------
  // Beads-Specific Methods
  // --------------------------------------------------------------------------

  /**
   * Get ready issues from beads (open issues with no blocking deps)
   */
  async getReadyIssues(): Promise<ExternalItem[]> {
    const response = this.exec<BeadsListResponse>('ready');
    return response.issues.map((issue) => this.parseBeadsIssue(issue));
  }

  /**
   * Get blocked issues from beads
   */
  async getBlockedIssues(): Promise<ExternalItem[]> {
    const response = this.exec<BeadsListResponse>('blocked');
    return response.issues.map((issue) => this.parseBeadsIssue(issue));
  }

  /**
   * Close a beads issue
   */
  async closeIssue(externalId: string, reason?: string): Promise<void> {
    let command = `close ${externalId}`;
    if (reason) {
      const escapedReason = reason.replace(/"/g, '\\"');
      command += ` --reason="${escapedReason}"`;
    }
    this.execRaw(command);
  }

  /**
   * Reopen a beads issue
   */
  async reopenIssue(externalId: string): Promise<void> {
    this.execRaw(`reopen ${externalId}`);
  }

  /**
   * Add dependency between beads issues
   */
  async addDependency(fromId: string, toId: string, type: string = 'blocks'): Promise<void> {
    this.execRaw(`dep add ${fromId} ${toId} --type=${type}`);
  }

  /**
   * Remove dependency between beads issues
   */
  async removeDependency(fromId: string, toId: string): Promise<void> {
    this.execRaw(`dep remove ${fromId} ${toId}`);
  }
}
