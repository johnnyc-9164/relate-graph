CREATE TABLE agent_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  node_key TEXT,
  node_name TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  result TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
