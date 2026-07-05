import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { jobQueries, projectQueries, batchJobQueries, type JobHints, type JobGitConfig } from '@eve/db';
import type { CreateBatchRequest, CreateBatchResponse, BatchValidateResponse, BatchValidationError } from '@eve/shared';
import { generateBatchId } from '@eve/shared';

/**
 * Batch job graph validation and atomic creation.
 *
 * Extracted verbatim from JobsService (R-C5). JobsService delegates here so
 * the controller-facing surface is unchanged.
 */
@Injectable()
export class JobBatchService {
  private jobs: ReturnType<typeof jobQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private batchJobs: ReturnType<typeof batchJobQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.jobs = jobQueries(db);
    this.projects = projectQueries(db);
    this.batchJobs = batchJobQueries(db);
  }

  /**
   * Resolve project slug/ID and convert errors to NotFoundException
   *
   * (Verbatim copy of JobsService.resolveProject — kept local instead of a
   * callback to avoid circular DI between JobsService and this service.)
   */
  private async resolveProject(projectId: string): Promise<string> {
    try {
      return await this.jobs.resolveProjectSlug(projectId);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Project not found')) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  /**
   * Validate a batch job graph without creating any jobs.
   *
   * Checks for duplicate keys, unknown parent/dependency references,
   * cycles in the dependency graph, and max nesting depth.
   */
  async validateBatch(_projectId: string, request: CreateBatchRequest): Promise<BatchValidateResponse> {
    const errors: BatchValidationError[] = [];

    // 1. Check for duplicate keys
    const keys = request.nodes.map(n => n.key);
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) {
        errors.push({ code: 'batch_node_duplicate', node_key: k, message: `Duplicate node key: ${k}` });
      }
      seen.add(k);
    }

    // 2. Verify parent references exist in nodes
    for (const node of request.nodes) {
      if (node.parent && !seen.has(node.parent)) {
        errors.push({
          code: 'batch_node_unknown',
          node_key: node.key,
          field: 'parent',
          message: `Unknown parent key: ${node.parent}`,
          hint: `Use one of: ${keys.join(', ')}`,
        });
      }
    }

    // 3. Verify dependency references
    for (const dep of request.dependencies) {
      if (!seen.has(dep.job)) {
        errors.push({
          code: 'batch_node_unknown',
          field: 'dependencies',
          message: `Unknown job key: ${dep.job}`,
        });
      }
      for (const d of dep.depends_on) {
        if (!seen.has(d)) {
          errors.push({
            code: 'batch_node_unknown',
            node_key: dep.job,
            field: 'dependencies',
            message: `Unknown dependency key: ${d}`,
            hint: `Use one of: ${keys.join(', ')}`,
          });
        }
      }
    }

    // 4. Check for cycles (only if no reference errors above)
    if (errors.length === 0) {
      const graph = new Map<string, string[]>();
      for (const node of request.nodes) graph.set(node.key, []);
      for (const dep of request.dependencies) {
        graph.get(dep.job)?.push(...dep.depends_on);
      }
      // Parent edges: child implicitly depends on parent
      for (const node of request.nodes) {
        if (node.parent) graph.get(node.key)?.push(node.parent);
      }

      if (hasCycle(graph)) {
        errors.push({ code: 'batch_graph_cycle', message: 'Dependency graph contains a cycle' });
      }
    }

    // 5. Check max nesting depth (max 3 levels of parent nesting)
    if (errors.length === 0) {
      const parentMap = new Map<string, string | undefined>();
      for (const node of request.nodes) {
        parentMap.set(node.key, node.parent);
      }
      for (const node of request.nodes) {
        let depth = 0;
        let cursor: string | undefined = node.parent;
        while (cursor) {
          depth++;
          if (depth > 3) {
            errors.push({
              code: 'batch_depth_exceeded',
              node_key: node.key,
              message: `Node "${node.key}" exceeds max nesting depth of 3`,
            });
            break;
          }
          cursor = parentMap.get(cursor);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Create an entire job tree atomically: validate, create batch record,
   * create jobs in topological order, wire parent/dependency edges.
   */
  async createBatch(
    projectId: string,
    request: CreateBatchRequest,
    correlationId?: string,
    userId?: string,
  ): Promise<CreateBatchResponse> {
    // 1. Validate the graph
    const validation = await this.validateBatch(projectId, request);
    if (!validation.valid) {
      throw new BadRequestException({
        error: { code: 'batch_validation_failed', errors: validation.errors },
      });
    }

    // 2. Resolve project
    const resolvedProjectId = await this.resolveProject(projectId);
    const project = await this.projects.findById(resolvedProjectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // 3. Check idempotency
    if (request.idempotency_key) {
      const existing = await this.batchJobs.findByIdempotencyKey(resolvedProjectId, request.idempotency_key);
      if (existing) {
        return this.reconstructBatchResult(existing.id, request);
      }
    }

    // 4. Create batch record
    const batchId = generateBatchId();
    await this.batchJobs.create({
      id: batchId,
      project_id: resolvedProjectId,
      idempotency_key: request.idempotency_key ?? null,
      node_count: request.nodes.length,
      created_by: correlationId ?? null,
    });

    // 5. Topological sort - create parents before children, dependencies before dependents
    const sorted = topologicalSort(request);

    // 6. Create jobs in order, collecting key -> jobId mapping
    const keyToJobId = new Map<string, string>();
    const keyToPhase = new Map<string, string>();

    for (const nodeKey of sorted) {
      const node = request.nodes.find(n => n.key === nodeKey)!;

      // Resolve parent ID from the key mapping
      const parentJobId = node.parent ? keyToJobId.get(node.parent) ?? null : null;

      // Generate job ID
      const { id: jobId, projectId: resolvedId } = await this.jobs.generateJobId(
        resolvedProjectId,
        parentJobId ?? undefined,
      );

      // Calculate depth
      const depth = parentJobId ? parentJobId.split('.').length : 0;

      // Determine initial phase: if this node has dependencies, start as 'backlog'
      const hasDeps = request.dependencies.some(d => d.job === nodeKey && d.depends_on.length > 0);
      const phase = hasDeps ? 'backlog' : 'ready';

      // Auto-generate title from description if not provided
      const title = node.title;

      // Create the job
      await this.jobs.create({
        id: jobId,
        project_id: resolvedId,
        parent_id: parentJobId,
        depth,
        title,
        description: node.description ?? title,
        issue_type: node.type === 'epic' ? 'epic' : 'task',
        labels: [],
        phase,
        priority: 2,
        assignee: null,
        review_required: 'none',
        review_status: null,
        reviewer: null,
        defer_until: null,
        due_at: null,
        hints: node.hints as JobHints ?? {},
        harness: null,
        harness_profile: null,
        harness_options: null,
        harness_profile_override: null,
        env_overrides: null,
        token_scope: null,
        token_permissions: null,
        harness_profile_source: null,
        harness_profile_hash: null,
        git_json: node.git ? node.git as unknown as JobGitConfig : null,
        resolved_git_json: null,
        workspace_json: null,
        blocked_on_gates: [],
        env_name: null,
        execution_mode: 'persistent',
        execution_type: 'agent',
        run_id: null,
        step_name: null,
        action_type: null,
        action_input: null,
        script_command: null,
        script_timeout_seconds: null,
        target: node.target ?? null,
        resource_refs: node.resource_refs ?? [],
        content_hash: null,
        actor_user_id: userId ?? null,
        failure_disposition: null,
        closed_at: null,
        close_reason: null,
      });

      // Tag the job with batch metadata
      await this.db`
        UPDATE jobs
        SET batch_id = ${batchId}, batch_key = ${node.key}
        WHERE id = ${jobId}
      `;

      keyToJobId.set(nodeKey, jobId);
      keyToPhase.set(nodeKey, phase);
    }

    // 7. Wire explicit dependencies
    const depsByKey = new Map<string, string[]>();
    for (const dep of request.dependencies) {
      for (const dependsOnKey of dep.depends_on) {
        const fromJobId = keyToJobId.get(dep.job)!;
        const toJobId = keyToJobId.get(dependsOnKey)!;
        await this.jobs.addDependency(fromJobId, toJobId, 'blocks');

        if (!depsByKey.has(dep.job)) depsByKey.set(dep.job, []);
        depsByKey.get(dep.job)!.push(dependsOnKey);
      }
    }

    // 8. Build response
    const jobs: Record<string, { job_id: string; phase: string; blocked_by?: string[] }> = {};
    for (const node of request.nodes) {
      const blockedBy = depsByKey.get(node.key);
      jobs[node.key] = {
        job_id: keyToJobId.get(node.key)!,
        phase: keyToPhase.get(node.key)!,
        ...(blockedBy && blockedBy.length > 0 ? { blocked_by: blockedBy } : {}),
      };
    }

    return {
      batch_id: batchId,
      idempotency_key: request.idempotency_key ?? null,
      jobs,
    };
  }

  /**
   * Reconstruct a batch result from existing jobs (for idempotency).
   */
  private async reconstructBatchResult(
    batchId: string,
    request: CreateBatchRequest,
  ): Promise<CreateBatchResponse> {
    const batchJobs = await this.db<Array<{ id: string; batch_key: string; phase: string }>>`
      SELECT id, batch_key, phase FROM jobs
      WHERE batch_id = ${batchId}
      ORDER BY created_at ASC
    `;

    const depsByKey = new Map<string, string[]>();
    for (const dep of request.dependencies) {
      depsByKey.set(dep.job, dep.depends_on);
    }

    const jobs: Record<string, { job_id: string; phase: string; blocked_by?: string[] }> = {};
    for (const bj of batchJobs) {
      if (!bj.batch_key) continue;
      const blockedBy = depsByKey.get(bj.batch_key);
      jobs[bj.batch_key] = {
        job_id: bj.id,
        phase: bj.phase,
        ...(blockedBy && blockedBy.length > 0 ? { blocked_by: blockedBy } : {}),
      };
    }

    const batch = await this.batchJobs.findById(batchId);

    return {
      batch_id: batchId,
      idempotency_key: batch?.idempotency_key ?? null,
      jobs,
    };
  }
}

// ============================================================================
// Batch Graph Helpers
// ============================================================================

/**
 * Detect whether a directed graph contains a cycle using iterative DFS.
 *
 * Each node can be in one of three states:
 *   0 = unvisited, 1 = in-progress (on current DFS stack), 2 = finished
 *
 * A back-edge to an in-progress node means a cycle exists.
 */
function hasCycle(graph: Map<string, string[]>): boolean {
  const state = new Map<string, number>(); // 0=unvisited, 1=in-progress, 2=done
  for (const key of graph.keys()) state.set(key, 0);

  for (const start of graph.keys()) {
    if (state.get(start) !== 0) continue;

    // Iterative DFS using an explicit stack
    const stack: Array<{ node: string; idx: number }> = [{ node: start, idx: 0 }];
    state.set(start, 1);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const neighbors = graph.get(top.node) ?? [];

      if (top.idx < neighbors.length) {
        const next = neighbors[top.idx];
        top.idx++;

        const nextState = state.get(next) ?? 0;
        if (nextState === 1) return true; // back-edge -> cycle
        if (nextState === 0) {
          state.set(next, 1);
          stack.push({ node: next, idx: 0 });
        }
      } else {
        state.set(top.node, 2);
        stack.pop();
      }
    }
  }

  return false;
}

/**
 * Topological sort of batch nodes.
 *
 * Produces an ordering where every parent appears before its children
 * and every dependency appears before the nodes that depend on it.
 * Uses Kahn's algorithm (BFS-based) for clarity.
 */
function topologicalSort(request: CreateBatchRequest): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // prerequisite -> dependents

  for (const node of request.nodes) {
    inDegree.set(node.key, 0);
    adjacency.set(node.key, []);
  }

  // Parent edges: parent must be created before child
  for (const node of request.nodes) {
    if (node.parent) {
      adjacency.get(node.parent)!.push(node.key);
      inDegree.set(node.key, (inDegree.get(node.key) ?? 0) + 1);
    }
  }

  // Dependency edges: depends_on must be created before job
  for (const dep of request.dependencies) {
    for (const dependsOn of dep.depends_on) {
      adjacency.get(dependsOn)!.push(dep.job);
      inDegree.set(dep.job, (inDegree.get(dep.job) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [key, degree] of inDegree) {
    if (degree === 0) queue.push(key);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return sorted;
}
