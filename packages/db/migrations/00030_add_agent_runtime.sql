-- Add agent runtime tracking tables

CREATE TABLE IF NOT EXISTS agent_runtime_pods (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  pod_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  capacity INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, pod_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_pods_org_id
  ON agent_runtime_pods(org_id);

CREATE TABLE IF NOT EXISTS agent_placements (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  pod_name TEXT NOT NULL,
  shard_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, agent_id),
  CONSTRAINT fk_agent_placements_pod
    FOREIGN KEY (org_id, pod_name)
    REFERENCES agent_runtime_pods(org_id, pod_name)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_placements_org_id
  ON agent_placements(org_id);

CREATE INDEX IF NOT EXISTS idx_agent_placements_pod
  ON agent_placements(org_id, pod_name);
