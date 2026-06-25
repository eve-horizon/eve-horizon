-- Add agents/teams/threads primitives + agent config sync state

-- ============================================================================
-- PROJECT AGENT CONFIGS (agents.yaml / teams.yaml / chat.yaml)
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_agent_configs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agents_yaml TEXT NOT NULL,
  teams_yaml TEXT NOT NULL,
  chat_yaml TEXT NOT NULL,
  parsed_agents JSONB,
  parsed_teams JSONB,
  parsed_routes JSONB,
  git_sha TEXT,
  branch TEXT,
  git_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_agent_configs_project_id
  ON project_agent_configs(project_id);

-- ============================================================================
-- AGENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS agents (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT,
  role TEXT,
  workflow TEXT,
  harness_profile TEXT,
  policies_json JSONB DEFAULT '{}',
  access_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agents_project_id ON agents(project_id);

-- ============================================================================
-- TEAMS
-- ============================================================================

CREATE TABLE IF NOT EXISTS teams (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  lead_agent_id TEXT,
  dispatch_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_teams_project_id ON teams(project_id);

CREATE TABLE IF NOT EXISTS team_members (
  project_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, team_id, agent_id),
  CONSTRAINT fk_team_members_team
    FOREIGN KEY (project_id, team_id) REFERENCES teams(project_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_team_members_agent
    FOREIGN KEY (project_id, agent_id) REFERENCES agents(project_id, id) ON DELETE CASCADE
);

-- ============================================================================
-- THREADS + MESSAGES
-- ============================================================================

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  channel TEXT,
  peer TEXT,
  policy_json JSONB DEFAULT '{}',
  summary TEXT,
  workspace_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_project_key
  ON threads(project_id, key);

CREATE TABLE IF NOT EXISTS thread_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  body TEXT NOT NULL,
  job_id VARCHAR(64) REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id
  ON thread_messages(thread_id);

CREATE TABLE IF NOT EXISTS thread_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  subscriber_type TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(thread_id, subscriber_type, subscriber_id)
);

-- ============================================================================
-- SCHEDULES
-- ============================================================================

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cron TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedules_project_id ON schedules(project_id);

-- ============================================================================
-- AGENT STATE
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_state (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  summary TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, agent_id)
);
