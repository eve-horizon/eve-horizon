import { Injectable, Inject } from '@nestjs/common';
import type { Db, Event } from '@eve/db';
import { projectManifestQueries, projectQueries } from '@eve/db';
import * as yaml from 'yaml';

/**
 * Trigger definition from manifest (pipeline or workflow)
 */
interface TriggerDefinition {
  github?: {
    event?: string;
    branch?: string;
    action?: string | string[]; // PR actions: opened, synchronize, reopened, closed
    base_branch?: string; // Filter by PR base branch (target branch)
  };
  slack?: {
    event?: string;
    channel?: string;
  };
  system?: {
    event?: string;
    pipeline?: string;
  };
  cron?: {
    schedule?: string;
  };
  app?: {
    event?: string;  // Shorthand for source=app events (e.g., question.answered)
  };
  app_link?: {
    alias?: string;
    type?: string;
  };
  event?: {
    source: string;  // Any event source (app, runner, chat, etc.)
    type?: string;   // Optional event type filter
  };
  manual?: boolean;
}

/**
 * Match result for a pipeline or workflow
 */
export interface TriggerMatch {
  type: 'pipeline' | 'workflow';
  name: string;
  projectId: string;
  envName?: string; // Set when triggered via environment-linked pipeline
}

/**
 * A single trigger evaluation record — whether a trigger matched and why not if it didn't.
 */
export interface TriggerEvaluation {
  type: 'pipeline' | 'workflow';
  name: string;
  matched: boolean;
  reason?: string;
}

/**
 * Full result from trigger matching: matches for dispatch + evaluations for observability.
 */
export interface TriggerMatchResult {
  matches: TriggerMatch[];
  evaluations: TriggerEvaluation[];
}

/**
 * Service to match events against pipeline and workflow triggers.
 *
 * Loads the manifest for an event's project, parses trigger definitions,
 * and determines which pipelines/workflows should be triggered by the event.
 */
