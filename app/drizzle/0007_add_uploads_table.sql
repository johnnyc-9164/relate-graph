CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id TEXT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
