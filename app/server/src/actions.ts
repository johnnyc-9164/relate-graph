// Actions for Relate Graph.
//
// The Space manages several graphs, each backed by its own Relate engine
// (Neo4j-compatible) served over the Relate Query API v2 —
// POST <apiBase>/db/neo4j/query/v2, database `neo4j`, loopback-only
// (systemd units relate-api.service, relate-graph@<slug>). The seeded
// "Main" graph lives at http://127.0.0.1:7475. Every read and dispatch is
// scoped to the ACTIVE graph, a persisted server-side selection
// (app_settings.active_graph_id, default Main). There is deliberately no
// bundled or seeded copy of any graph: when a graph's API is unreachable
// the actions fail honestly and the UI shows that state, an empty store
// simply renders as an empty graph, and a graph whose database is still
// being provisioned reports its provisioning state instead of fake zeros.
//
// Agent dispatch follows the Command Center pattern: dispatchAgentTask
// files a durable work request (status `requested`), spawns a background
// Muse task, and the outcome writes back through updateAgentRequest —
// a request is never marked done at tap time.
//
// Storing a chat message, dispatch request, or new graph also drops a
// best-effort (:SpaceSignal) node into the Main graph (see writeSignal
// below) so an external hook can wake the agent in near-real time.
// Uploads (text files per graph) and the ontology preset picker live in
// this space's own tables / a server-side registry — see the uploads and
// ontology sections below.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";
import { asc, desc, eq, isNull, or } from "drizzle-orm";
import * as schema from "./schema";

const FETCH_TIMEOUT_MS = 6000;
const ACTIVE_GRAPH_KEY = "active_graph_id";

type Json = string | number | boolean | null;

interface RelateNode {
  elementId?: string;
  labels?: string[];
  properties?: Record<string, unknown>;
}

interface RelateResponse {
  data?: { fields: string[]; values: unknown[][] };
  message?: string;
}

function cleanProps(props: Record<string, unknown> | undefined): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null
    ) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v
        .filter(
          (x): x is string | number | boolean =>
            typeof x === "string" || typeof x === "number" || typeof x === "boolean",
        )
        .join(", ");
    } else if (v !== undefined) {
      out[k] = String(v);
    }
  }
  return out;
}

function queryUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}/db/neo4j/query/v2`;
}

async function relateQuery(
  apiBase: string,
  statement: string,
  parameters: Record<string, unknown> = {},
): Promise<{ fields: string[]; values: unknown[][] }> {
  const url = queryUrl(apiBase);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statement, parameters }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `Relate API unreachable at ${url} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const body = (await res.json()) as RelateResponse;
  if (!res.ok || !body.data) {
    const msg =
      typeof body.message === "string"
        ? body.message
        : `Relate API returned HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body.data;
}

// ---------- space signals (event-trigger backbone) ----------
//
// After a chat message, dispatch request, or new graph is stored, the
// action also drops one (:SpaceSignal) node into the MAIN graph — always
// Main, at its fixed API base, regardless of which graph the record
// targets: Main is the signal bus because a brand-new graph has no API
// yet. An external hook polls Main for unconsumed signals and wakes the
// agent. The write is strictly best-effort: any failure (API down,
// timeout, non-2xx) is swallowed and never fails the storing action.

const MAIN_SIGNAL_API_BASE = "http://127.0.0.1:7475";
const SIGNAL_TIMEOUT_MS = 2000;

async function writeSignal(
  kind: "chat" | "dispatch" | "provision",
  refId: number,
  graphSlug: string,
): Promise<void> {
  try {
    await fetch(queryUrl(MAIN_SIGNAL_API_BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        statement:
          "CREATE (s:SpaceSignal {kind: $kind, refId: $refId, graphSlug: $graphSlug, at: $at, consumed: false})",
        parameters: {
          kind,
          refId: String(refId),
          graphSlug,
          at: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
    });
  } catch {
    // Best-effort by design — a missing signal never fails the action.
  }
}

// ---------- graphs registry ----------

const graphStatus = z.enum(["provisioning", "live"]);

const graphRecordSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  apiBase: z.string().nullable(),
  status: graphStatus,
  createdAt: z.string(),
});

type GraphRow = typeof schema.graphs.$inferSelect;
type GraphRecord = z.infer<typeof graphRecordSchema>;

function toGraphRecord(row: GraphRow): GraphRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    apiBase: row.apiBase,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

async function listGraphRows(ctx: Ctx): Promise<GraphRow[]> {
  const db = ctx.db<typeof schema>();
  return db.select().from(schema.graphs).orderBy(asc(schema.graphs.id));
}

async function mainGraphRow(ctx: Ctx): Promise<GraphRow> {
  const rows = await listGraphRows(ctx);
  const main = rows.find((g) => g.slug === "main") ?? rows[0];
  if (!main) throw new Error("No graphs are registered in this space");
  return main;
}

// The persisted active graph. Defaults to Main when nothing (valid) is set.
async function activeGraphRow(ctx: Ctx): Promise<GraphRow> {
  const db = ctx.db<typeof schema>();
  const rows = await listGraphRows(ctx);
  const main = rows.find((g) => g.slug === "main") ?? rows[0];
  if (!main) throw new Error("No graphs are registered in this space");
  const setting = await db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, ACTIVE_GRAPH_KEY))
    .limit(1);
  const raw = setting[0]?.value;
  const activeId = raw != null ? Number(raw) : NaN;
  return rows.find((g) => g.id === activeId) ?? main;
}

// One graph by id; throws when no graph carries that id.
async function graphRowById(ctx: Ctx, graphId: number): Promise<GraphRow> {
  const rows = await listGraphRows(ctx);
  const row = rows.find((g) => g.id === graphId);
  if (!row) throw new Error(`No graph with id ${graphId}`);
  return row;
}

async function persistActiveGraph(ctx: Ctx, graphId: number): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.appSettings)
    .values({ key: ACTIVE_GRAPH_KEY, value: String(graphId) })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: String(graphId) },
    });
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "graph";
}

// Live node/edge counts for one graph's own API; null when unreachable.
// SpaceSignal nodes are the signal-bus infrastructure living in Main, not
// graph content — getGraph skips them (they carry no key/slug), so the
// counts exclude them too and the picker, status, and canvas agree.
async function graphCounts(
  apiBase: string,
): Promise<{ nodeCount: number; edgeCount: number } | null> {
  try {
    const n = await relateQuery(
      apiBase,
      "MATCH (n) WHERE NOT n:SpaceSignal RETURN count(n) AS c",
    );
    const e = await relateQuery(apiBase, "MATCH ()-[r]->() RETURN count(r) AS c");
    const nc = n.values[0]?.[0];
    const ec = e.values[0]?.[0];
    if (typeof nc !== "number" || typeof ec !== "number") return null;
    return { nodeCount: nc, edgeCount: ec };
  } catch {
    return null;
  }
}

// ---------- shared graph shapes ----------

const propValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const graphNodeSchema = z.object({
  key: z.string(),
  label: z.string(),
  name: z.string(),
  degree: z.number(),
  props: z.record(z.string(), propValue),
});
const graphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.string(),
  props: z.record(z.string(), propValue),
});

type GraphNode = z.infer<typeof graphNodeSchema>;
type GraphEdge = z.infer<typeof graphEdgeSchema>;

function withDegrees(nodes: Omit<GraphNode, "degree">[], edges: GraphEdge[]): GraphNode[] {
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  return nodes.map((n) => ({ ...n, degree: deg.get(n.key) ?? 0 }));
}

// ---------- bitemporal filtering ----------
//
// Nodes and relationships may carry ISO-8601 string properties validFrom /
// validTo (valid time) and recordedAt / retiredAt (transaction time). A
// missing property means unbounded. Filtering compares the stored ISO
// strings lexicographically against $asOf — the convention guarantees
// zero-padded ISO strings, so string comparison is correct.

type TemporalMode = "live" | "valid" | "recorded";

const TEMPORAL_PROPS: Record<
  Exclude<TemporalMode, "live">,
  { from: string; to: string }
> = {
  valid: { from: "validFrom", to: "validTo" },
  recorded: { from: "recordedAt", to: "retiredAt" },
};

function temporalClause(mode: TemporalMode, alias: string): string {
  if (mode === "live") return "";
  const { from, to } = TEMPORAL_PROPS[mode];
  return `(${alias}.${from} IS NULL OR ${alias}.${from} <= $asOf) AND (${alias}.${to} IS NULL OR $asOf < ${alias}.${to})`;
}

const temporalCoverageSchema = z.object({
  nodesWithValidTime: z.number(),
  nodesWithTransactionTime: z.number(),
  edgesWithValidTime: z.number(),
  edgesWithTransactionTime: z.number(),
});

type TemporalCoverage = z.infer<typeof temporalCoverageSchema>;

const ZERO_COVERAGE: TemporalCoverage = {
  nodesWithValidTime: 0,
  nodesWithTransactionTime: 0,
  edgesWithValidTime: 0,
  edgesWithTransactionTime: 0,
};

// Coverage is always computed over the whole graph, unfiltered, so the UI
// can state honestly how much bitemporal data exists regardless of the
// current as-of view.
async function fetchTemporalCoverage(apiBase: string): Promise<TemporalCoverage> {
  const count = async (statement: string): Promise<number> => {
    const d = await relateQuery(apiBase, statement);
    const v = d.values[0]?.[0];
    return typeof v === "number" ? v : 0;
  };
  const [nodesWithValidTime, nodesWithTransactionTime, edgesWithValidTime, edgesWithTransactionTime] =
    await Promise.all([
      count(
        "MATCH (n) WHERE n.validFrom IS NOT NULL OR n.validTo IS NOT NULL RETURN count(n) AS c",
      ),
      count(
        "MATCH (n) WHERE n.recordedAt IS NOT NULL OR n.retiredAt IS NOT NULL RETURN count(n) AS c",
      ),
      count(
        "MATCH ()-[r]->() WHERE r.validFrom IS NOT NULL OR r.validTo IS NOT NULL RETURN count(r) AS c",
      ),
      count(
        "MATCH ()-[r]->() WHERE r.recordedAt IS NOT NULL OR r.retiredAt IS NOT NULL RETURN count(r) AS c",
      ),
    ]);
  return {
    nodesWithValidTime,
    nodesWithTransactionTime,
    edgesWithValidTime,
    edgesWithTransactionTime,
  };
}

async function fetchLiveGraph(
  apiBase: string,
  mode: TemporalMode = "live",
  asOf: string | null = null,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const filtering = mode !== "live" && asOf != null && asOf.length > 0;
  const params: Record<string, unknown> = filtering ? { asOf } : {};
  const nodeWhere = filtering ? ` WHERE ${temporalClause(mode, "n")}` : "";
  // An edge is returned only if it passes the filter itself AND both of
  // its endpoint nodes pass.
  const edgeWhere = filtering
    ? ` WHERE ${temporalClause(mode, "a")} AND ${temporalClause(mode, "b")} AND ${temporalClause(mode, "r")}`
    : "";
  // Node identity is the `key` property when present, falling back to
  // `slug` — pipeline-imported nodes carry slug, not key, and must still
  // render. Nodes with a real key are unaffected.
  const nodeData = await relateQuery(
    apiBase,
    `MATCH (n)${nodeWhere} RETURN coalesce(n.key, n.slug) AS key, labels(n) AS labels, n.name AS name, properties(n) AS props`,
    params,
  );
  const nodesRaw: Omit<GraphNode, "degree">[] = [];
  for (const row of nodeData.values) {
    const [key, labels, name, props] = row as [
      string | null,
      string[] | null,
      string | null,
      Record<string, unknown> | null,
    ];
    if (!key) continue;
    const cleaned = cleanProps(props ?? undefined);
    // getGraph-only payload trim (D-26): the canvas and detail panel never
    // render the raw vectors, and on a large graph they dominate the
    // response size. Drop the vector-valued props here — inside
    // fetchLiveGraph, which only getGraph calls — so getNode keeps
    // returning the full properties (including the complete embedding)
    // through the shared cleanProps path.
    delete cleaned["embedding"];
    delete cleaned["fact_embedding"];
    nodesRaw.push({
      key,
      label: labels?.[0] ?? "Node",
      name: name ?? (typeof cleaned["name"] === "string" ? cleaned["name"] : key),
      props: cleaned,
    });
  }
  const edgeData = await relateQuery(
    apiBase,
    `MATCH (a)-[r]->(b)${edgeWhere} RETURN coalesce(a.key, a.slug) AS fromKey, coalesce(b.key, b.slug) AS toKey, type(r) AS type, properties(r) AS props`,
    params,
  );
  const edges: GraphEdge[] = [];
  for (const row of edgeData.values) {
    const [from, to, type, props] = row as [
      string | null,
      string | null,
      string | null,
      Record<string, unknown> | null,
    ];
    if (!from || !to || !type) continue;
    edges.push({ from, to, type, props: cleanProps(props ?? undefined) });
  }
  return { nodes: withDegrees(nodesRaw, edges), edges };
}

// ---------- filter types (ontology-driven type UI) ----------
//
// The filter chips, legend, and canvas colors are driven by the graph's
// own STAMPED ONTOLOGY: the (:OntologyClass) nodes living in the graph.
// One filter type per distinct class NAME (duplicate class nodes from
// multiple stamps collapse into one type), carrying that label's live
// node count from the label census. Infrastructure labels that exist as
// nodes but are not stamped classes (Ontology, OntologyClass,
// OntologyProperty, and SpaceSignal when it is not itself a stamped
// class) are appended as kind "system" so every visible node stays
// filterable; any remaining census label not covered above is appended
// as kind "census". A graph with NO stamped ontology falls back to the
// raw label census (kind "census", system labels still marked "system").

const filterTypeSchema = z.object({
  name: z.string(),
  count: z.number(),
  color: z.string(),
  kind: z.enum(["ontology", "system", "census"]),
});

type FilterType = z.infer<typeof filterTypeSchema>;

const SYSTEM_LABELS = ["Ontology", "OntologyClass", "OntologyProperty", "SpaceSignal"];

// Fixed palette. Colors are assigned deterministically by type name: a
// stable FNV-1a hash of the name picks the starting slot and collisions
// probe forward in alphabetical name order, so the same type gets the
// same color across graphs and reloads. Person is pinned to the first
// slot — its long-standing orange.
const TYPE_PALETTE = [
  "#f5b04c",
  "#2dd4bf",
  "#58a6ff",
  "#3fb950",
  "#ff7b72",
  "#bc8cff",
  "#e3b341",
  "#f778ba",
  "#79c0ff",
  "#d2a8ff",
  "#56d4dd",
  "#a371f7",
  "#7ee787",
  "#ff9ecf",
  "#db61a2",
  "#4ac3ff",
];
const PINNED_TYPE_COLORS: Record<string, string> = { Person: "#f5b04c" };

function hashTypeName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function assignTypeColors(names: string[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  // Alphabetical processing order keeps the assignment independent of
  // display order and of which graph the types came from.
  for (const name of [...names].sort()) {
    const pinned = PINNED_TYPE_COLORS[name];
    if (pinned) {
      out.set(name, pinned);
      used.add(pinned);
      continue;
    }
    let idx = hashTypeName(name) % TYPE_PALETTE.length;
    let color = TYPE_PALETTE[idx] ?? TYPE_PALETTE[0]!;
    let probes = 0;
    while (used.has(color) && probes < TYPE_PALETTE.length) {
      idx = (idx + 1) % TYPE_PALETTE.length;
      color = TYPE_PALETTE[idx] ?? TYPE_PALETTE[0]!;
      probes += 1;
    }
    out.set(name, color);
    used.add(color);
  }
  return out;
}

async function fetchFilterTypes(
  apiBase: string,
  fallbackNodes: GraphNode[],
): Promise<FilterType[]> {
  // Live label census over the whole graph (primary label per node,
  // matching the label the UI renders for that node).
  const census = new Map<string, number>();
  try {
    const censusData = await relateQuery(
      apiBase,
      "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS c",
    );
    for (const row of censusData.values) {
      const [label, c] = row as [string | null, number | null];
      if (typeof label === "string" && typeof c === "number") {
        census.set(label, c);
      }
    }
  } catch {
    for (const n of fallbackNodes) {
      census.set(n.label, (census.get(n.label) ?? 0) + 1);
    }
  }

  // Stamped ontology classes, deduped by name. A failed query (or a
  // graph with no stamp) leaves the class list empty and the census
  // fallback below takes over.
  const classOrder = new Map<string, number | null>();
  try {
    const classData = await relateQuery(
      apiBase,
      "MATCH (c:OntologyClass) RETURN c.name AS name, c.graphLabel AS graphLabel, c.order AS ord",
    );
    for (const row of classData.values) {
      const [rawName, graphLabel, ord] = row as [
        string | null,
        string | null,
        number | null,
      ];
      const name =
        typeof rawName === "string" && rawName.length > 0
          ? rawName
          : typeof graphLabel === "string" && graphLabel.length > 0
            ? graphLabel
            : null;
      if (!name) continue;
      const order = typeof ord === "number" ? ord : null;
      const prev = classOrder.get(name);
      if (prev === undefined || (order !== null && (prev === null || order < prev))) {
        classOrder.set(name, order);
      }
    }
  } catch {
    classOrder.clear();
  }

  const entries: { name: string; count: number; kind: FilterType["kind"] }[] = [];
  if (classOrder.size > 0) {
    // Order by the stored order property when any class carries one;
    // otherwise alphabetically.
    const anyOrder = [...classOrder.values()].some((o) => o !== null);
    const classNames = [...classOrder.keys()].sort((a, b) => {
      if (anyOrder) {
        const oa = classOrder.get(a) ?? Number.POSITIVE_INFINITY;
        const ob = classOrder.get(b) ?? Number.POSITIVE_INFINITY;
        if (oa !== ob) return oa - ob;
      }
      return a.localeCompare(b);
    });
    const covered = new Set<string>(classNames);
    for (const name of classNames) {
      entries.push({ name, count: census.get(name) ?? 0, kind: "ontology" });
    }
    for (const sys of SYSTEM_LABELS) {
      if (!covered.has(sys) && census.has(sys)) {
        entries.push({ name: sys, count: census.get(sys) ?? 0, kind: "system" });
        covered.add(sys);
      }
    }
    const rest = [...census.keys()]
      .filter((l) => !covered.has(l))
      .sort();
    for (const name of rest) {
      entries.push({ name, count: census.get(name) ?? 0, kind: "census" });
    }
  } else {
    const all = [...census.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    for (const [name, count] of all) {
      entries.push({
        name,
        count,
        kind: SYSTEM_LABELS.includes(name) ? "system" : "census",
      });
    }
  }

  const colors = assignTypeColors(entries.map((e) => e.name));
  return entries.map((e) => ({
    ...e,
    color: colors.get(e.name) ?? TYPE_PALETTE[0]!,
  }));
}

const graphResponse = z.object({
  fetchedAt: z.string(),
  nodeCount: z.number(),
  edgeCount: z.number(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  graphId: z.number(),
  graphName: z.string(),
  graphStatus: graphStatus,
  temporalCoverage: temporalCoverageSchema,
  filterTypes: z.array(filterTypeSchema),
});

const neighborSchema = z.object({
  key: z.string(),
  label: z.string(),
  name: z.string(),
  direction: z.enum(["out", "in"]),
  edgeType: z.string(),
  edgeProps: z.record(z.string(), propValue),
});

const nodeDetailResponse = z.object({
  found: z.boolean(),
  node: graphNodeSchema.nullable(),
  neighbors: z.array(neighborSchema),
});

const WRITE_KEYWORDS =
  /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD\s+CSV|FOREACH)\b/i;

const requestStatus = z.enum(["requested", "running", "done", "failed"]);

const agentCategory = z.enum([
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
]);

const agentRequestSchema = z.object({
  id: z.number(),
  category: agentCategory,
  task: z.string(),
  graphId: z.number().nullable(),
  apiBase: z.string().nullable(),
  nodeKey: z.string().nullable(),
  nodeName: z.string().nullable(),
  status: requestStatus,
  result: z.string().nullable(),
  taskId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type AgentRequestRow = typeof schema.agentRequests.$inferSelect;

function toAgentRequest(
  row: AgentRequestRow,
  mainId: number,
): z.infer<typeof agentRequestSchema> {
  return {
    id: row.id,
    category: row.category,
    task: row.task,
    // Requests filed before multi-graph support carry no graphId — they
    // belong to Main.
    graphId: row.graphId ?? mainId,
    apiBase: row.apiBase,
    nodeKey: row.nodeKey,
    nodeName: row.nodeName,
    status: row.status,
    result: row.result,
    taskId: row.taskId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------- agent chat ----------

const chatMessageSchema = z.object({
  id: z.number(),
  graphId: z.string().nullable(),
  role: z.enum(["user", "agent"]),
  text: z.string(),
  status: z.enum(["awaiting-agent", "answered"]).nullable(),
  replyToId: z.number().nullable(),
  createdAt: z.string(),
});

type ChatMessageRow = typeof schema.chatMessages.$inferSelect;

function toChatMessage(row: ChatMessageRow): z.infer<typeof chatMessageSchema> {
  return {
    id: row.id,
    graphId: row.graphId,
    role: row.role,
    text: row.text,
    status: row.status,
    replyToId: row.replyToId,
    createdAt: row.createdAt.toISOString(),
  };
}

const graphWithCountsSchema = graphRecordSchema.extend({
  nodeCount: z.number().nullable(),
  edgeCount: z.number().nullable(),
  active: z.boolean(),
});

// The one dispatch code path: file the durable work request against a
// graph (the ACTIVE graph, or `input.graphId` when a caller targets a
// specific one), drop a "dispatch" signal into Main, spawn the background
// agent task, and record the spawn outcome on the request. Used by the
// dispatchAgentTask action, by applyOntologyPreset, and by
// resolveReviewItem.
async function fileAgentRequest(
  ctx: Ctx,
  input: {
    category: z.infer<typeof agentCategory>;
    task: string;
    nodeKey: string | null;
    nodeName: string | null;
    graphId?: number | null;
  },
): Promise<z.infer<typeof agentRequestSchema>> {
  const db = ctx.db<typeof schema>();
  const graph =
    input.graphId != null
      ? await graphRowById(ctx, input.graphId)
      : await activeGraphRow(ctx);
  const main = await mainGraphRow(ctx);
  const inserted = await db
    .insert(schema.agentRequests)
    .values({
      category: input.category,
      task: input.task,
      graphId: graph.id,
      apiBase: graph.apiBase,
      nodeKey: input.nodeKey,
      nodeName: input.nodeName,
      status: "requested",
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("fileAgentRequest: insert returned no rows");

  await writeSignal("dispatch", row.id, graph.slug);

  const apiLine = graph.apiBase
    ? `The store is served at POST ${queryUrl(graph.apiBase)} with body {"statement": "<Cypher>", "parameters": {}} — read and write through that API as the task requires.`
    : `This graph is still provisioning and has no Relate API yet — if the task needs the store, report the request failed with that reason.`;
  const message = [
    `Data-pipeline work request #${row.id} from the Relate Graph space (category: ${input.category}, graph: "${graph.name}", graphId: ${graph.id}).`,
    "",
    `Task: ${input.task}`,
    "",
    input.nodeKey
      ? `Context: this request concerns the graph node "${input.nodeName ?? input.nodeKey}" (key "${input.nodeKey}") in the "${graph.name}" Relate store. ${apiLine}`
      : `Context: this request concerns the "${graph.name}" Relate store behind the Relate Graph space. ${apiLine}`,
    "",
    `When you start working, report status "running" for request id ${row.id}. When finished, report status "done" with a concise result summary — including before/after node and edge counts when the task changed the graph — or "failed" with the reason, for request id ${row.id}.`,
  ].join("\n");

  const spawned = await ctx.agent.spawnTask(message, {
    expectsAction: "updateAgentRequest",
    dedupeKey: `relate-graph-request-${row.id}`,
  });

  let finalRow = row;
  if (spawned.ok) {
    const updated = await db
      .update(schema.agentRequests)
      .set({ taskId: spawned.taskId, updatedAt: new Date() })
      .where(eq(schema.agentRequests.id, row.id))
      .returning();
    finalRow = updated[0] ?? row;
  } else {
    const updated = await db
      .update(schema.agentRequests)
      .set({
        status: "failed",
        result: `Agent task could not be started: ${spawned.error}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentRequests.id, row.id))
      .returning();
    finalRow = updated[0] ?? row;
  }
  ctx.invalidateQueries();
  return toAgentRequest(finalRow, main.id);
}

// ---------- uploads ----------

const uploadMetaSchema = z.object({
  id: z.number(),
  graphId: z.string().nullable(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number(),
  createdAt: z.string(),
});

const uploadFullSchema = uploadMetaSchema.extend({
  contentText: z.string(),
});

type UploadRow = typeof schema.uploads.$inferSelect;

function toUploadMeta(row: UploadRow): z.infer<typeof uploadMetaSchema> {
  return {
    id: row.id,
    graphId: row.graphId,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

const UPLOAD_MAX_CHARS = 2_000_000;
const UPLOAD_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "csv",
  "json",
  "jsonld",
  "ttl",
  "rdf",
  "xml",
  "cypher",
]);

function isTextMime(mime: string): boolean {
  const m = mime.trim().toLowerCase();
  if (m === "") return true; // no declared type — the extension check governs
  if (m.startsWith("text/")) return true;
  return (
    m === "application/json" ||
    m === "application/ld+json" ||
    m === "application/rdf+xml" ||
    m === "application/xml" ||
    m.endsWith("+json") ||
    m.endsWith("+xml")
  );
}

// ---------- ontology presets ----------
//
// The packaged ontology files shipped with the custom.relate connector.
// `available` is checked against the filesystem at call time when the
// runtime allows it; when the check itself cannot run it stays null
// (unknown) — never guessed.

const ONTOLOGY_PRESETS = [
  {
    id: "schema-org",
    name: "schema.org",
    file: "/home/hatch/workspace/custom-connectors/custom.relate/ontologies/schema-org.jsonld",
    blurb:
      "General-purpose vocabulary for people, organizations, places, events and things.",
  },
  {
    id: "foaf",
    name: "FOAF",
    file: "/home/hatch/workspace/custom-connectors/custom.relate/ontologies/foaf.rdf",
    blurb: "Friend of a Friend — people, agents and their relationships.",
  },
  {
    id: "prov-o",
    name: "PROV-O",
    file: "/home/hatch/workspace/custom-connectors/custom.relate/ontologies/prov-o.ttl",
    blurb:
      "W3C provenance ontology — entities, activities, agents and derivation.",
  },
  {
    id: "owl-time",
    name: "OWL-Time",
    file: "/home/hatch/workspace/custom-connectors/custom.relate/ontologies/owl-time.ttl",
    blurb:
      "W3C ontology of temporal intervals and instants — valid-time modeling.",
  },
  {
    id: "skos",
    name: "SKOS",
    file: "/home/hatch/workspace/custom-connectors/custom.relate/ontologies/skos.rdf",
    blurb: "Concept schemes, taxonomies and controlled vocabularies.",
  },
  {
    id: "dcterms",
    name: "Dublin Core Terms",
    file: "/home/hatch/workspace/custom-connectors/custom.relate/ontologies/dcterms.rdf",
    blurb: "Metadata terms for documents and resources.",
  },
  {
    id: "org",
    name: "W3C ORG",
    file: "/home/hatch/workspace/custom-connectors/custom.relate/ontologies/org.ttl",
    blurb:
      "W3C organization ontology — organizations, roles, memberships and sites.",
  },
  {
    id: "house-memory-graph",
    name: "House — Memory Graph",
    file: "/home/hatch/workspace/custom-connectors/custom.relate/ontologies/house-memory-graph.ttl",
    blurb:
      "House ontology for Johnny's memory/people graph — Person, Group and SourceDocument conventions.",
  },
] as const;

const ontologyPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  file: z.string(),
  blurb: z.string(),
  available: z.boolean().nullable(),
});

// True/false when the runtime can stat the file (via the privileged
// fileExists helper); null when the check itself cannot run — the caller
// then reports availability as unknown rather than guessing.
async function presetFileAvailable(
  ctx: Ctx,
  path: string,
): Promise<boolean | null> {
  try {
    const res = await ctx.executePrivileged(privileged.fileExists, { path });
    return res.exists;
  } catch {
    return null;
  }
}

// ---------- governance: decision ledger + review queue ----------
//
// Decisions and review items live as nodes INSIDE each graph —
// (:Decision) and (:ReviewItem) — written by the relate CLI and read
// here through the target graph's own Relate API, like every other read.
// Property shapes mirror the CLI exactly:
// - Decision: slug (the id, decision-NNNN), kind, subject, detail (a JSON
//   STRING), at (ISO timestamp), revertedAt (optional).
// - ReviewItem: slug (the id, review-NNNN), kind, subject (a JSON
//   STRING), choices (a JSON STRING holding an array — entries are
//   strings, or objects carrying one of id/choice/value plus an optional
//   label), status ("open"/"resolved"), at; after the CLI resolves an
//   item it also sets resolution and resolvedAt.

const decisionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  subject: z.string(),
  detail: z.unknown(),
  at: z.string(),
  revertedAt: z.string().nullable(),
});

const reviewChoiceSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
]);

const reviewItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  subject: z.unknown(),
  choices: z.array(reviewChoiceSchema),
  status: z.string(),
  at: z.string(),
  resolution: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

type DecisionEntry = z.infer<typeof decisionSchema>;
type ReviewItemEntry = z.infer<typeof reviewItemSchema>;

const resolveReviewItemResponse = z.object({
  ok: z.literal(true),
  requestId: z.number(),
  request: agentRequestSchema,
});

// detail/subject/choices are stored as JSON strings. Parse when the
// value parses; when it does not, the raw string is returned as-is.
function parseStoredJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

// Ordering tie-break for equal timestamps: the numeric suffix of the
// decision-NNNN / review-NNNN id, i.e. filing order.
function idSequence(id: string): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The graph a governance read or resolution targets: the given graphId,
// or the active graph when none is given.
async function governanceGraph(
  ctx: Ctx,
  graphId: number | null,
): Promise<GraphRow> {
  return graphId != null ? graphRowById(ctx, graphId) : activeGraphRow(ctx);
}

// A governance read needs a serving API: a provisioning graph fails
// honestly here, and an unreachable API surfaces relateQuery's error.
function governanceApiBase(graph: GraphRow): string {
  if (graph.status !== "live" || !graph.apiBase) {
    throw new Error(
      `Graph "${graph.name}" is still provisioning — its database is being started, so there is nothing to read yet.`,
    );
  }
  return graph.apiBase;
}

export const Actions = {
  listGraphs: defineAction({
    description:
      "Lists every graph registered in this space with its status, marking the active one. Live graphs also carry their live node/edge counts fetched from that graph's own Relate API (null when unreachable); provisioning graphs report no counts.",
    request: z.object({}),
    response: z.object({
      graphs: z.array(graphWithCountsSchema),
      activeGraphId: z.number(),
    }),
    async handler(ctx): Promise<{
      graphs: z.infer<typeof graphWithCountsSchema>[];
      activeGraphId: number;
    }> {
      const rows = await listGraphRows(ctx);
      const active = await activeGraphRow(ctx);
      const graphs = await Promise.all(
        rows.map(async (row) => {
          const counts =
            row.status === "live" && row.apiBase
              ? await graphCounts(row.apiBase)
              : null;
          return {
            ...toGraphRecord(row),
            nodeCount: counts?.nodeCount ?? null,
            edgeCount: counts?.edgeCount ?? null,
            active: row.id === active.id,
          };
        }),
      );
      return { graphs, activeGraphId: active.id };
    },
  }),

  createGraph: defineAction({
    description:
      "Creates a new graph record (slug derived from the name, status 'provisioning', no API base yet) and makes it the active graph. It does not create any database — provisioning happens externally and updateGraph flips the record to 'live' once its API is serving.",
    request: z.object({ name: z.string().min(1).max(120) }),
    response: z.object({ graph: graphRecordSchema }),
    async handler(ctx, args): Promise<{ graph: GraphRecord }> {
      const db = ctx.db<typeof schema>();
      const rows = await listGraphRows(ctx);
      const taken = new Set(rows.map((g) => g.slug));
      const base = slugify(args.name);
      let slug = base;
      let n = 2;
      while (taken.has(slug)) {
        slug = `${base}-${n}`;
        n += 1;
      }
      const inserted = await db
        .insert(schema.graphs)
        .values({
          name: args.name.trim(),
          slug,
          apiBase: null,
          status: "provisioning",
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("createGraph: insert returned no rows");
      await persistActiveGraph(ctx, row.id);
      await writeSignal("provision", row.id, row.slug);
      ctx.invalidateQueries();
      return { graph: toGraphRecord(row) };
    },
  }),

  updateGraph: defineAction({
    description:
      "Updates a graph record's API base and status — used externally to mark a graph 'live' with its Relate API base URL once provisioning finishes. Returns the updated record.",
    request: z.object({
      id: z.number().int().positive(),
      apiBase: z.string().max(500).nullable(),
      status: graphStatus,
    }),
    response: z.object({ graph: graphRecordSchema }),
    async handler(ctx, args): Promise<{ graph: GraphRecord }> {
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.graphs)
        .set({ apiBase: args.apiBase, status: args.status })
        .where(eq(schema.graphs.id, args.id))
        .returning();
      const row = updated[0];
      if (!row) throw new Error(`updateGraph: no graph with id ${args.id}`);
      ctx.invalidateQueries();
      return { graph: toGraphRecord(row) };
    },
  }),

  setActiveGraph: defineAction({
    description:
      "Sets the persisted active graph (survives reload) and returns it. Every graph read, dispatch, request list, and chat thread in this space is scoped to the active graph.",
    request: z.object({ graphId: z.number().int().positive() }),
    response: z.object({ graph: graphRecordSchema }),
    async handler(ctx, args): Promise<{ graph: GraphRecord }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.graphs)
        .where(eq(schema.graphs.id, args.graphId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error(`setActiveGraph: no graph with id ${args.graphId}`);
      await persistActiveGraph(ctx, row.id);
      ctx.invalidateQueries();
      return { graph: toGraphRecord(row) };
    },
  }),

  getGraph: defineAction({
    description:
      "Returns the full active graph (all nodes and edges), queried live from the active graph's Relate API on every call. Optional bitemporal params: asOfMode 'valid' keeps only nodes/edges whose validFrom/validTo window contains asOf, 'recorded' does the same on recordedAt/retiredAt (missing properties are unbounded; an edge must pass and both endpoints must pass); 'live' or absent params mean no filtering. The response's temporalCoverage counts how many nodes/edges carry valid-time and transaction-time properties across the whole graph, unfiltered. The response's filterTypes list is the ontology-driven type set for the filter UI: one entry per distinct stamped (:OntologyClass) name (kind 'ontology', live label count, deterministic palette color), infrastructure labels appended as kind 'system', and — when the graph has no stamped ontology — the raw label census as kind 'census'. A provisioning active graph returns its provisioning status with no nodes or edges.",
    request: z.object({
      asOfMode: z.enum(["live", "valid", "recorded"]).default("live"),
      asOf: z.string().max(64).nullable().default(null),
    }),
    response: graphResponse,
    async handler(ctx, args): Promise<z.infer<typeof graphResponse>> {
      const graph = await activeGraphRow(ctx);
      if (graph.status !== "live" || !graph.apiBase) {
        return {
          fetchedAt: new Date().toISOString(),
          nodeCount: 0,
          edgeCount: 0,
          nodes: [],
          edges: [],
          graphId: graph.id,
          graphName: graph.name,
          graphStatus: "provisioning",
          temporalCoverage: ZERO_COVERAGE,
          filterTypes: [],
        };
      }
      const [g, coverage] = await Promise.all([
        fetchLiveGraph(graph.apiBase, args.asOfMode, args.asOf),
        fetchTemporalCoverage(graph.apiBase),
      ]);
      const filterTypes = await fetchFilterTypes(graph.apiBase, g.nodes);
      return {
        fetchedAt: new Date().toISOString(),
        nodeCount: g.nodes.length,
        edgeCount: g.edges.length,
        nodes: g.nodes,
        edges: g.edges,
        graphId: graph.id,
        graphName: graph.name,
        graphStatus: "live",
        temporalCoverage: coverage,
        filterTypes,
      };
    },
  }),

  getNode: defineAction({
    description:
      "Returns one node by its graph key with all of its neighbors and the edges connecting them, queried live from the active graph's Relate API.",
    request: z.object({ key: z.string().min(1) }),
    response: nodeDetailResponse,
    async handler(ctx, args): Promise<z.infer<typeof nodeDetailResponse>> {
      const graph = await activeGraphRow(ctx);
      if (graph.status !== "live" || !graph.apiBase) {
        return { found: false, node: null, neighbors: [] };
      }
      const apiBase = graph.apiBase;
      const nodeData = await relateQuery(
        apiBase,
        "MATCH (n) WHERE coalesce(n.key, n.slug) = $key RETURN labels(n) AS labels, n.name AS name, properties(n) AS props",
        { key: args.key },
      );
      const firstRow = nodeData.values[0];
      if (!firstRow) return { found: false, node: null, neighbors: [] };
      const [labels, name, props] = firstRow as [
        string[] | null,
        string | null,
        Record<string, unknown> | null,
      ];
      const relData = await relateQuery(
        apiBase,
        "MATCH (n)-[r]-(m) WHERE coalesce(n.key, n.slug) = $key RETURN coalesce(m.key, m.slug) AS mKey, labels(m) AS mLabels, m.name AS mName, type(r) AS type, properties(r) AS rProps, coalesce(startNode(r).key, startNode(r).slug) = $key AS outgoing",
        { key: args.key },
      );
      const neighbors: z.infer<typeof neighborSchema>[] = relData.values.map((row) => {
        const [mKey, mLabels, mName, type, rProps, outgoing] = row as [
          string,
          string[] | null,
          string | null,
          string,
          Record<string, unknown> | null,
          boolean,
        ];
        return {
          key: mKey,
          label: mLabels?.[0] ?? "Node",
          name: mName ?? mKey,
          direction: outgoing ? ("out" as const) : ("in" as const),
          edgeType: type,
          edgeProps: cleanProps(rProps ?? undefined),
        };
      });
      return {
        found: true,
        node: {
          key: args.key,
          label: labels?.[0] ?? "Node",
          name: name ?? args.key,
          degree: neighbors.length,
          props: cleanProps(props ?? undefined),
        },
        neighbors,
      };
    },
  }),

  runCypher: defineAction({
    description:
      "Runs a read-only Cypher statement against the active graph's live Relate API and returns the result fields and rows. Fails honestly when the API is unreachable or the graph is still provisioning.",
    request: z.object({ statement: z.string().min(1).max(4000) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      fields: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      rowCount: z.number(),
      truncated: z.boolean(),
    }),
    async handler(ctx, args) {
      const graph = await activeGraphRow(ctx);
      if (graph.status !== "live" || !graph.apiBase) {
        return {
          ok: false,
          error: `Graph "${graph.name}" is still provisioning — its database is being started, so there is nothing to query yet.`,
          fields: [],
          rows: [],
          rowCount: 0,
          truncated: false,
        };
      }
      const stmt = args.statement.trim();
      if (WRITE_KEYWORDS.test(stmt)) {
        return {
          ok: false,
          error:
            "Write statements are not run from this console — dispatch a pipeline job from the Agent panel to change the graph.",
          fields: [],
          rows: [],
          rowCount: 0,
          truncated: false,
        };
      }
      try {
        const data = await relateQuery(graph.apiBase, stmt);
        const MAX_ROWS = 200;
        const rows = data.values
          .slice(0, MAX_ROWS)
          .map((row) => row.map((cell) => formatCell(cell)));
        return {
          ok: true,
          error: null,
          fields: data.fields,
          rows,
          rowCount: data.values.length,
          truncated: data.values.length > MAX_ROWS,
        };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error ? err.message : "Relate API unreachable",
          fields: [],
          rows: [],
          rowCount: 0,
          truncated: false,
        };
      }
    },
  }),

  getStatus: defineAction({
    description:
      "Checks the active graph's live Relate API: node and edge counts straight from the store, its provisioning state when its database is still being started, or the failure if it is unreachable.",
    request: z.object({}),
    response: z.object({
      live: z.boolean(),
      error: z.string().nullable(),
      nodeCount: z.number().nullable(),
      edgeCount: z.number().nullable(),
      checkedAt: z.string(),
      graphId: z.number(),
      graphName: z.string(),
      graphStatus: graphStatus,
    }),
    async handler(ctx) {
      const graph = await activeGraphRow(ctx);
      const base = {
        graphId: graph.id,
        graphName: graph.name,
        graphStatus: graph.status,
        checkedAt: new Date().toISOString(),
      };
      if (graph.status !== "live" || !graph.apiBase) {
        return {
          ...base,
          live: false,
          error: `Graph "${graph.name}" is provisioning — its database is being started.`,
          nodeCount: null,
          edgeCount: null,
        };
      }
      try {
        const counts = await graphCounts(graph.apiBase);
        if (!counts) {
          throw new Error(
            `Relate API unreachable at ${queryUrl(graph.apiBase)}`,
          );
        }
        return {
          ...base,
          live: true,
          error: null,
          nodeCount: counts.nodeCount,
          edgeCount: counts.edgeCount,
        };
      } catch (err) {
        return {
          ...base,
          live: false,
          error: err instanceof Error ? err.message : String(err),
          nodeCount: null,
          edgeCount: null,
        };
      }
    },
  }),

  dispatchAgentTask: defineAction({
    description:
      "Files a data-pipeline work request (category: import, ontology, categorizing, normalization, embeddings, processing, cleaning, communities, query, or dream) against the ACTIVE graph for a background Muse agent and spawns the task. The request records the active graph's id and API base. The request starts as 'requested' and only reaches 'done' or 'failed' when the agent writes its outcome back.",
    request: z.object({
      category: agentCategory,
      task: z.string().min(1).max(4000),
      nodeKey: z.string().max(200).nullable().default(null),
      nodeName: z.string().max(300).nullable().default(null),
    }),
    response: z.object({ request: agentRequestSchema }),
    async handler(ctx, args) {
      const request = await fileAgentRequest(ctx, {
        category: args.category,
        task: args.task,
        nodeKey: args.nodeKey,
        nodeName: args.nodeName,
      });
      return { request };
    },
  }),

  listAgentRequests: defineAction({
    description:
      "Lists agent work requests, newest first, with their live status and any written-back result. When graphId is given, returns that graph's requests regardless of which graph is active; when omitted, returns the ACTIVE graph's requests. Requests filed before multi-graph support belong to Main.",
    request: z.object({
      limit: z.number().int().positive().max(50).default(20),
      graphId: z.number().int().positive().nullable().default(null),
    }),
    response: z.object({ requests: z.array(agentRequestSchema) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const active = await activeGraphRow(ctx);
      const main = await mainGraphRow(ctx);
      const targetId = args.graphId ?? active.id;
      const scope =
        targetId === main.id
          ? or(
              isNull(schema.agentRequests.graphId),
              eq(schema.agentRequests.graphId, main.id),
            )
          : eq(schema.agentRequests.graphId, targetId);
      const rows = await db
        .select()
        .from(schema.agentRequests)
        .where(scope)
        .orderBy(desc(schema.agentRequests.id))
        .limit(args.limit);
      return { requests: rows.map((r) => toAgentRequest(r, main.id)) };
    },
  }),

  updateAgentRequest: defineAction({
    description:
      "Writes back the status and outcome of an agent work request. Called by the background agent executing the request. Global by request id — not scoped to the active graph.",
    request: z.object({
      id: z.number().int().positive(),
      status: requestStatus,
      result: z.string().max(8000).nullable().default(null),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.agentRequests)
        .set({
          status: args.status,
          result: args.result,
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRequests.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  sendChatMessage: defineAction({
    description:
      "Stores a new user message in the active graph's agent chat thread (status 'awaiting-agent') and returns the stored message. This is how the user talks to the agent from inside the space; no reply is generated here.",
    request: z.object({
      text: z.string().min(1).max(4000),
      graphId: z.string().max(200).nullable().default(null),
    }),
    response: z.object({ message: chatMessageSchema }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const graph = await activeGraphRow(ctx);
      const inserted = await db
        .insert(schema.chatMessages)
        .values({
          graphId: args.graphId ?? String(graph.id),
          role: "user",
          text: args.text,
          status: "awaiting-agent",
          replyToId: null,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("sendChatMessage: insert returned no rows");
      // The signal names the graph the message belongs to; a message whose
      // stored graphId is some other graph's id signals that graph's slug.
      let signalSlug = graph.slug;
      if (row.graphId != null && row.graphId !== String(graph.id)) {
        const rows = await listGraphRows(ctx);
        signalSlug =
          rows.find((g) => String(g.id) === row.graphId)?.slug ?? graph.slug;
      }
      await writeSignal("chat", row.id, signalSlug);
      ctx.invalidateQueries();
      return { message: toChatMessage(row) };
    },
  }),

  listChatMessages: defineAction({
    description:
      "Returns the active graph's agent chat thread, oldest first. When graphId is given, only messages for that graph are returned. Messages with a null graphId predate multi-graph support and belong to Main, so they are included when Main is the active (or requested) graph.",
    request: z.object({
      graphId: z.string().max(200).nullable().default(null),
    }),
    response: z.object({ messages: z.array(chatMessageSchema) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const main = await mainGraphRow(ctx);
      const active = await activeGraphRow(ctx);
      const targetId =
        args.graphId != null ? Number(args.graphId) : active.id;
      const scope =
        targetId === main.id
          ? or(
              isNull(schema.chatMessages.graphId),
              eq(schema.chatMessages.graphId, String(main.id)),
            )
          : eq(schema.chatMessages.graphId, String(targetId));
      const rows = await db
        .select()
        .from(schema.chatMessages)
        .where(scope)
        .orderBy(asc(schema.chatMessages.id));
      return { messages: rows.map(toChatMessage) };
    },
  }),

  agentReply: defineAction({
    description:
      "Appends an agent message answering the user message with id replyToId (the agent message copies that message's graphId) and marks the user message as 'answered'. Returns the stored agent message. This is the write-back side used by the external agent.",
    request: z.object({
      replyToId: z.number().int().positive(),
      text: z.string().min(1).max(8000),
    }),
    response: z.object({ message: chatMessageSchema }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const targets = await db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, args.replyToId))
        .limit(1);
      const target = targets[0];
      if (!target) {
        throw new Error(
          `agentReply: no chat message with id ${args.replyToId}`,
        );
      }
      const inserted = await db
        .insert(schema.chatMessages)
        .values({
          graphId: target.graphId,
          role: "agent",
          text: args.text,
          status: null,
          replyToId: args.replyToId,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("agentReply: insert returned no rows");
      await db
        .update(schema.chatMessages)
        .set({ status: "answered" })
        .where(eq(schema.chatMessages.id, args.replyToId));
      ctx.invalidateQueries();
      return { message: toChatMessage(row) };
    },
  }),

  uploadFile: defineAction({
    description:
      "Stores a text-format file upload for a graph (extensions md, markdown, txt, csv, json, jsonld, ttl, rdf, xml, cypher; text or JSON mime types; content capped at 2,000,000 characters). Returns metadata and the new id only — never the content. Over-cap or binary uploads return ok:false with an error and store nothing.",
    request: z.object({
      filename: z.string().min(1).max(300),
      mime: z.string().max(200),
      contentText: z.string(),
      graphId: z.number().int().positive().nullable().default(null),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      upload: uploadMetaSchema.nullable(),
    }),
    async handler(ctx, args) {
      const fail = (error: string) => ({ ok: false, error, upload: null });
      const ext = args.filename
        .slice(args.filename.lastIndexOf(".") + 1)
        .toLowerCase();
      if (!UPLOAD_EXTENSIONS.has(ext) || !isTextMime(args.mime)) {
        return fail(
          `"${args.filename}" is not a supported text file. Uploads accept text formats only: md, markdown, txt, csv, json, jsonld, ttl, rdf, xml, cypher.`,
        );
      }
      if (args.contentText.length > UPLOAD_MAX_CHARS) {
        return fail(
          `"${args.filename}" is ${args.contentText.length.toLocaleString()} characters — over the ${UPLOAD_MAX_CHARS.toLocaleString()}-character upload cap. Nothing was stored.`,
        );
      }
      const db = ctx.db<typeof schema>();
      const graph = await activeGraphRow(ctx);
      const inserted = await db
        .insert(schema.uploads)
        .values({
          graphId: String(args.graphId ?? graph.id),
          filename: args.filename,
          mime: args.mime,
          sizeBytes: new TextEncoder().encode(args.contentText).length,
          contentText: args.contentText,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("uploadFile: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true, error: null, upload: toUploadMeta(row) };
    },
  }),

  listUploads: defineAction({
    description:
      "Lists file uploads as metadata only (id, filename, mime, size, date, graphId — never the content), newest first. When graphId is omitted the list is scoped to the active graph, with uploads carrying a null graphId treated as Main's, matching listChatMessages.",
    request: z.object({
      graphId: z.number().int().positive().nullable().default(null),
    }),
    response: z.object({ uploads: z.array(uploadMetaSchema) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const main = await mainGraphRow(ctx);
      const active = await activeGraphRow(ctx);
      const targetId = args.graphId ?? active.id;
      const scope =
        targetId === main.id
          ? or(
              isNull(schema.uploads.graphId),
              eq(schema.uploads.graphId, String(main.id)),
            )
          : eq(schema.uploads.graphId, String(targetId));
      const rows = await db
        .select()
        .from(schema.uploads)
        .where(scope)
        .orderBy(desc(schema.uploads.id));
      return { uploads: rows.map(toUploadMeta) };
    },
  }),

  getUpload: defineAction({
    description:
      "Returns one upload's full record including its contentText — the read the external pipeline uses to fetch an uploaded file's content for an import job. Returns upload:null when no upload has that id.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ upload: uploadFullSchema.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.uploads)
        .where(eq(schema.uploads.id, args.id))
        .limit(1);
      const row = rows[0];
      if (!row) return { upload: null };
      return {
        upload: { ...toUploadMeta(row), contentText: row.contentText },
      };
    },
  }),

  listOntologyPresets: defineAction({
    description:
      "Lists the packaged ontology presets (the standard vocabularies and the house ontology shipped with the Relate connector). Each preset carries an 'available' flag: true/false when the server could check the file exists on disk, null when availability cannot be checked.",
    request: z.object({}),
    response: z.object({ presets: z.array(ontologyPresetSchema) }),
    privileged: [privileged.fileExists],
    async handler(ctx): Promise<{
      presets: z.infer<typeof ontologyPresetSchema>[];
    }> {
      const presets = await Promise.all(
        ONTOLOGY_PRESETS.map(async (p) => ({
          id: p.id,
          name: p.name,
          file: p.file,
          blurb: p.blurb,
          available: await presetFileAvailable(ctx, p.file),
        })),
      );
      return { presets };
    },
  }),

  applyOntologyPreset: defineAction({
    description:
      "Applies an ontology preset to the ACTIVE graph by filing an 'ontology' dispatch through the same code path as dispatchAgentTask, with a task text naming the preset and its file. Returns ok:false with a clear error for an unknown presetId.",
    request: z.object({ presetId: z.string().min(1).max(100) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      request: agentRequestSchema.nullable(),
    }),
    async handler(ctx, args) {
      const preset = ONTOLOGY_PRESETS.find((p) => p.id === args.presetId);
      if (!preset) {
        return {
          ok: false,
          error: `Unknown ontology preset "${args.presetId}". Known presets: ${ONTOLOGY_PRESETS.map((p) => p.id).join(", ")}.`,
          request: null,
        };
      }
      const task = `Apply the '${preset.name}' ontology preset (file: ${preset.file}) to this graph: load the ontology file, align this graph's labels, relationship types and properties to it where the data genuinely maps, record the applied preset on the graph, and report mappings made and explicitly NOT made.`;
      const request = await fileAgentRequest(ctx, {
        category: "ontology",
        task,
        nodeKey: null,
        nodeName: null,
      });
      return { ok: true, error: null, request };
    },
  }),

  listDecisions: defineAction({
    description:
      "Lists a graph's decision ledger — its (:Decision) nodes read live through that graph's own Relate API — newest first (by `at` descending, ties broken by decision id descending). graphId targets a specific graph; omitted means the active graph. An optional kind filters by exact match; limit defaults to 50. Each entry's detail is the stored JSON string parsed when it parses, otherwise the raw string. Fails honestly when the graph is provisioning or its API is unreachable.",
    request: z.object({
      graphId: z.number().int().positive().nullable().default(null),
      kind: z.string().max(100).nullable().default(null),
      limit: z.number().int().positive().max(500).default(50),
    }),
    response: z.object({ decisions: z.array(decisionSchema) }),
    async handler(ctx, args): Promise<{ decisions: DecisionEntry[] }> {
      const graph = await governanceGraph(ctx, args.graphId);
      const apiBase = governanceApiBase(graph);
      const data = await relateQuery(
        apiBase,
        "MATCH (d:Decision) RETURN d.slug AS slug, d.kind AS kind, d.subject AS subject, d.detail AS detail, d.at AS at, d.revertedAt AS revertedAt",
      );
      const entries: DecisionEntry[] = [];
      for (const row of data.values) {
        const [slug, kind, subject, detail, at, revertedAt] = row as [
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ];
        if (!slug) continue;
        entries.push({
          id: slug,
          kind: kind ?? "",
          subject: subject ?? "",
          detail: parseStoredJson(detail),
          at: at ?? "",
          revertedAt: revertedAt ?? null,
        });
      }
      const filtered =
        args.kind != null
          ? entries.filter((e) => e.kind === args.kind)
          : entries;
      filtered.sort(
        (a, b) => compareIso(b.at, a.at) || idSequence(b.id) - idSequence(a.id),
      );
      return { decisions: filtered.slice(0, args.limit) };
    },
  }),

  listReviewItems: defineAction({
    description:
      "Lists a graph's review queue — its (:ReviewItem) nodes read live through that graph's own Relate API — oldest first (by `at` ascending, ties broken by review id ascending). graphId targets a specific graph; omitted means the active graph. status filters exactly and defaults to 'open'. subject is the stored JSON string parsed; choices is the stored JSON array parsed (entries are strings or objects carrying id/choice/value plus an optional label). resolution and resolvedAt are null until the CLI resolves the item. Fails honestly when the graph is provisioning or its API is unreachable.",
    request: z.object({
      graphId: z.number().int().positive().nullable().default(null),
      status: z.string().max(50).nullable().default(null),
    }),
    response: z.object({ items: z.array(reviewItemSchema) }),
    async handler(ctx, args): Promise<{ items: ReviewItemEntry[] }> {
      const graph = await governanceGraph(ctx, args.graphId);
      const apiBase = governanceApiBase(graph);
      const wanted = args.status ?? "open";
      const data = await relateQuery(
        apiBase,
        "MATCH (r:ReviewItem) RETURN r.slug AS slug, r.kind AS kind, r.subject AS subject, r.choices AS choices, r.status AS status, r.at AS at, r.resolution AS resolution, r.resolvedAt AS resolvedAt",
      );
      const items: ReviewItemEntry[] = [];
      for (const row of data.values) {
        const [slug, kind, subject, choices, status, at, resolution, resolvedAt] =
          row as [
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
          ];
        if (!slug) continue;
        if ((status ?? "") !== wanted) continue;
        const parsedChoices = parseStoredJson(choices);
        const choiceList = Array.isArray(parsedChoices)
          ? parsedChoices.filter(
              (c): c is string | Record<string, unknown> =>
                typeof c === "string" ||
                (typeof c === "object" && c !== null && !Array.isArray(c)),
            )
          : [];
        items.push({
          id: slug,
          kind: kind ?? "",
          subject: parseStoredJson(subject),
          choices: choiceList,
          status: status ?? "",
          at: at ?? "",
          resolution: resolution ?? null,
          resolvedAt: resolvedAt ?? null,
        });
      }
      items.sort(
        (a, b) => compareIso(a.at, b.at) || idSequence(a.id) - idSequence(b.id),
      );
      return { items };
    },
  }),

  resolveReviewItem: defineAction({
    description:
      "Files a resolution for a review item as a 'processing' dispatch through the same shared dispatch path as dispatchAgentTask (durable request, best-effort SpaceSignal into Main, spawned agent), against the target graph (graphId, or the active graph when omitted) — the filed request records that graph's id and API base. The task text names the review item id and the chosen option verbatim and instructs the pipeline to run the typed tool `relate review-resolve <graph-slug> <item-id> \"<choice>\"`, which is what flips the item and logs the Decision itself, and to report the resulting decision id. This action modifies nothing in the graph: the item stays open until the pipeline executes the dispatch. Returns ok:true with the filed request and its id.",
    request: z.object({
      id: z.string().min(1).max(200),
      choice: z.string().min(1).max(500),
      graphId: z.number().int().positive().nullable().default(null),
    }),
    response: resolveReviewItemResponse,
    async handler(
      ctx,
      args,
    ): Promise<z.infer<typeof resolveReviewItemResponse>> {
      const graph = await governanceGraph(ctx, args.graphId);
      const task = [
        `Resolve review item ${args.id} in graph "${graph.name}" (slug: ${graph.slug}).`,
        `The chosen option is: "${args.choice}"`,
        `Run the typed tool: relate review-resolve ${graph.slug} ${args.id} "${args.choice}"`,
        "That command flips the review item to resolved and logs the Decision itself — do not resolve the item any other way. Report the resulting decision id in your result summary.",
      ].join("\n");
      const request = await fileAgentRequest(ctx, {
        category: "processing",
        task,
        nodeKey: null,
        nodeName: null,
        graphId: graph.id,
      });
      return { ok: true, requestId: request.id, request };
    },
  }),
} satisfies ActionsModule;

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const node = v as RelateNode;
  if (node && typeof node === "object" && "labels" in node && "properties" in node) {
    const name = node.properties?.["name"];
    const key = node.properties?.["key"];
    const label = node.labels?.[0] ?? "Node";
    return `:${label} ${typeof name === "string" ? name : typeof key === "string" ? key : (node.elementId ?? "")}`;
  }
  try {
    const s = JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return String(v);
  }
}