@Injectable()
export class TriggerMatcherService {
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
  }

  /**
   * Find all pipelines and workflows that should trigger for the given event.
   *
   * Returns both the actionable matches and a full evaluation log for observability.
   *
   * @param event - The event to match against triggers
   * @returns Matches for dispatch and evaluations for metadata
   */
  async matchTriggersForEvent(event: Event): Promise<TriggerMatchResult> {
    const matches: TriggerMatch[] = [];
    const evaluations: TriggerEvaluation[] = [];

    // Load project manifest
    const manifest = await this.manifests.findLatestByProject(event.project_id);
    if (!manifest) {
      console.warn(
        `Event ${event.id} (type: ${event.type}) → no manifest synced for project ${event.project_id}. ` +
        `Run "eve project sync" to enable workflow triggers.`,
      );
      return { matches, evaluations };
    }

    // Parse manifest YAML
    const parsed = this.parseManifest(manifest.manifest_yaml);
    if (!parsed) {
      console.warn(
        `Event ${event.id} → manifest for project ${event.project_id} failed to parse`,
      );
      return { matches, evaluations };
    }

    // Check pipelines
    if (parsed.pipelines && typeof parsed.pipelines === 'object') {
      for (const [name, definition] of Object.entries(parsed.pipelines)) {
        const result = this.matchesTrigger(event, definition, name);
        evaluations.push({ type: 'pipeline', name, matched: result.matched, reason: result.reason });
        if (result.matched) {
          matches.push({
            type: 'pipeline',
            name,
            projectId: event.project_id,
          });
        }
      }
    }

    // Check workflows
    if (parsed.workflows && typeof parsed.workflows === 'object') {
      for (const [name, definition] of Object.entries(parsed.workflows)) {
        const result = this.matchesTrigger(event, definition, name);
        evaluations.push({ type: 'workflow', name, matched: result.matched, reason: result.reason });
        if (result.matched) {
          matches.push({
            type: 'workflow',
            name,
            projectId: event.project_id,
          });
        }
      }
    }

    // Check environment-linked pipelines (implicit github.push triggers)
    // When environments.<name>.pipeline references a pipeline and a github.push event
    // arrives on the project's default branch, trigger that pipeline automatically.
    if (
      event.source === 'github' &&
      event.type === 'github.push' &&
      parsed.environments &&
      typeof parsed.environments === 'object'
    ) {
      const matchedPipelineNames = new Set(
        matches.filter((m) => m.type === 'pipeline').map((m) => m.name),
      );

      const envResults = await this.matchEnvironmentLinkedPipelines(
        event,
        parsed.environments as Record<string, unknown>,
        parsed.pipelines as Record<string, unknown> | undefined,
        matchedPipelineNames,
      );
      matches.push(...envResults.matches);
      evaluations.push(...envResults.evaluations);
    }

    return { matches, evaluations };
  }

  /**
   * Parse manifest YAML safely
   */
  private parseManifest(manifestYaml: string): Record<string, unknown> | null {
    try {
      const parsed = yaml.parse(manifestYaml);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      console.error('Failed to parse manifest YAML:', error);
      return null;
    }
  }

  /**
   * Check if event matches a trigger definition.
   * Returns { matched, reason? } so callers can record why a trigger did not match.
   */
  private matchesTrigger(
    event: Event,
    definition: Record<string, unknown>,
    triggerName: string,
  ): { matched: boolean; reason?: string } {
    const trigger = definition.trigger;
    if (!trigger || typeof trigger !== 'object') {
      return { matched: false, reason: 'no_trigger' };
    }

    const triggerDef = trigger as TriggerDefinition;

    // GitHub trigger matching
    if (triggerDef.github) {
      const matched = this.matchesGitHubTrigger(event, triggerDef.github);
      return matched
        ? { matched: true }
        : { matched: false, reason: this.describeGitHubMismatch(event, triggerDef.github) };
    }

    // Slack trigger matching
    if (triggerDef.slack) {
      const matched = this.matchesSlackTrigger(event, triggerDef.slack);
      return matched
        ? { matched: true }
        : { matched: false, reason: event.source !== 'slack' ? 'source_mismatch' : 'type_mismatch' };
    }

    if (triggerDef.system) {
      const matched = this.matchesSystemTrigger(event, triggerDef.system, triggerName);
      return matched
        ? { matched: true }
        : { matched: false, reason: event.source !== 'system' ? 'source_mismatch' : 'type_mismatch' };
    }

    if (triggerDef.cron) {
      const matched = this.matchesCronTrigger(event, triggerDef.cron, triggerName);
      return matched
        ? { matched: true }
        : { matched: false, reason: event.source !== 'cron' ? 'source_mismatch' : 'type_mismatch' };
    }

    // App trigger — shorthand for source=app events
    if (triggerDef.app) {
      const matched = this.matchesAppTrigger(event, triggerDef.app);
      return matched
        ? { matched: true }
        : { matched: false, reason: event.source !== 'app' ? 'source_mismatch' : 'type_mismatch' };
    }

    if (triggerDef.app_link) {
      const matched = this.matchesAppLinkTrigger(event, triggerDef.app_link);
      return matched
        ? { matched: true }
        : { matched: false, reason: event.source !== 'app_link' ? 'source_mismatch' : 'type_or_alias_mismatch' };
    }

    // Generic event trigger — matches any source+type combination
    if (triggerDef.event) {
      const matched = this.matchesGenericEventTrigger(event, triggerDef.event);
      return matched
        ? { matched: true }
        : { matched: false, reason: event.source !== triggerDef.event.source ? 'source_mismatch' : 'type_mismatch' };
    }

    // Manual triggers don't match events
    if (triggerDef.manual) {
      return { matched: false, reason: 'manual_trigger' };
    }

    return { matched: false, reason: 'no_trigger' };
  }

  /**
   * Describe why a GitHub trigger didn't match — returns a concise reason string.
   */
  private describeGitHubMismatch(
    event: Event,
    githubTrigger: { event?: string; branch?: string; action?: string | string[]; base_branch?: string },
  ): string {
    if (event.source !== 'github') return 'source_mismatch';
    if (githubTrigger.event) {
      const expectedType = `github.${githubTrigger.event}`;
      if (event.type !== expectedType) return 'type_mismatch';
    }
    if (githubTrigger.action) {
      const payload = event.payload_json as { action?: string } | null;
      const eventAction = payload?.action;
      const allowedActions = Array.isArray(githubTrigger.action)
        ? githubTrigger.action
        : [githubTrigger.action];
      if (!eventAction || !allowedActions.includes(eventAction)) return 'action_mismatch';
    }
    if (githubTrigger.base_branch) {
      const payload = event.payload_json as { pull_request?: { base?: { ref?: string } } } | null;
      const baseBranch = payload?.pull_request?.base?.ref;
      if (!baseBranch || !this.matchesBranch(baseBranch, githubTrigger.base_branch)) return 'base_branch_mismatch';
    }
    if (githubTrigger.branch) {
      if (!event.ref_branch || !this.matchesBranch(event.ref_branch, githubTrigger.branch)) return 'branch_mismatch';
    }
    return 'unknown';
  }

  /**
   * Match GitHub event against trigger definition
   */
  private matchesGitHubTrigger(
    event: Event,
    githubTrigger: {
      event?: string;
      branch?: string;
      action?: string | string[];
      base_branch?: string;
    },
  ): boolean {
    // Check source is github
    if (event.source !== 'github') {
      return false;
    }

    // Check event type matches
    // Event type format: "github.push", trigger format: "push"
    if (githubTrigger.event) {
      const expectedType = `github.${githubTrigger.event}`;
      if (event.type !== expectedType) {
        return false;
      }
    }

    // Check PR action matches (for pull_request events)
    if (githubTrigger.action) {
      const payload = event.payload_json as { action?: string } | null;
      const eventAction = payload?.action;
      if (!eventAction) {
        return false;
      }
      const allowedActions = Array.isArray(githubTrigger.action)
        ? githubTrigger.action
        : [githubTrigger.action];
      if (!allowedActions.includes(eventAction)) {
        return false;
      }
    }

    // Check base branch matches (for pull_request events)
    if (githubTrigger.base_branch) {
      const payload = event.payload_json as {
        pull_request?: { base?: { ref?: string } };
      } | null;
      const baseBranch = payload?.pull_request?.base?.ref;
      if (!baseBranch) {
        return false;
      }
      if (!this.matchesBranch(baseBranch, githubTrigger.base_branch)) {
        return false;
      }
    }

    // Check branch matches (if specified)
    if (githubTrigger.branch) {
      if (!event.ref_branch) {
        return false;
      }
      return this.matchesBranch(event.ref_branch, githubTrigger.branch);
    }

    // If no branch filter specified, match any branch
    return true;
  }

  /**
   * Match Slack event against trigger definition
   */
  private matchesSlackTrigger(
    event: Event,
    slackTrigger: { event?: string; channel?: string },
  ): boolean {
    if (event.source !== 'slack') {
      return false;
    }

    if (slackTrigger.event) {
      const expectedType = `slack.${slackTrigger.event}`;
      if (event.type !== expectedType) {
        return false;
      }
    }

    if (slackTrigger.channel) {
      const channel = (event.payload_json as { event?: { channel?: string } } | null)?.event?.channel;
      if (!channel || channel !== slackTrigger.channel) {
        return false;
      }
    }

    return true;
  }

  /**
   * Match system event against trigger definition.
   *
   * @param triggerOwnerName - The name of the pipeline/workflow that owns this
   *   trigger.  Used to prevent recursive self-triggering (e.g. a remediation
   *   pipeline's own job failures re-triggering the same remediation pipeline).
   */
  private matchesSystemTrigger(
    event: Event,
    systemTrigger: { event?: string; pipeline?: string },
    triggerOwnerName?: string,
  ): boolean {
    if (event.source !== 'system') {
      return false;
    }

    if (systemTrigger.event) {
      const expectedType = `system.${systemTrigger.event}`;
      if (event.type !== expectedType) {
        return false;
      }
    }

    if (systemTrigger.pipeline) {
      const payload = event.payload_json as { pipeline_name?: string } | null;
      if (!payload?.pipeline_name || payload.pipeline_name !== systemTrigger.pipeline) {
        return false;
      }
    }

    // Anti-recursion guard: never let a pipeline trigger itself.
    // If the event originated from a pipeline run with the same name as the
    // pipeline that would be triggered, suppress the match.
    if (triggerOwnerName) {
      const payload = event.payload_json as { pipeline_name?: string } | null;
      if (payload?.pipeline_name === triggerOwnerName) {
        return false;
      }
    }

    return true;
  }

  private matchesCronTrigger(
    event: Event,
    cronTrigger: { schedule?: string },
    triggerName: string,
  ): boolean {
    if (event.source !== 'cron' || event.type !== 'cron.tick') {
      return false;
    }

    const payload = event.payload_json as { schedule?: string; trigger_name?: string } | null;
    if (cronTrigger.schedule) {
      if (!payload?.schedule || payload.schedule !== cronTrigger.schedule) {
        return false;
      }
    }

    if (!payload?.trigger_name || payload.trigger_name !== triggerName) {
      return false;
    }

    return true;
  }

  /**
   * Match app event trigger — shorthand for source=app events.
   *
   * Manifest format:
   *   trigger:
   *     app:
   *       event: question.answered   # matches event.type exactly
   */
  private matchesAppTrigger(
    event: Event,
    appTrigger: { event?: string },
  ): boolean {
    if (event.source !== 'app') {
      return false;
    }

    if (appTrigger.event && event.type !== appTrigger.event) {
      return false;
    }

    return true;
  }

  private matchesAppLinkTrigger(
    event: Event,
    appLinkTrigger: { alias?: string; type?: string },
  ): boolean {
    if (event.source !== 'app_link') {
      return false;
    }
    if (appLinkTrigger.type && event.type !== appLinkTrigger.type) {
      return false;
    }
    if (appLinkTrigger.alias) {
      const alias = (event.payload_json as { link_alias?: string } | null)?.link_alias;
      if (alias !== appLinkTrigger.alias) {
        return false;
      }
    }
    return true;
  }

  /**
   * Match generic event trigger — supports any source + optional type filter.
   *
   * Manifest format:
   *   trigger:
   *     event:
   *       source: app          # matches event.source
   *       type: doc.uploaded   # optional, matches event.type exactly
   */
  private matchesGenericEventTrigger(
    event: Event,
    eventTrigger: { source: string; type?: string },
  ): boolean {
    if (event.source !== eventTrigger.source) {
      return false;
    }

    if (eventTrigger.type && event.type !== eventTrigger.type) {
      return false;
    }

    return true;
  }

  /**
   * Match environment-linked pipelines against github.push events.
   *
   * When an environment references a pipeline (e.g. `environments.sandbox.pipeline: deploy`),
   * and the pipeline doesn't already have an explicit trigger that matched, this creates
   * an implicit trigger: the pipeline fires on github.push to the project's default branch.
   *
   * Environments can override the branch with `environments.<name>.branch`.
   * Environments with `auto_deploy: false` are skipped.
   */
  private async matchEnvironmentLinkedPipelines(
    event: Event,
    environments: Record<string, unknown>,
    pipelines: Record<string, unknown> | undefined,
    alreadyMatchedPipelines: Set<string>,
  ): Promise<{ matches: TriggerMatch[]; evaluations: TriggerEvaluation[] }> {
    // Look up the project's default branch
    const project = await this.projects.findById(event.project_id);
    if (!project) {
      return { matches: [], evaluations: [] };
    }

    const matches: TriggerMatch[] = [];
    const evaluations: TriggerEvaluation[] = [];

    for (const [envName, envDef] of Object.entries(environments)) {
      if (!envDef || typeof envDef !== 'object') {
        continue;
      }

      const env = envDef as Record<string, unknown>;
      const pipelineName = env.pipeline as string | undefined;
      if (!pipelineName) {
        continue;
      }

      const evalName = `${pipelineName}(env:${envName})`;

      // Skip if this pipeline already matched via an explicit trigger
      if (alreadyMatchedPipelines.has(pipelineName)) {
        evaluations.push({ type: 'pipeline', name: evalName, matched: false, reason: 'already_matched' });
        continue;
      }

      // Skip if the pipeline has an explicit trigger defined (user controls triggering)
      if (pipelines && typeof pipelines === 'object') {
        const pipelineDef = pipelines[pipelineName] as Record<string, unknown> | undefined;
        if (pipelineDef?.trigger) {
          evaluations.push({ type: 'pipeline', name: evalName, matched: false, reason: 'has_explicit_trigger' });
          continue;
        }
      }

      // Skip if auto_deploy is explicitly disabled
      if (env.auto_deploy === false) {
        evaluations.push({ type: 'pipeline', name: evalName, matched: false, reason: 'auto_deploy_disabled' });
        continue;
      }

      // Check branch: environment can override, otherwise use project default
      const triggerBranch = (env.branch as string | undefined) ?? project.branch;
      if (!event.ref_branch || event.ref_branch !== triggerBranch) {
        evaluations.push({ type: 'pipeline', name: evalName, matched: false, reason: 'branch_mismatch' });
        continue;
      }

      evaluations.push({ type: 'pipeline', name: evalName, matched: true });
      matches.push({
        type: 'pipeline',
        name: pipelineName,
        projectId: event.project_id,
        envName,
      });
    }

    return { matches, evaluations };
  }

  /**
   * Match branch name against pattern
   *
   * Supports:
   * - Exact match: "main" matches "main"
   * - Wildcard suffix: "feature/*" matches "feature/foo"
   * - Wildcard prefix: "*-prod" matches "staging-prod"
   */
  private matchesBranch(branch: string, pattern: string): boolean {
    // Exact match
    if (branch === pattern) {
      return true;
    }

    // Wildcard suffix
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      return branch.startsWith(prefix + '/');
    }

    // Wildcard prefix
    if (pattern.startsWith('*/')) {
      const suffix = pattern.slice(2);
      return branch.endsWith('/' + suffix);
    }

    // Wildcard prefix (no slash)
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1);
      return branch.endsWith(suffix);
    }

    return false;
  }
}
