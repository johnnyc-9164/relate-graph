CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT,
  reply_to_id INTEGER,
  created_at INTEGER NOT NULL
);
