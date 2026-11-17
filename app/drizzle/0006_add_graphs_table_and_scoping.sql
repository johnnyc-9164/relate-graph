CREATE TABLE graphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  api_base TEXT,
  status TEXT NOT NULL DEFAULT 'provisioning',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO graphs (name, slug, api_base, status, created_at) VALUES ('Main', 'main', 'http://127.0.0.1:7475', 'live', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--> statement-breakpoint
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE agent_requests ADD COLUMN graph_id INTEGER;
--> statement-breakpoint
ALTER TABLE agent_requests ADD COLUMN api_base TEXT;
