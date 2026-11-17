// Relate Graph's own tables. The graph itself lives in the Relate engine
// and is read live through server actions — it is never copied here.
// `agent_requests` is the durable work-request log for agent dispatch
// (Command Center pattern): a request is filed as `requested`, the spawned
// agent moves it to `running`, and the outcome writes back as
// `done`/`failed` with a result summary.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Graphs: the Space manages several Relate graphs, each backed by its own
// Relate API base (e.g. Main at http://127.0.0.1:7475). A graph is created
// as `provisioning` (apiBase null) and flipped to `live` by updateGraph once
// its database is being served externally. Exactly one row is seeded by
// migration 0006: Main. The active graph selection is persisted in
// `app_settings` under the key `active_graph_id`.
export const graphs = sqliteTable("graphs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  apiBase: text("api_base"),
  status: text("status", { enum: ["provisioning", "live"] })
    .notNull()
    .default("provisioning"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Tiny key/value store for Space-level persisted settings (currently just
// the active graph id).
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const agentRequests = sqliteTable("agent_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category", {
    enum: [
      "import",
      "ontology",
      "categorizing",
      "normalization",
      "embeddings",
      "processing",
      "cleaning",
      "communities",
      "query",
      "dream",
    ],
  })
    .notNull()
    .default("query"),
  task: text("task").notNull(),
  // The graph this request was filed against (graphs.id). Null on requests
  // filed before multi-graph support — those belong to Main. `apiBase` is
  // the graph's Relate API base at dispatch time (null while provisioning),
  // so the executing agent can reach the right database from the record.
  graphId: integer("graph_id"),
  apiBase: text("api_base"),
  nodeKey: text("node_key"),
  nodeName: text("node_name"),
  status: text("status", {
    enum: ["requested", "running", "done", "failed"],
  })
    .notNull()
    .default("requested"),
  result: text("result"),
  taskId: text("task_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// File uploads: text-format source files the user drops into the Space for
// a graph (markdown, text, CSV, JSON/JSON-LD, Turtle/RDF, XML, Cypher).
// The full text is stored here; list actions return metadata only and the
// pipeline retrieves content through the getUpload action. `graphId` holds
// the graphs.id (as text) the upload belongs to, matching chat_messages;
// null predates scoping and belongs to Main.
export const uploads = sqliteTable("uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  graphId: text("graph_id"),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  contentText: text("content_text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Agent chat: a durable conversation thread between the user and the agent
// about what should be done in this space. User messages carry a status
// (`awaiting-agent` until an agent message answers them via `replyToId`);
// agent messages carry no status. `graphId` scopes the thread to a graph:
// it holds the graphs.id (as text) of the graph the message was written in.
// Messages with a null graphId predate multi-graph support and belong to
// Main.
export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  graphId: text("graph_id"),
  role: text("role", { enum: ["user", "agent"] }).notNull(),
  text: text("text").notNull(),
  status: text("status", { enum: ["awaiting-agent", "answered"] }),
  replyToId: integer("reply_to_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
