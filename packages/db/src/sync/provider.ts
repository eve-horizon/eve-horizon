import type { Job } from '../queries/jobs.js';

// ============================================================================
// External Item Types
// ============================================================================

/**
 * Normalized external item representation
 *
 * Common structure that all providers map their items to.
 * This enables provider-agnostic sync logic in SyncEngine.
 */
export interface ExternalItem {
  /** Provider's unique identifier */
  id: string;

  /** Human-readable key (e.g., PROJ-123 in Jira) */
  key?: string;

  /** Item title */
  title: string;

  /** Item description/body (markdown) */
  description?: string;

  /** Provider-specific status (e.g., 'open', 'in_progress', 'closed') */
  status: string;

  /** Priority (0-4, matching Jobs priority) */
  priority?: number;

  /** Issue type (task, bug, feature, etc.) */
  issueType?: string;

  /** Labels/tags */
  labels?: string[];

  /** Assignee identifier */
  assignee?: string;

  /** Parent item ID for hierarchical items */
  parentId?: string;

  /** External URL to the item */
  url?: string;

  /** When the item was last updated on the remote */
  updatedAt?: Date;

  /** Content hash for drift detection */
  contentHash?: string;

  /** Provider-specific metadata */
  meta?: Record<string, unknown>;
}

/**
 * Parameters for creating/updating external items
 */
export interface ExternalItemParams {
  title: string;
  description?: string;
  status: string;
  priority?: number;
  issueType?: string;
  labels?: string[];
  assignee?: string;
  parentId?: string;
  meta?: Record<string, unknown>;
}

// ============================================================================
// Job Create/Update Params
// ============================================================================

/**
 * Parameters for creating a job from external item
 */
export interface JobCreateParams {
  title: string;
  description?: string;
  phase: Job['phase'];
  priority: number;
  issue_type?: string;
  labels?: string[];
  assignee?: string;
  parent_id?: string;
  content_hash?: string;
}

/**
 * Parameters for updating a job from external item
 */
export interface JobUpdateParams {
  title?: string;
  description?: string;
  phase?: Job['phase'];
  priority?: number;
  issue_type?: string;
  labels?: string[];
  assignee?: string;
  content_hash?: string;
}

// ============================================================================
// Sync Provider Interface
// ============================================================================

/**
 * SyncProvider interface
 *
 * Each external system (beads, jira, notion, linear) implements this interface
 * to enable bidirectional sync with the Jobs system.
 *
 * The provider is responsible for:
 * - Fetching items from the external system
 * - Converting between external format and job format
 * - Creating/updating items on the external system
 */
export interface SyncProvider {
  /** Provider identifier (e.g., 'beads', 'jira', 'notion', 'linear') */
  readonly name: string;

  /**
   * Fetch all items from external system
   *
   * For incremental sync, implementations may filter by updatedSince.
   *
   * @param options - Optional fetch options
   * @returns Array of external items
   */
  fetchItems(options?: FetchItemsOptions): Promise<ExternalItem[]>;

  /**
   * Fetch a single item by external ID
   *
   * @param externalId - External system's unique ID
   * @returns External item or null if not found
   */
  fetchItem(externalId: string): Promise<ExternalItem | null>;

  /**
   * Convert external item to job create parameters
   *
   * Maps provider-specific status/fields to job phases and fields.
   *
   * @param item - External item
   * @returns Parameters for creating a job
   */
  toJobParams(item: ExternalItem): JobCreateParams;

  /**
   * Convert external item to job update parameters
   *
   * Only includes fields that should be updated (partial).
   *
   * @param item - External item
   * @returns Parameters for updating a job
   */
  toJobUpdateParams(item: ExternalItem): JobUpdateParams;

  /**
   * Convert job to external item parameters
   *
   * Maps job fields to provider-specific format.
   *
   * @param job - Job from database
   * @returns Parameters for creating/updating external item
   */
  fromJobParams(job: Job): ExternalItemParams;

  /**
   * Create item on external system
   *
   * @param params - External item parameters
   * @returns External ID of created item
   */
  createItem(params: ExternalItemParams): Promise<string>;

  /**
   * Update item on external system
   *
   * @param externalId - External system's unique ID
   * @param params - Fields to update
   */
  updateItem(externalId: string, params: Partial<ExternalItemParams>): Promise<void>;

  /**
   * Push item to external system (create or update)
   *
   * Convenience method that handles both create and update.
   *
   * @param params - External item parameters
   * @param existingId - Optional existing external ID for update
   * @returns External ID
   */
  pushItem(params: ExternalItemParams, existingId?: string): Promise<string>;

  /**
   * Check if external item exists
   *
   * @param externalId - External system's unique ID
   * @returns True if item exists
   */
  itemExists(externalId: string): Promise<boolean>;

  /**
   * Delete item from external system
   *
   * @param externalId - External system's unique ID
   */
  deleteItem?(externalId: string): Promise<void>;

  /**
   * Generate content hash for an external item
   *
   * Used for drift detection between syncs.
   *
   * @param item - External item
   * @returns Content hash string
   */
  computeHash?(item: ExternalItem): string;
}

// ============================================================================
// Fetch Options
// ============================================================================

export interface FetchItemsOptions {
  /** Only fetch items updated after this date */
  updatedSince?: Date;

  /** Limit number of items fetched */
  limit?: number;

  /** Filter by status */
  status?: string[];

  /** Filter by labels */
  labels?: string[];

  /** Include closed/done items */
  includeClosed?: boolean;
}

// ============================================================================
// Status Mapping Helpers
// ============================================================================

/**
 * Standard status to phase mapping
 *
 * Providers can use this as a base and extend for provider-specific statuses.
 */
export const STATUS_TO_PHASE: Record<string, Job['phase']> = {
  // Common statuses
  open: 'backlog',
  todo: 'backlog',
  new: 'backlog',
  backlog: 'backlog',

  // Active statuses
  in_progress: 'active',
  in_review: 'review',
  reviewing: 'review',

  // Done statuses
  closed: 'done',
  done: 'done',
  resolved: 'done',
  completed: 'done',

  // Cancelled
  cancelled: 'cancelled',
  wontfix: 'cancelled',
  wont_fix: 'cancelled',
  invalid: 'cancelled',
};

/**
 * Phase to status mapping (for outbound sync)
 *
 * Default mapping when pushing to external systems.
 */
export const PHASE_TO_STATUS: Record<Job['phase'], string> = {
  idea: 'open',
  backlog: 'open',
  ready: 'open',
  active: 'in_progress',
  review: 'in_progress',
  done: 'resolved',
  cancelled: 'cancelled',
};

/**
 * Map external status to job phase
 *
 * @param status - External status string
 * @param customMapping - Optional provider-specific mapping
 * @returns Job phase
 */
export function mapStatusToPhase(
  status: string,
  customMapping?: Record<string, Job['phase']>,
): Job['phase'] {
  const normalizedStatus = status.toLowerCase().replace(/[- ]/g, '_');
  const mapping = { ...STATUS_TO_PHASE, ...customMapping };
  return mapping[normalizedStatus] ?? 'backlog';
}

/**
 * Map job phase to external status
 *
 * @param phase - Job phase
 * @param customMapping - Optional provider-specific mapping
 * @returns External status string
 */
export function mapPhaseToStatus(
  phase: Job['phase'],
  customMapping?: Record<Job['phase'], string>,
): string {
  const mapping = { ...PHASE_TO_STATUS, ...customMapping };
  return mapping[phase] ?? 'open';
}
