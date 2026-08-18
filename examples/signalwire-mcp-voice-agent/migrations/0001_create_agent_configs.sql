-- Per-business voice agent config, keyed by the SignalWire number the caller dialed.
-- SignalWireAdapter's resolveProps hook queries this table by `To` and forwards
-- the row into the agent DO as props (see src/index.ts).
CREATE TABLE agent_configs (
  phone_number TEXT PRIMARY KEY,
  system_prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  mcp_server_url TEXT,
  retail_mcp_server_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
