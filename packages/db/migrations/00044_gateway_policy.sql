-- Add gateway discovery policy columns to agents table.
-- gateway_policy controls whether an agent is visible/routable from chat gateways.
-- gateway_clients optionally restricts which chat providers can reach the agent.

ALTER TABLE agents
  ADD COLUMN gateway_policy TEXT NOT NULL DEFAULT 'none'
    CHECK (gateway_policy IN ('none', 'discoverable', 'routable')),
  ADD COLUMN gateway_clients TEXT[] DEFAULT NULL;
  -- NULL = all clients, non-null = restricted to listed clients

-- Existing agents retain current behavior (routable by default)
UPDATE agents SET gateway_policy = 'routable' WHERE gateway_policy = 'none';
