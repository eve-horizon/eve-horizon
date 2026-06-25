-- 00001_initial_schema.sql
-- Eve Horizon - Clean Slate Schema
-- Single consolidated migration for fresh installs

-- ============================================================================
-- MIGRATIONS TRACKING
-- ============================================================================

CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- ORGANIZATIONS
-- ============================================================================

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,                              -- org_xxx (TypeID)
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  deleted_at TIMESTAMPTZ                            -- soft delete
);

-- ============================================================================
-- PROJECTS
-- ============================================================================

CREATE TABLE projects (
  id TEXT PRIMARY KEY,                              -- proj_xxx (TypeID)
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  slug VARCHAR(8) NOT NULL,                         -- 4-8 chars, CamelCase, used in job IDs
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  deleted_at TIMESTAMPTZ,                           -- soft delete

  CONSTRAINT valid_slug CHECK (slug ~ '^[A-Za-z][A-Za-z0-9]{3,7}$')  -- 4-8 chars, CamelCase
);

CREATE INDEX idx_projects_org_id ON projects(org_id);
CREATE UNIQUE INDEX idx_projects_org_slug ON projects(org_id, slug);  -- unique per org

-- ============================================================================
-- JOBS
-- ============================================================================

CREATE TABLE jobs (
  -- Identity
  id              VARCHAR(64) PRIMARY KEY,          -- e.g., myproj-a3f2dd12 or myproj-a3f2dd12.1
  project_id      TEXT NOT NULL REFERENCES projects(id),
  parent_id       VARCHAR(64) REFERENCES jobs(id),  -- NULL for root jobs
  depth           SMALLINT NOT NULL DEFAULT 0,      -- 0-3, enforced via constraint

  -- Content
  title           VARCHAR(500) NOT NULL,
  description     TEXT NOT NULL,                       -- the actual work prompt
  issue_type      VARCHAR(50) NOT NULL DEFAULT 'task',  -- task, bug, feature, epic, chore
  labels          VARCHAR(100)[] DEFAULT '{}',

  -- Lifecycle
  phase           VARCHAR(20) NOT NULL DEFAULT 'ready',  -- ready = schedulable immediately
  -- Values: idea, backlog, ready, active, review, done, cancelled

  priority        SMALLINT NOT NULL DEFAULT 2,      -- 0-4 (P0=critical, P4=backlog)
  assignee        VARCHAR(255),                     -- agent or human identifier

  -- Review gate
  review_required VARCHAR(10) DEFAULT 'none',       -- none, human, agent
  review_status   VARCHAR(10),                      -- pending, approved, rejected
  reviewer        VARCHAR(255),

  -- Scheduling
  defer_until     TIMESTAMPTZ,                      -- hidden from ready until this time
  due_at          TIMESTAMPTZ,                      -- optional deadline

  -- Sync support
  content_hash    VARCHAR(64),                      -- SHA256 for drift detection

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,
  close_reason    TEXT,

  -- Constraints
  CONSTRAINT valid_phase CHECK (phase IN ('idea', 'backlog', 'ready', 'active', 'review', 'done', 'cancelled')),
  CONSTRAINT valid_priority CHECK (priority BETWEEN 0 AND 4),
  CONSTRAINT valid_depth CHECK (depth BETWEEN 0 AND 3),
  CONSTRAINT valid_review_required CHECK (review_required IN ('none', 'human', 'agent')),
  CONSTRAINT valid_review_status CHECK (review_status IS NULL OR review_status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX idx_jobs_project ON jobs(project_id);
CREATE INDEX idx_jobs_phase ON jobs(phase);
CREATE INDEX idx_jobs_parent ON jobs(parent_id);
CREATE INDEX idx_jobs_assignee ON jobs(assignee) WHERE assignee IS NOT NULL;
CREATE INDEX idx_jobs_ready ON jobs(project_id, phase, priority)
  WHERE phase IN ('ready', 'active') AND defer_until IS NULL;

-- ============================================================================
-- JOB RELATIONS (Dependencies)
-- ============================================================================

CREATE TABLE job_relations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          VARCHAR(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  related_job_id  VARCHAR(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  relation_type   VARCHAR(30) NOT NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_relation_type CHECK (relation_type IN (
    'blocks', 'conditional_blocks', 'waits_for',    -- blocking
    'related', 'discovered_from'                     -- non-blocking
  )),
  CONSTRAINT no_self_reference CHECK (job_id != related_job_id),
  UNIQUE(job_id, related_job_id, relation_type)
);

CREATE INDEX idx_relations_job ON job_relations(job_id);
CREATE INDEX idx_relations_related ON job_relations(related_job_id);
CREATE INDEX idx_relations_blocking ON job_relations(job_id, relation_type)
  WHERE relation_type IN ('blocks', 'conditional_blocks', 'waits_for');

-- ============================================================================
-- JOB ATTEMPTS (Execution Runs)
-- ============================================================================

CREATE TABLE job_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          VARCHAR(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_number  SMALLINT NOT NULL,                -- 1, 2, 3...

  status          VARCHAR(20) NOT NULL DEFAULT 'running',
  -- Values: pending, running, succeeded, failed, cancelled

  trigger_type    VARCHAR(20) NOT NULL DEFAULT 'manual',
  -- Values: manual, auto_retry, scheduled

  harness         VARCHAR(50),                      -- mclaude, zai, etc.
  agent_id        VARCHAR(255),                     -- agent/session identifier

  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,

  result_summary  TEXT,                             -- brief outcome description
  runtime_meta    JSONB DEFAULT '{}',               -- resource usage, logs pointer, etc.

  CONSTRAINT valid_attempt_status CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT valid_trigger CHECK (trigger_type IN ('manual', 'auto_retry', 'scheduled')),
  UNIQUE(job_id, attempt_number)
);

CREATE INDEX idx_attempts_job ON job_attempts(job_id);
CREATE INDEX idx_attempts_status ON job_attempts(status) WHERE status = 'running';

-- ============================================================================
-- AUDIT LOG
-- ============================================================================

CREATE TABLE audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     VARCHAR(30) NOT NULL,             -- job, job_relation, job_attempt, external_map
  entity_id       VARCHAR(64) NOT NULL,
  action          VARCHAR(20) NOT NULL,             -- created, updated, deleted
  actor           VARCHAR(255),                     -- who made the change
  actor_type      VARCHAR(20) DEFAULT 'user',       -- user, agent, system, sync
  changes         JSONB NOT NULL,
  context         JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_log(actor) WHERE actor IS NOT NULL;
CREATE INDEX idx_audit_time ON audit_log(created_at);

-- ============================================================================
-- EXTERNAL ITEM MAP (Sync State)
-- ============================================================================

CREATE TABLE external_item_map (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              VARCHAR(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider            VARCHAR(30) NOT NULL,         -- beads, jira, notion, linear
  external_id         VARCHAR(255) NOT NULL,
  external_key        VARCHAR(100),                 -- human-readable key (e.g., PROJ-123)
  external_url        TEXT,
  remote_updated_at   TIMESTAMPTZ,
  last_synced_at      TIMESTAMPTZ,
  sync_direction      VARCHAR(10) DEFAULT 'bidirectional',
  content_hash        VARCHAR(64),
  sync_error          TEXT,

  UNIQUE(provider, external_id)
);

CREATE INDEX idx_external_job ON external_item_map(job_id);
CREATE INDEX idx_external_provider ON external_item_map(provider);

-- ============================================================================
-- EXECUTION LOGS (for job attempt output)
-- ============================================================================

CREATE TABLE execution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL,                         -- Note: no FK since attempts use UUID now
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_execution_logs_attempt ON execution_logs(attempt_id, seq);

-- ============================================================================
-- BLOCKED JOBS VIEW
-- ============================================================================

CREATE VIEW blocked_jobs AS
SELECT DISTINCT j.id, j.title, j.phase
FROM jobs j
JOIN job_relations r ON r.job_id = j.id
JOIN jobs blocker ON blocker.id = r.related_job_id
WHERE j.phase IN ('ready', 'active')
  AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
  AND blocker.phase NOT IN ('done', 'cancelled');

-- ============================================================================
-- End of Schema
-- ============================================================================
