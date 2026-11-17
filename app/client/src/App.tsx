import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiRequest, type ApiResponse } from "./api";

type GraphData = ApiResponse<typeof api, "getGraph">;
type GNode = GraphData["nodes"][number];
type GEdge = GraphData["edges"][number];
type CypherResult = ApiResponse<typeof api, "runCypher">;
type AgentRequest = ApiResponse<typeof api, "listAgentRequests">["requests"][number];
type ChatMessage = ApiResponse<typeof api, "listChatMessages">["messages"][number];
type GraphEntry = ApiResponse<typeof api, "listGraphs">["graphs"][number];
type UploadMeta = ApiResponse<typeof api, "listUploads">["uploads"][number];
type OntologyPreset =
  ApiResponse<typeof api, "listOntologyPresets">["presets"][number];
type Decision = ApiResponse<typeof api, "listDecisions">["decisions"][number];
type ReviewItem = ApiResponse<typeof api, "listReviewItems">["items"][number];
type ReviewChoice = ReviewItem["choices"][number];
type AgentCategory = ApiRequest<typeof api, "dispatchAgentTask">["category"];
type AsOfMode = "live" | "valid" | "recorded";

const TEMPORAL_PROP_KEYS = ["validFrom", "validTo", "recordedAt", "retiredAt"] as const;

// Format a Date for a datetime-local input value (local time, minute precision).
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const AGENT_CATEGORIES: AgentCategory[] = [
  "import",
  "ontology",
  "categorizing",
  "normalization",
  "processing",
  "cleaning",
  "embeddings",
  "communities",
  "query",
  "dream",
];

// The exact task text the Dream button files (category "dream").
const DREAM_TASK =
  "Dream pass: summarize unsummarized source documents, embed unembedded content nodes, refresh communities, surface merge candidates as lead-grade findings only.";

const PIPELINE_PRESETS: { category: AgentCategory; label: string; task: string }[] = [
  {
    category: "import",
    label: "Import data into the graph",
    task: "Import data into the graph: load the source dataset named in this task into the Relate store as nodes and edges, following the existing schema where one exists. Report before/after node and edge counts and counts by label and relationship type. (Edit this text to name the source before triggering.)",
  },
  {
    category: "ontology",
    label: "Run an ontology/schema pass",
    task: "Run an ontology/schema pass over the graph: inventory every label, relationship type, and property key in the store, propose a consistent schema, and report anything that does not conform.",
  },
  {
    category: "categorizing",
    label: "Categorize nodes",
    task: "Categorize nodes across the graph: assign and standardize node categories and category properties so every node carries a consistent category. Report the categories used, how many nodes were assigned or corrected in each, and any nodes left uncategorized.",
  },
  {
    category: "normalization",
    label: "Normalize names and handles",
    task: "Normalize names and handles across the graph: find inconsistent display names, handle casing differences, and nodes that look like duplicates of each other. Report the proposed normalizations and merges — do not merge anything without listing it in the result first.",
  },
  {
    category: "processing",
    label: "Process this dataset",
    task: "Process this dataset: run the processing step named in this task over the graph and report what changed, with before/after counts. (Edit this text to name the exact processing step before triggering.)",
  },
  {
    category: "cleaning",
    label: "Clean and dedupe",
    task: "Clean and dedupe the graph: find duplicate nodes, orphan nodes with no relationships, and malformed or empty properties. Report everything found and what was removed or merged, with before/after counts.",
  },
  {
    category: "embeddings",
    label: "Embed new nodes",
    task: "Embed new nodes: generate embeddings for nodes that do not have one yet and report coverage by label — how many nodes were embedded and how many remain.",
  },
  {
    category: "communities",
    label: "Detect communities",
    task: "Detect communities in the graph: find clusters of densely connected nodes, label each community, and report the communities found with their sizes and the nodes in each.",
  },
  {
    category: "dream",
    label: "Dream — consolidate this graph",
    task: DREAM_TASK,
  },
];

const REQUEST_STATUS_COLOR: Record<AgentRequest["status"], string> = {
  requested: "#f5b04c",
  running: "#58a6ff",
  done: "#3fb950",
  failed: "#ff7b72",
};

// Type colors come from the server: getGraph's filterTypes is built from
// the active graph's stamped ontology and assigns each type a color from
// this fixed palette, deterministically by type name (Person pinned to
// its orange, #f5b04c). The local fallback mirrors the same palette and
// hash so a label the server list somehow does not cover still gets a
// stable, non-grey color instead of the old generic grey.
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

function hashTypeName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fallbackTypeColor(label: string): string {
  if (label === "Person") return "#f5b04c";
  return TYPE_PALETTE[hashTypeName(label) % TYPE_PALETTE.length] ?? "#f5b04c";
}

function nodeRadius(n: GNode): number {
  return 3.5 + Math.min(11, Math.sqrt(n.degree) * 1.9);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const UPLOAD_ACCEPT =
  ".md,.markdown,.txt,.csv,.json,.jsonld,.ttl,.rdf,.xml,.cypher";
const UPLOAD_MAX_CHARS = 2_000_000;

function propText(v: string | number | boolean | null): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// ---- Node detail property rendering ----
// The detail panel never dumps raw machine values: embedding vectors and
// other long numeric lists collapse to a one-line "stored" summary, long
// strings and serialized JSON collapse behind a tap-to-expand control,
// and properties are ordered human-first, machine/internal last.

type PropVal = string | number | boolean | null;

const HUMAN_PROP_ORDER = [
  "name",
  "title",
  "summary",
  "category",
  "community",
  "alias",
  "aliases",
  "legalName",
  "normalizedName",
  "sourcePath",
];
const TEMPORAL_PROP_ORDER: string[] = [...TEMPORAL_PROP_KEYS];
const MACHINE_PROP_ORDER = [
  "embedding",
  "embedding_dim",
  "embedding_model",
  "slug",
  "normalizedSlug",
  "elementId",
  "element_id",
];
const MACHINE_PROP_KEYS = new Set(MACHINE_PROP_ORDER);
const PROP_LABELS: Record<string, string> = {
  embedding: "Embedding",
  embedding_dim: "Embedding size",
  embedding_model: "Embedding model",
};

const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// Counts the numbers in a comma-separated numeric list ("-0.14, 0.02, …").
// Returns null when the text is not a pure numeric list.
function countNumericList(text: string): number | null {
  if (!text.includes(",")) return null;
  let count = 0;
  for (const part of text.split(",")) {
    const t = part.trim();
    if (t === "") continue;
    if (!NUMERIC_RE.test(t)) return null;
    count++;
  }
  return count > 0 ? count : null;
}

// Parses a string that is serialized JSON (starts with { or [ and parses).
// Returns undefined for anything else.
function parseJsonString(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

function isSerializedJson(text: string): boolean {
  return parseJsonString(text) !== undefined;
}

// How many numbers the node's embedding holds, derived from the data:
// the vector itself (array length, or a count of its comma-separated
// numbers), falling back to the node's embedding_dim property.
function embeddingCount(props: Record<string, PropVal>): number | null {
  const v: unknown = props["embedding"];
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") {
    const c = countNumericList(v);
    if (c !== null) return c;
  }
  const dim: unknown = props["embedding_dim"];
  if (typeof dim === "number" && Number.isFinite(dim)) return dim;
  if (typeof dim === "string" && /^\d+$/.test(dim.trim())) return Number(dim.trim());
  return null;
}

// Orders a node's properties for the detail panel: human-meaningful
// first (in HUMAN_PROP_ORDER), then valid/recorded-time dates, then any
// remaining ordinary properties in store order, then machine/internal
// properties and raw JSON blobs last.
function orderNodeProps(
  props: Record<string, PropVal>,
): { key: string; value: PropVal; machine: boolean }[] {
  const used = new Set<string>();
  const out: { key: string; value: PropVal; machine: boolean }[] = [];
  const take = (key: string, machine: boolean) => {
    if (used.has(key)) return;
    const value = props[key];
    if (value === undefined) return;
    used.add(key);
    out.push({ key, value, machine });
  };
  for (const k of HUMAN_PROP_ORDER) take(k, false);
  for (const k of TEMPORAL_PROP_ORDER) take(k, false);
  for (const [k, v] of Object.entries(props)) {
    if (used.has(k) || MACHINE_PROP_KEYS.has(k)) continue;
    if (typeof v === "string" && isSerializedJson(v)) continue;
    take(k, false);
  }
  for (const k of MACHINE_PROP_ORDER) take(k, true);
  for (const k of Object.keys(props)) take(k, true);
  return out;
}

// One property row in the node detail panel. Machine values are
// summarized, never dumped: the embedding renders as a single "stored"
// line, long numeric lists likewise, long strings and serialized JSON
// render collapsed behind a tap-to-expand control.
function NodePropRow({
  propKey,
  value,
  allProps,
  machine,
}: {
  propKey: string;
  value: PropVal;
  allProps: Record<string, PropVal>;
  machine: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = PROP_LABELS[propKey] ?? propKey;
  const sizeCls = machine ? "text-xs" : "text-sm";
  const dt = <dt className="shrink-0 text-[var(--dim)]">{label}</dt>;
  const expandButton = (text: string) => (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((e) => !e)}
      className="min-h-[44px] text-[var(--accent)] underline"
    >
      {expanded ? "Hide" : text}
    </button>
  );

  // The embedding vector itself is never rendered — one summary line.
  if (propKey === "embedding") {
    const count = embeddingCount(allProps);
    return (
      <div className={`flex gap-2 ${sizeCls}`}>
        {dt}
        <dd className="min-w-0 break-words text-[var(--dim)]">
          {count !== null ? `stored (${count} numbers)` : "stored"}
        </dd>
      </div>
    );
  }

  const raw: unknown = value;

  // A real array value (defensive — props normally arrive as scalars):
  // long numeric arrays summarize like embeddings; other long arrays
  // collapse to an item count with the items behind a disclosure.
  if (Array.isArray(raw)) {
    if (raw.length > 10 && raw.every((x) => typeof x === "number")) {
      return (
        <div className={`flex gap-2 ${sizeCls}`}>
          {dt}
          <dd className="min-w-0 break-words text-[var(--dim)]">stored ({raw.length} numbers)</dd>
        </div>
      );
    }
    if (raw.length > 10) {
      return (
        <div className={sizeCls}>
          <div className="flex gap-2">
            {dt}
            <dd className="min-w-0 break-words">{raw.length} items</dd>
          </div>
          {expandButton("Show items")}
          {expanded && (
            <p className="break-words">{raw.map((x) => detailValueText(x)).join(", ")}</p>
          )}
        </div>
      );
    }
    return (
      <div className={`flex gap-2 ${sizeCls}`}>
        {dt}
        <dd className="min-w-0 break-words">{raw.map((x) => detailValueText(x)).join(", ")}</dd>
      </div>
    );
  }

  if (typeof value === "string") {
    // A long comma-separated numeric list (e.g. a vector stored as text).
    const numericCount = countNumericList(value);
    if (numericCount !== null && numericCount > 10) {
      return (
        <div className={`flex gap-2 ${sizeCls}`}>
          {dt}
          <dd className="min-w-0 break-words text-[var(--dim)]">stored ({numericCount} numbers)</dd>
        </div>
      );
    }
    const parsed = parseJsonString(value);
    if (Array.isArray(parsed) && parsed.length > 10) {
      return (
        <div className={sizeCls}>
          <div className="flex gap-2">
            {dt}
            <dd className="min-w-0 break-words">{parsed.length} items</dd>
          </div>
          {expandButton("Show items")}
          {expanded && (
            <p className="break-words">{parsed.map((x) => detailValueText(x)).join(", ")}</p>
          )}
        </div>
      );
    }
    // Long strings and serialized JSON render collapsed: a short preview
    // plus a tap-to-expand control; the full value only when tapped.
    if (value.length > 300 || parsed !== undefined) {
      const preview = value.length > 160 ? `${value.slice(0, 160)}…` : value;
      return (
        <div className={sizeCls}>
          <div className="flex gap-2">
            {dt}
            <dd className="min-w-0 break-words">{expanded ? value : preview}</dd>
          </div>
          {expandButton("Show full text")}
        </div>
      );
    }
    const isTemporal = (TEMPORAL_PROP_KEYS as readonly string[]).includes(propKey);
    return (
      <div className={`flex gap-2 ${sizeCls}`}>
        {dt}
        <dd className="min-w-0 break-words">{isTemporal ? formatInstant(value) : value}</dd>
      </div>
    );
  }

  return (
    <div className={`flex gap-2 ${sizeCls}`}>
      {dt}
      <dd className="min-w-0 break-words">{propText(value)}</dd>
    </div>
  );
}

// A review choice is a plain string, or an object carrying one of
// id/choice/value plus an optional label. The button shows the label
// when present; the value filed is the choice string the CLI accepts
// (for objects: id, else choice, else value).
function choiceValue(c: ReviewChoice): string {
  if (typeof c === "string") return c;
  const v = c["id"] ?? c["choice"] ?? c["value"];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function choiceLabel(c: ReviewChoice): string {
  if (typeof c === "string") return c;
  const label = c["label"];
  if (typeof label === "string" && label.length > 0) return label;
  return choiceValue(c);
}

// Renders a parsed JSON value (a decision's detail, a review item's
// subject) readably: scalars as text, objects as key/value lines, nested
// values as compact JSON.
function detailValueText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function DetailLines({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return null;
    return (
      <dl className="mt-1 space-y-0.5">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2 text-xs">
            <dt className="shrink-0 font-mono text-[var(--dim)]">{k}</dt>
            <dd className="min-w-0 break-words">{detailValueText(v)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return (
      <p className="mt-1 text-xs break-words">
        {value.map((v) => detailValueText(v)).join(", ")}
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs break-words">{detailValueText(value)}</p>
  );
}

// ---------------------------------------------------------------------------
// Canvas force graph
// ---------------------------------------------------------------------------

interface SimNode extends GNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function graphBounds(list: SimNode[]): { cx: number; cy: number; bw: number; bh: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of list) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    bw: Math.max(60, maxX - minX),
    bh: Math.max(60, maxY - minY),
  };
}

// Position-based force layout: springs + grid repulsion + gentle centering.
// Runs synchronously to a settled state, so the first paint is the finished
// graph — no explosion, no drift, nothing stranded off-screen.
function relaxLayout(list: SimNode[], edges: GEdge[], iterations: number): void {
  const byKey = new Map(list.map((n) => [n.key, n]));
  const CELL = 120;
  for (let it = 0; it < iterations; it++) {
    for (const e of edges) {
      const a = byKey.get(e.from);
      const b = byKey.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const diff = ((d - 85) / d) * 0.18;
      a.x += dx * diff;
      a.y += dy * diff;
      b.x -= dx * diff;
      b.y -= dy * diff;
    }
    const grid = new Map<string, SimNode[]>();
    for (const n of list) {
      const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
      const cell = grid.get(key);
      if (cell) cell.push(n);
      else grid.set(key, [n]);
    }
    for (const n of list) {
      const gx = Math.floor(n.x / CELL);
      const gy = Math.floor(n.y / CELL);
      for (let cx = gx - 1; cx <= gx + 1; cx++) {
        for (let cy = gy - 1; cy <= gy + 1; cy++) {
          const cell = grid.get(`${cx},${cy}`);
          if (!cell) continue;
          for (const m of cell) {
            if (m === n) continue;
            let dx = n.x - m.x;
            let dy = n.y - m.y;
            let d2 = dx * dx + dy * dy;
            if (d2 > CELL * CELL) continue;
            if (d2 < 0.01) {
              dx = (n.key.length % 7) - 3;
              dy = (m.key.length % 5) - 2;
              d2 = dx * dx + dy * dy + 0.01;
            }
            const d = Math.sqrt(d2);
            const push = ((CELL - d) / CELL) * 2.2;
            n.x += (dx / d) * push;
            n.y += (dy / d) * push;
          }
        }
      }
    }
    const centerPull = it < iterations * 0.6 ? 0.004 : 0.001;
    for (const n of list) {
      n.x -= n.x * centerPull;
      n.y -= n.y * centerPull;
    }
  }
}

interface GraphCanvasProps {
  nodes: GNode[];
  edges: GEdge[];
  typeColors: Map<string, string>;
  selectedKey: string | null;
  neighborKeys: Set<string> | null;
  focusKey: string | null;
  focusNonce: number;
  fitNonce: number;
  onSelect: (key: string | null) => void;
}

function GraphCanvas({
  nodes,
  edges,
  typeColors,
  selectedKey,
  neighborKeys,
  focusKey,
  focusNonce,
  fitNonce,
  onSelect,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<Map<string, SimNode>>(new Map());
  const camRef = useRef({ x: 0, y: 0, k: 0.55 });
  const fittedRef = useRef(false);
  const fitRef = useRef<() => void>(() => {});
  const autoFittedRef = useRef(false);
  const camAnimRef = useRef<{ x: number; y: number; k: number } | null>(null);
  const relaxFramesRef = useRef(0);
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const dragRef = useRef<{
    mode: "node" | "pan" | "pinch";
    key?: string;
    lastX: number;
    lastY: number;
  } | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number } | null>(null);
  const stateRef = useRef({ selectedKey, neighborKeys, focusKey });
  stateRef.current = { selectedKey, neighborKeys, focusKey };
  const typeColorsRef = useRef(typeColors);
  typeColorsRef.current = typeColors;

  // Sync layout nodes with the visible set, then settle the layout
  // synchronously (position-based, cannot explode) and, on first layout,
  // snap the camera so the whole graph is in frame.
  useEffect(() => {
    const sim = simRef.current;
    const seen = new Set<string>();
    let added = false;
    const rand = mulberry32(42);
    nodes.forEach((n, i) => {
      seen.add(n.key);
      const existing = sim.get(n.key);
      if (existing) {
        existing.degree = n.degree;
      } else {
        added = true;
        const r = 17 * Math.sqrt(i + 1) * (0.85 + rand() * 0.3);
        const th = i * 2.399963;
        sim.set(n.key, {
          ...n,
          x: Math.cos(th) * r,
          y: Math.sin(th) * r,
          vx: 0,
          vy: 0,
        });
      }
    });
    for (const key of [...sim.keys()]) {
      if (!seen.has(key)) sim.delete(key);
    }
    const list = [...sim.values()];
    if (list.length > 0) {
      relaxLayout(list, edgesRef.current, added ? 240 : 60);
      if (!autoFittedRef.current) {
        autoFittedRef.current = true;
        const wrap = wrapRef.current;
        if (wrap) {
          const rect = wrap.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const b = graphBounds(list);
            camRef.current = {
              x: b.cx,
              y: b.cy,
              k: Math.min(
                1.5,
                Math.max(
                  0.07,
                  Math.min(rect.width / (b.bw + 110), rect.height / (b.bh + 110)),
                ),
              ),
            };
          }
        }
      }
    }
  }, [nodes]);

  // Refit when filters change the visible set.
  useEffect(() => {
    if (fitNonce > 0) fitRef.current();
  }, [fitNonce]);

  // Focus camera on a node chosen from search / neighbor list.
  useEffect(() => {
    if (!focusKey) return;
    const sn = simRef.current.get(focusKey);
    if (!sn) return;
    camAnimRef.current = {
      x: sn.x,
      y: sn.y,
      k: Math.max(camRef.current.k, 1.05),
    };
  }, [focusKey, focusNonce]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      w = Math.max(50, rect.width);
      h = Math.max(50, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      if (!fittedRef.current) {
        fittedRef.current = true;
        camRef.current.k = Math.min(0.8, Math.max(0.28, Math.min(w, h) / 1050));
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // Fit the camera so the whole layout is inside the canvas.
    const fitBounds = () => {
      const list = [...simRef.current.values()];
      if (list.length === 0 || w === 0 || h === 0) return;
      const b = graphBounds(list);
      const k = Math.min(
        1.5,
        Math.max(0.07, Math.min(w / (b.bw + 110), h / (b.bh + 110))),
      );
      camAnimRef.current = { x: b.cx, y: b.cy, k };
    };
    fitRef.current = fitBounds;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const sim = simRef.current;
      const list = [...sim.values()];
      const cam = camRef.current;

      // Camera animation (focus)
      const anim = camAnimRef.current;
      if (anim) {
        cam.x += (anim.x - cam.x) * 0.14;
        cam.y += (anim.y - cam.y) * 0.14;
        cam.k += (anim.k - cam.k) * 0.14;
        if (
          Math.abs(anim.x - cam.x) < 0.6 &&
          Math.abs(anim.y - cam.y) < 0.6 &&
          Math.abs(anim.k - cam.k) < 0.005
        ) {
          camAnimRef.current = null;
        }
      }

      // The layout is pre-settled; only a node drag asks for a few
      // relaxation frames so neighbors follow gently.
      if (relaxFramesRef.current > 0 && list.length > 0) {
        relaxFramesRef.current -= 1;
        relaxLayout(list, edges, 2);
      }

      // ---- draw ----
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const { selectedKey: sel, neighborKeys: nbrs } = stateRef.current;
      const hasSel = sel != null;
      const toX = (wx: number) => (wx - cam.x) * cam.k + w / 2;
      const toY = (wy: number) => (wy - cam.y) * cam.k + h / 2;

      ctx.lineWidth = 1;
      for (const e of edges) {
        const a = sim.get(e.from);
        const b = sim.get(e.to);
        if (!a || !b) continue;
        const touches = hasSel && (e.from === sel || e.to === sel);
        if (touches) {
          ctx.strokeStyle = "rgba(45, 212, 191, 0.75)";
        } else if (hasSel) {
          ctx.strokeStyle = "rgba(120, 140, 160, 0.05)";
        } else {
          ctx.strokeStyle = "rgba(120, 140, 160, 0.16)";
        }
        ctx.beginPath();
        ctx.moveTo(toX(a.x), toY(a.y));
        ctx.lineTo(toX(b.x), toY(b.y));
        ctx.stroke();
      }

      for (const n of list) {
        const x = toX(n.x);
        const y = toY(n.y);
        if (x < -30 || y < -30 || x > w + 30 || y > h + 30) continue;
        const r = nodeRadius(n) * Math.min(1.6, Math.max(0.7, cam.k));
        const dimmed = hasSel && n.key !== sel && !(nbrs?.has(n.key) ?? false);
        ctx.globalAlpha = dimmed ? 0.22 : 1;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle =
          typeColorsRef.current.get(n.label) ?? fallbackTypeColor(n.label);
        ctx.fill();
        if (n.key === sel) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();
        } else if (hasSel && nbrs?.has(n.key)) {
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = "rgba(255,255,255,0.65)";
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Labels: hubs always, plus selection context, plus more when zoomed in
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      let labeled = 0;
      const sorted = [...list].sort((a, b) => b.degree - a.degree);
      for (const n of sorted) {
        const isSel = n.key === sel;
        const isNbr = nbrs?.has(n.key) ?? false;
        const show =
          isSel || isNbr || n.degree >= 13 || (cam.k > 1.05 && n.degree >= 5);
        if (!show || labeled > 170) continue;
        const x = toX(n.x);
        const y = toY(n.y);
        if (x < -40 || y < -20 || x > w + 40 || y > h + 20) continue;
        const dimmed = hasSel && !isSel && !isNbr;
        ctx.globalAlpha = dimmed ? 0.25 : 0.92;
        const name = n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name;
        const r = nodeRadius(n) * Math.min(1.6, Math.max(0.7, cam.k));
        ctx.fillStyle = "rgba(5, 8, 11, 0.55)";
        const tw = ctx.measureText(name).width;
        ctx.fillRect(x - tw / 2 - 3, y + r + 2, tw + 6, 14);
        ctx.fillStyle = "#dbe4ec";
        ctx.fillText(name, x, y + r + 13);
        labeled++;
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [edges]);

  const pickNode = (px: number, py: number): SimNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const cam = camRef.current;
    const wx = (px - rect.width / 2) / cam.k + cam.x;
    const wy = (py - rect.height / 2) / cam.k + cam.y;
    let best: SimNode | null = null;
    let bestD = Infinity;
    for (const n of simRef.current.values()) {
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const thresh = nodeRadius(n) + 9 / cam.k;
      if (d < thresh && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const p0 = pts[0];
      const p1 = pts[1];
      if (p0 && p1) {
        pinchRef.current = {
          dist: Math.hypot(p0.x - p1.x, p0.y - p1.y),
        };
        dragRef.current = { mode: "pinch", lastX: e.clientX, lastY: e.clientY };
      }
      return;
    }
    const hit = pickNode(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (hit) {
      dragRef.current = {
        mode: "node",
        key: hit.key,
        lastX: e.clientX,
        lastY: e.clientY,
      };
    } else {
      dragRef.current = { mode: "pan", lastX: e.clientX, lastY: e.clientY };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cam = camRef.current;
    if (drag.mode === "pinch" && pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const p0 = pts[0];
      const p1 = pts[1];
      const prev = pinchRef.current;
      if (p0 && p1 && prev) {
        const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
        if (prev.dist > 0) {
          cam.k = Math.min(3.2, Math.max(0.12, cam.k * (dist / prev.dist)));
        }
        pinchRef.current = { dist };
      }
      return;
    }
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    if (drag.mode === "pan") {
      cam.x -= dx / cam.k;
      cam.y -= dy / cam.k;
      camAnimRef.current = null;
    } else if (drag.mode === "node" && drag.key) {
      const n = simRef.current.get(drag.key);
      if (n) {
        n.x += dx / cam.k;
        n.y += dy / cam.k;
        n.vx = 0;
        n.vy = 0;
        relaxFramesRef.current = Math.max(relaxFramesRef.current, 10);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    const drag = dragRef.current;
    dragRef.current = null;
    pinchRef.current = null;
    if (!drag) return;
    if (drag.mode === "node" && drag.key) {
      // A tap (no real travel) selects; dragging just repositions.
      onSelect(drag.key);
    } else if (drag.mode === "pan") {
      const hit = pickNode(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
      if (!hit) onSelect(null);
    }
  };

  const zoomBy = (factor: number) => {
    const cam = camRef.current;
    cam.k = Math.min(3.2, Math.max(0.07, cam.k * factor));
  };

  const resetView = () => {
    fitRef.current();
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden" style={{ background: "var(--canvas)" }}>
      <canvas
        ref={canvasRef}
        className="block touch-none"
        aria-label="Interactive graph canvas. Drag to pan, pinch or use the buttons to zoom, tap a node to inspect it."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(e) => {
          zoomBy(e.deltaY < 0 ? 1.12 : 0.89);
        }}
      />
      <div className="absolute right-2 bottom-2 flex gap-1.5">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => zoomBy(1.3)}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-[#2c3a49] bg-[#131a22]/90 text-lg text-[#dbe4ec]"
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => zoomBy(0.77)}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-[#2c3a49] bg-[#131a22]/90 text-lg text-[#dbe4ec]"
        >
          −
        </button>
        <button
          type="button"
          aria-label="Reset view"
          onClick={resetView}
          className="flex h-9 items-center justify-center rounded-md border border-[#2c3a49] bg-[#131a22]/90 px-2.5 text-xs text-[#dbe4ec]"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const CYPHER_PRESETS: { label: string; statement: string }[] = [
  {
    label: "Count by label",
    statement: "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC",
  },
  {
    label: "Relationship types",
    statement:
      "MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY count DESC",
  },
  {
    label: "Most connected nodes",
    statement:
      "MATCH (n)-[r]-() RETURN n.name AS node, count(r) AS connections ORDER BY connections DESC LIMIT 15",
  },
  {
    label: "Sample nodes",
    statement: "MATCH (n) RETURN labels(n)[0] AS label, n.name AS name LIMIT 20",
  },
];

export function App() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"graph" | "ask" | "activity" | "add">("graph");
  const [search, setSearch] = useState("");
  const [hiddenLabels, setHiddenLabels] = useState<Set<string>>(new Set());
  const [hideIsolated, setHideIsolated] = useState(false);
  const [contentOnly, setContentOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showTime, setShowTime] = useState(false);
  const [walkPath, setWalkPath] = useState<string[]>([]);
  const [walkDepth, setWalkDepth] = useState<1 | 2>(1);
  const [timeMode, setTimeMode] = useState<AsOfMode>("live");
  const [asOfInput, setAsOfInput] = useState<string>(() => toLocalInputValue(new Date()));
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [fitNonce, setFitNonce] = useState(0);
  const [showCypher, setShowCypher] = useState(false);
  const [cypherText, setCypherText] = useState(CYPHER_PRESETS[0]?.statement ?? "");
  const [cypherResult, setCypherResult] = useState<CypherResult | null>(null);
  const [newGraphName, setNewGraphName] = useState("");
  // Ask composer
  type ComposerMode = "ask" | AgentCategory;
  const [composerMode, setComposerMode] = useState<ComposerMode>("ask");
  const [composerText, setComposerText] = useState("");
  const [composerHint, setComposerHint] = useState(false);
  const [composerFiled, setComposerFiled] = useState(false);
  const [nodeJobFiled, setNodeJobFiled] = useState(false);
  // Activity expansions
  const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set());
  const [expandedDecisions, setExpandedDecisions] = useState<Set<string>>(new Set());
  const [decisionKind, setDecisionKind] = useState("all");
  const [filedResolutions, setFiledResolutions] = useState<Record<string, number>>({});
  // Add tab
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [importFiledIds, setImportFiledIds] = useState<Set<number>>(new Set());
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetFiled, setPresetFiled] = useState(false);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const graphsQuery = useQuery({ queryKey: ["graphs"], queryFn: () => api.listGraphs({}), refetchInterval: 15000 });
  const graphList: GraphEntry[] = graphsQuery.data?.graphs ?? [];
  const activeGraphId = graphsQuery.data?.activeGraphId ?? null;
  const activeGraph: GraphEntry | null = graphList.find((g) => g.id === activeGraphId) ?? null;

  const status = useQuery({
    queryKey: ["graph-status", activeGraphId],
    queryFn: () => api.getStatus({}),
    refetchInterval: 15000,
  });

  function resetGraphScopedState() {
    setWalkPath([]);
    setSearch("");
    setCypherResult(null);
    setHiddenLabels(new Set());
    setHideIsolated(false);
    setContentOnly(false);
    setUploadError(null);
    setPresetError(null);
    setPresetFiled(false);
    setImportFiledIds(new Set());
    setDecisionKind("all");
    setFiledResolutions({});
    setComposerFiled(false);
    setNodeJobFiled(false);
    setFitNonce((n) => n + 1);
  }

  const switchGraph = useMutation({
    mutationFn: async (graphId: number) => await api.setActiveGraph({ graphId }),
    onSuccess: () => { resetGraphScopedState(); queryClient.invalidateQueries(); },
  });
  const createGraphMut = useMutation({
    mutationFn: async (name: string) => await api.createGraph({ name }),
    onSuccess: () => { setNewGraphName(""); resetGraphScopedState(); queryClient.invalidateQueries(); },
  });
  const submitNewGraph = () => {
    const name = newGraphName.trim();
    if (!name || createGraphMut.isPending) return;
    createGraphMut.mutate(name);
  };

  const asOfIso = useMemo(() => {
    if (timeMode === "live") return null;
    const d = new Date(asOfInput);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [timeMode, asOfInput]);

  const graph = useQuery({
    queryKey: ["relate-graph", activeGraphId, timeMode, asOfIso],
    queryFn: () => api.getGraph({ asOfMode: timeMode, asOf: asOfIso }),
    staleTime: 30000,
  });

  const cypherRun = useMutation({
    mutationFn: async (statement: string) => await api.runCypher({ statement }),
    onSuccess: (res) => setCypherResult(res),
  });

  const requests = useQuery({
    queryKey: ["agent-requests", activeGraphId],
    queryFn: () => api.listAgentRequests({ limit: 20 }),
    refetchInterval: 8000,
  });
  const requestList: AgentRequest[] = requests.data?.requests ?? [];
  const liveRequestCount = requestList.filter((r) => r.status === "requested" || r.status === "running").length;

  const dispatchMut = useMutation({
    mutationFn: async (input: { category: AgentCategory; task: string; nodeKey: string | null; nodeName: string | null }) =>
      await api.dispatchAgentTask(input),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["agent-requests"] }); },
  });

  const chat = useQuery({
    queryKey: ["chat-messages", activeGraphId],
    queryFn: () => api.listChatMessages({}),
    refetchInterval: 8000,
  });
  const chatThread: ChatMessage[] = chat.data?.messages ?? [];
  const sendChatMsg = useMutation({
    mutationFn: async (text: string) => await api.sendChatMessage({ text }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["chat-messages"] }); },
  });
  useEffect(() => {
    const el = chatThreadRef.current;
    if (el && activeTab === "ask") el.scrollTop = el.scrollHeight;
  }, [chatThread.length, activeTab]);

  const uploads = useQuery({ queryKey: ["uploads", activeGraphId], queryFn: () => api.listUploads({}) });
  const uploadList: UploadMeta[] = uploads.data?.uploads ?? [];
  const uploadMut = useMutation({
    mutationFn: async (input: { filename: string; mime: string; contentText: string; graphId: number | null }) => await api.uploadFile(input),
    onSuccess: (res) => {
      if (res.ok) { setUploadError(null); queryClient.invalidateQueries({ queryKey: ["uploads"] }); }
      else setUploadError(res.error ?? "Upload was rejected.");
    },
    onError: () => setUploadError("The upload could not be stored — try again."),
  });
  const onPickUploadFile = async (file: File) => {
    setUploadError(null);
    let text: string;
    try { text = await file.text(); } catch { setUploadError(`"${file.name}" could not be read as text.`); return; }
    if (text.length > UPLOAD_MAX_CHARS) {
      setUploadError(`"${file.name}" is ${text.length.toLocaleString()} characters — over the ${UPLOAD_MAX_CHARS.toLocaleString()}-character upload cap. Nothing was stored.`);
      return;
    }
    uploadMut.mutate({ filename: file.name, mime: file.type, contentText: text, graphId: activeGraphId });
  };

  const presets = useQuery({ queryKey: ["ontology-presets"], queryFn: () => api.listOntologyPresets({}) });
  const presetList: OntologyPreset[] = presets.data?.presets ?? [];
  const applyPresetMut = useMutation({
    mutationFn: async (presetId: string) => await api.applyOntologyPreset({ presetId }),
    onSuccess: (res) => {
      if (res.ok) { setPresetError(null); setPresetFiled(true); queryClient.invalidateQueries({ queryKey: ["agent-requests"] }); }
      else setPresetError(res.error ?? "The preset could not be applied.");
    },
    onError: () => setPresetError("The preset could not be applied — try again."),
  });

  const reviewItems = useQuery({
    queryKey: ["review-items", activeGraphId],
    queryFn: () => api.listReviewItems({}),
    refetchInterval: 15000,
  });
  const reviewList: ReviewItem[] = reviewItems.data?.items ?? [];
  const decisions = useQuery({
    queryKey: ["decisions", activeGraphId],
    queryFn: () => api.listDecisions({}),
    refetchInterval: 15000,
  });
  const decisionList: Decision[] = decisions.data?.decisions ?? [];
  const decisionKinds = useMemo(() => [...new Set(decisionList.map((d) => d.kind))].sort(), [decisionList]);
  const shownDecisions = decisionKind === "all" ? decisionList : decisionList.filter((d) => d.kind === decisionKind);
  const resolveReview = useMutation({
    mutationFn: async (input: { id: string; choice: string }) => await api.resolveReviewItem({ id: input.id, choice: input.choice }),
    onSuccess: (res, vars) => {
      setFiledResolutions((prev) => ({ ...prev, [vars.id]: res.requestId }));
      queryClient.invalidateQueries({ queryKey: ["agent-requests"] });
    },
  });

  const activityBadge = liveRequestCount + reviewList.length;

  // ---- graph data / walking (unchanged behavior) ----
  const data = graph.data;
  const allNodes = useMemo(() => data?.nodes ?? [], [data]);
  const allEdges = useMemo(() => data?.edges ?? [], [data]);
  const nodeByKey = useMemo(() => new Map(allNodes.map((n) => [n.key, n])), [allNodes]);
  const filterTypes = useMemo(() => data?.filterTypes ?? [], [data]);
  const typeColorMap = useMemo(() => new Map(filterTypes.map((t) => [t.name, t.color])), [filterTypes]);
  const colorForLabel = (label: string): string => typeColorMap.get(label) ?? fallbackTypeColor(label);
  const isolatedCount = useMemo(() => allNodes.filter((n) => n.degree === 0).length, [allNodes]);

  const effectiveHidden = useMemo(() => {
    const s = new Set(hiddenLabels);
    if (contentOnly) {
      for (const ft of filterTypes) {
        if (ft.kind === "system" || ft.name === "SpaceSignal") s.add(ft.name);
      }
      s.add("SpaceSignal");
    }
    return s;
  }, [hiddenLabels, contentOnly, filterTypes]);

  const visibleNodes = useMemo(
    () => allNodes.filter((n) => !effectiveHidden.has(n.label) && !(hideIsolated && n.degree === 0)),
    [allNodes, effectiveHidden, hideIsolated],
  );
  const visibleKeys = useMemo(() => new Set(visibleNodes.map((n) => n.key)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => allEdges.filter((e) => visibleKeys.has(e.from) && visibleKeys.has(e.to)),
    [allEdges, visibleKeys],
  );
  const focusedKey: string | null = walkPath[walkPath.length - 1] ?? null;

  const brightKeys = useMemo(() => {
    if (!focusedKey) return null;
    const set = new Set<string>([focusedKey]);
    let frontier: string[] = [focusedKey];
    for (let hop = 0; hop < walkDepth; hop++) {
      const next: string[] = [];
      for (const key of frontier) {
        for (const e of visibleEdges) {
          const other = e.from === key ? e.to : e.to === key ? e.from : null;
          if (other != null && !set.has(other)) { set.add(other); next.push(other); }
        }
      }
      frontier = next;
    }
    return set;
  }, [focusedKey, walkDepth, visibleEdges]);

  const neighborGroups = useMemo(() => {
    if (!focusedKey) return [];
    const groups = new Map<string, { type: string; direction: "out" | "in"; neighbors: GNode[] }>();
    for (const e of visibleEdges) {
      let otherKey: string | null = null;
      let direction: "out" | "in" | null = null;
      if (e.from === focusedKey) { otherKey = e.to; direction = "out"; }
      else if (e.to === focusedKey) { otherKey = e.from; direction = "in"; }
      if (otherKey == null || direction == null) continue;
      const node = nodeByKey.get(otherKey);
      if (!node || !visibleKeys.has(otherKey)) continue;
      const gk = `${direction}:${e.type}`;
      let g = groups.get(gk);
      if (!g) { g = { type: e.type, direction, neighbors: [] }; groups.set(gk, g); }
      if (!g.neighbors.some((n) => n.key === otherKey)) g.neighbors.push(node);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, neighbors: [...g.neighbors].sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => (a.direction === b.direction ? a.type.localeCompare(b.type) : a.direction === "out" ? -1 : 1));
  }, [focusedKey, visibleEdges, nodeByKey, visibleKeys]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return allNodes
      .filter((n) => n.name.toLowerCase().includes(q) || n.key.toLowerCase().includes(q) ||
        (typeof n.props["handle"] === "string" && n.props["handle"].toLowerCase().includes(q)))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 9);
  }, [search, allNodes]);

  const chooseNode = (key: string) => {
    setWalkPath((prev) => {
      const idx = prev.indexOf(key);
      if (idx >= 0) return prev.slice(0, idx + 1);
      return [...prev, key];
    });
    setFocusKey(key);
    setFocusNonce((n) => n + 1);
    setSearch("");
    setNodeJobFiled(false);
    const node = nodeByKey.get(key);
    if (node && hiddenLabels.has(node.label)) {
      setHiddenLabels((prev) => { const next = new Set(prev); next.delete(node.label); return next; });
    }
    if (node && hideIsolated && node.degree === 0) setHideIsolated(false);
  };
  const walkBack = () => {
    setWalkPath((prev) => {
      const next = prev.slice(0, -1);
      const back = next[next.length - 1];
      if (back) { setFocusKey(back); setFocusNonce((n) => n + 1); }
      return next;
    });
  };
  const exitWalk = () => { setWalkPath([]); setFitNonce((n) => n + 1); };

  const fetchedAt = data?.fetchedAt;
  useEffect(() => {
    if (!fetchedAt) return;
    setWalkPath((prev) => {
      if (prev.length === 0) return prev;
      const kept = prev.filter((k) => nodeByKey.has(k));
      return kept.length === prev.length ? prev : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedAt]);

  const toggleLabel = (label: string) => {
    setHiddenLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
    setFitNonce((n) => n + 1);
  };

  const selectedNode: GNode | null = (focusedKey ? nodeByKey.get(focusedKey) : undefined) ?? null;
  const selectedTemporal = selectedNode
    ? TEMPORAL_PROP_KEYS.filter((k) => selectedNode.props[k] != null)
    : [];
  const orderedSelectedProps = selectedNode ? orderNodeProps(selectedNode.props) : [];

  const fileNodeJob = (category: AgentCategory, jobLabel: string) => {
    if (!selectedNode || dispatchMut.isPending) return;
    dispatchMut.mutate(
      {
        category,
        task: `${jobLabel} the node "${selectedNode.name}" (${selectedNode.label}, key ${selectedNode.key}) in this graph. Report what changed, with counts where relevant.`,
        nodeKey: selectedNode.key,
        nodeName: selectedNode.name,
      },
      { onSuccess: () => setNodeJobFiled(true) },
    );
  };

  // ---- Ask composer ----
  const COMPOSER_MODES: { id: ComposerMode; label: string }[] = [
    { id: "ask", label: "Ask" },
    { id: "import", label: "Import" },
    { id: "ontology", label: "Ontology" },
    { id: "categorizing", label: "Categorize" },
    { id: "normalization", label: "Normalize" },
    { id: "embeddings", label: "Embed" },
    { id: "processing", label: "Process" },
    { id: "cleaning", label: "Clean" },
    { id: "communities", label: "Communities" },
    { id: "query", label: "Query" },
    { id: "dream", label: "Dream" },
  ];
  const submitComposer = () => {
    const text = composerText.trim();
    setComposerFiled(false);
    if (composerMode === "ask") {
      if (!text) { setComposerHint(true); return; }
      setComposerHint(false);
      sendChatMsg.mutate(text, { onSuccess: () => setComposerText("") });
      return;
    }
    if (composerMode === "dream" && text.length === 0) {
      setComposerHint(false);
      dispatchMut.mutate(
        { category: "dream", task: DREAM_TASK, nodeKey: null, nodeName: null },
        { onSuccess: () => { setComposerText(""); setComposerFiled(true); } },
      );
      return;
    }
    if (!text) { setComposerHint(true); return; }
    setComposerHint(false);
    dispatchMut.mutate(
      { category: composerMode, task: text, nodeKey: null, nodeName: null },
      { onSuccess: () => { setComposerText(""); setComposerFiled(true); } },
    );
  };

  // ---- plain-language helpers ----
  const CATEGORY_LABELS: Record<AgentCategory, string> = {
    import: "Import",
    ontology: "Ontology",
    categorizing: "Categorize",
    normalization: "Normalize",
    embeddings: "Embed",
    processing: "Process",
    cleaning: "Cleaning",
    communities: "Communities",
    query: "Query",
    dream: "Dream — consolidate this graph",
  };
  const STATUS_WORDS: Record<AgentRequest["status"], string> = {
    requested: "Waiting",
    running: "Running",
    done: "Done",
    failed: "Failed",
  };
  const STATUS_COLORS: Record<AgentRequest["status"], string> = {
    requested: "#f5b04c",
    running: "#58a6ff",
    done: "#3fb950",
    failed: "#ff7b72",
  };
  const elapsedText = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms) || ms < 0) return "";
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "under a minute";
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hr ${mins % 60} min`;
    return `${Math.floor(hrs / 24)} days`;
  };
  const reviewKindLabel = (kind: string): string => {
    const k = kind.toLowerCase();
    if (k.includes("duplicate") || k.includes("merge")) return "Possible duplicate";
    if (k.includes("conflict") || k.includes("contradict")) return "Conflicting facts";
    if (k.includes("confidence") || k.includes("low")) return "Low confidence";
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  };
  const decisionKindLabel = (kind: string): string => {
    const map: Record<string, string> = {
      stamp: "Ontology applied",
      reconcile: "Duplicates merged",
      merge: "Two nodes merged",
      resolve: "Review resolved",
    };
    return map[kind.toLowerCase()] ?? (kind.charAt(0).toUpperCase() + kind.slice(1));
  };

  const coverage = data?.temporalCoverage;
  const coverageAllZero = coverage != null &&
    coverage.nodesWithValidTime === 0 && coverage.nodesWithTransactionTime === 0 &&
    coverage.edgesWithValidTime === 0 && coverage.edgesWithTransactionTime === 0;

  const tabBtn = (id: typeof activeTab, label: string) => (
    <button
      key={id}
      type="button"
      aria-pressed={activeTab === id}
      aria-label={id === "activity" && activityBadge > 0 ? `Activity, ${activityBadge} things need attention` : label}
      onClick={() => setActiveTab(id)}
      className={`min-h-[44px] flex-1 rounded-md px-2 text-sm whitespace-nowrap ${
        activeTab === id ? "bg-[var(--accent)] font-semibold text-[#06251f]" : "text-[var(--text)]"
      }`}
    >
      {id === "activity" && activityBadge > 0 ? `Activity · ${activityBadge}` : label}
    </button>
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      {/* Top bar: graph switcher + size + tabs */}
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-3 pt-3 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="graph-picker" className="text-sm font-medium">Graph</label>
          <select
            id="graph-picker"
            aria-label="Choose a graph"
            value={activeGraphId ?? ""}
            disabled={switchGraph.isPending || graphList.length === 0}
            onChange={(e) => {
              const id = Number(e.target.value);
              if (id && id !== activeGraphId) switchGraph.mutate(id);
            }}
            className="min-h-[44px] max-w-64 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-2 text-sm text-[var(--text)]"
          >
            {graphList.length === 0 && <option value="">Loading…</option>}
            {graphList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.status !== "live"
                  ? " — Still being set up"
                  : g.nodeCount != null
                    ? ` — ${g.nodeCount} items · ${g.edgeCount ?? 0} links`
                    : ""}
              </option>
            ))}
          </select>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => { e.preventDefault(); submitNewGraph(); }}
          >
            <label htmlFor="new-graph-name" className="sr-only">New graph name</label>
            <input
              id="new-graph-name"
              value={newGraphName}
              onChange={(e) => setNewGraphName(e.target.value)}
              placeholder="New graph name"
              className="min-h-[44px] w-32 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-2.5 text-sm text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
            />
            <button
              type="submit"
              disabled={createGraphMut.isPending || newGraphName.trim().length === 0}
              className="min-h-[44px] shrink-0 rounded-md border border-[var(--border)] px-3 text-sm whitespace-nowrap disabled:opacity-50"
            >
              {createGraphMut.isPending ? "Creating…" : "New graph"}
            </button>
          </form>
        </div>
        {createGraphMut.isError && <p className="mt-1 text-sm text-[#ff7b72]">Could not create the graph — try again.</p>}
        {switchGraph.isError && <p className="mt-1 text-sm text-[#ff7b72]">Could not switch graphs — try again.</p>}

        <div className="mt-1.5 min-h-[20px] text-sm text-[var(--dim)]" aria-live="polite">
          {activeGraph == null ? (
            "Loading…"
          ) : activeGraph.status !== "live" ? (
            <span>{activeGraph.name} — Still being set up</span>
          ) : status.isPending ? (
            "Loading…"
          ) : status.data?.live ? (
            <span>{status.data.graphName} · {status.data.nodeCount ?? 0} items · {status.data.edgeCount ?? 0} links</span>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[#ff7b72]">{status.data?.error ?? "This graph could not be reached."}</span>
              <button
                type="button"
                onClick={() => { status.refetch(); graph.refetch(); }}
                className="min-h-[44px] rounded-md border border-[var(--border)] px-3 text-sm text-[var(--text)]"
              >
                Retry
              </button>
            </span>
          )}
        </div>

        <nav aria-label="Sections" className="mt-2 flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-alt)] p-1">
          {tabBtn("graph", "Graph")}
          {tabBtn("ask", "Ask")}
          {tabBtn("activity", "Activity")}
          {tabBtn("add", "Add")}
        </nav>
      </header>

      {/* ================= GRAPH TAB ================= */}
      {activeTab === "graph" && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-44 flex-1">
                <input
                  aria-label="Search by name"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name…"
                  className="min-h-[44px] w-full rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 text-sm text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
                />
                {searchResults.length > 0 && (
                  <ul className="absolute inset-x-0 top-12 z-30 max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-xl">
                    {searchResults.map((n) => (
                      <li key={n.key}>
                        <button
                          type="button"
                          onClick={() => chooseNode(n.key)}
                          className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-alt)]"
                        >
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorForLabel(n.label) }} />
                          <span className="min-w-0 flex-1 truncate">{n.name}</span>
                          <span className="shrink-0 text-xs text-[var(--dim)]">{n.label} · {n.degree} links</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                type="button"
                aria-expanded={showFilters}
                onClick={() => setShowFilters((v) => !v)}
                className={`min-h-[44px] shrink-0 rounded-md border px-3 text-sm ${showFilters ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)]"}`}
              >
                Filter types
              </button>
              <button
                type="button"
                aria-expanded={showTime}
                onClick={() => setShowTime((v) => !v)}
                className={`min-h-[44px] shrink-0 rounded-md border px-3 text-sm ${showTime ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)]"}`}
              >
                View as of a past time
              </button>
              <button
                type="button"
                aria-label="Reload the graph"
                onClick={() => { graph.refetch(); status.refetch(); graphsQuery.refetch(); }}
                className="min-h-[44px] shrink-0 rounded-md border border-[var(--border)] px-3 text-sm"
              >
                Reload
              </button>
            </div>

            {showFilters && (
              <div className="mt-2">
                <button
                  type="button"
                  aria-pressed={contentOnly}
                  onClick={() => { setContentOnly((v) => !v); setFitNonce((n) => n + 1); }}
                  className={`flex min-h-[44px] items-center gap-2 rounded-md border px-3 text-sm ${contentOnly ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)]"}`}
                >
                  <span className={`flex h-5 w-9 items-center rounded-full px-0.5 ${contentOnly ? "justify-end bg-[var(--accent)]" : "justify-start bg-[var(--border)]"}`}>
                    <span className="h-4 w-4 rounded-full bg-white" />
                  </span>
                  Content only — hide the bookkeeping types
                </button>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {filterTypes.length === 0 && <span className="text-sm text-[var(--dim)]">Loading…</span>}
                  {filterTypes.map((ft) => {
                    const hidden = hiddenLabels.has(ft.name);
                    const isSystem = ft.kind === "system";
                    const empty = ft.count === 0;
                    return (
                      <button
                        key={ft.name}
                        type="button"
                        aria-pressed={!hidden}
                        aria-label={`${hidden ? "Show" : "Hide"} ${ft.name}${isSystem ? " (system type)" : ""}`}
                        onClick={() => toggleLabel(ft.name)}
                        className={`flex min-h-[44px] items-center gap-1.5 rounded-full border px-3 text-sm ${isSystem ? "border-dashed " : ""}${hidden ? "border-[var(--border)] text-[var(--dim)] opacity-55" : "border-[var(--border)] text-[var(--text)]"}`}
                      >
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: ft.color, opacity: empty ? 0.45 : 1 }} />
                        {ft.name}
                        {isSystem && <span className="text-[10px] tracking-wide text-[var(--dim)] uppercase">system</span>}
                        <span className="text-xs text-[var(--dim)]">{ft.count}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    aria-pressed={hideIsolated}
                    onClick={() => { setHideIsolated((v) => !v); setFitNonce((n) => n + 1); }}
                    className={`min-h-[44px] rounded-full border px-3 text-sm ${hideIsolated ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--dim)]"}`}
                  >
                    Hide unlinked ({isolatedCount})
                  </button>
                </div>
              </div>
            )}

            {showTime && (
              <div className="mt-2">
                <div role="group" aria-label="Which time to use" className="flex flex-wrap gap-1.5">
                  {([
                    { mode: "live", label: "Live" },
                    { mode: "valid", label: "Valid time" },
                    { mode: "recorded", label: "Recorded time" },
                  ] as { mode: AsOfMode; label: string }[]).map(({ mode, label }) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={timeMode === mode}
                      onClick={() => setTimeMode(mode)}
                      className={`min-h-[44px] rounded-md border px-3 text-sm ${timeMode === mode ? "border-[var(--accent)] bg-[var(--accent)] font-medium text-[#06251f]" : "border-[var(--border)]"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {timeMode !== "live" && (
                  <div className="mt-2 flex items-center gap-2">
                    <label htmlFor="as-of-input" className="text-sm text-[var(--dim)]">Show as of</label>
                    <input
                      id="as-of-input"
                      type="datetime-local"
                      aria-label="Date and time to view the graph as of"
                      value={asOfInput}
                      onChange={(e) => setAsOfInput(e.target.value)}
                      className="min-h-[44px] rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                )}
                {data?.graphStatus === "live" && coverage != null && (
                  <p className="mt-2 text-sm text-[var(--dim)]">
                    {coverageAllZero
                      ? "No dates are stored in this graph yet — everything is shown without a time limit."
                      : `${coverage.nodesWithValidTime} items and ${coverage.edgesWithValidTime} links have valid-time dates; ${coverage.nodesWithTransactionTime} items and ${coverage.edgesWithTransactionTime} links have recorded-time dates.`}
                  </p>
                )}
              </div>
            )}

            {timeMode !== "live" && (
              <p className="mt-2 rounded-md border border-[var(--accent)] px-3 py-2 text-sm">
                Viewing the graph as of {formatInstant(asOfIso ?? asOfInput)} ({timeMode === "valid" ? "valid time" : "recorded time"}).{" "}
                <button type="button" className="underline" onClick={() => setTimeMode("live")}>Back to live</button>
              </p>
            )}

            {walkPath.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={walkBack} disabled={walkPath.length === 0} className="min-h-[44px] rounded-md border border-[var(--border)] px-3 text-sm disabled:opacity-50">Back</button>
                <button type="button" onClick={exitWalk} className="min-h-[44px] rounded-md border border-[var(--border)] px-3 text-sm">Reset view</button>
                <div role="group" aria-label="How far around the tapped item to show" className="flex overflow-hidden rounded-md border border-[var(--border)]">
                  {([1, 2] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={walkDepth === d}
                      onClick={() => setWalkDepth(d)}
                      className={`min-h-[44px] px-3 text-sm ${walkDepth === d ? "bg-[var(--accent)] font-medium text-[#06251f]" : ""}`}
                    >
                      {d} hop{d === 2 ? "s" : ""}
                    </button>
                  ))}
                </div>
                <nav aria-label="Where you have walked" className="flex min-w-0 flex-wrap items-center gap-1">
                  {walkPath.map((k, i) => {
                    const n = nodeByKey.get(k);
                    return (
                      <span key={`${k}-${i}`} className="flex items-center gap-1">
                        {i > 0 && <span aria-hidden="true" className="text-[var(--dim)]">›</span>}
                        <button
                          type="button"
                          onClick={() => chooseNode(k)}
                          aria-current={i === walkPath.length - 1 ? "true" : undefined}
                          className={`min-h-[44px] max-w-40 truncate rounded-md px-2 text-sm ${i === walkPath.length - 1 ? "font-semibold text-[var(--accent)]" : "text-[var(--dim)] underline"}`}
                        >
                          {n?.name ?? k}
                        </button>
                      </span>
                    );
                  })}
                </nav>
              </div>
            )}
          </div>

          <div className="relative min-h-0 flex-1">
            {graph.isPending ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--dim)]">Loading…</div>
            ) : graph.isError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="text-sm text-[#ff7b72]">This graph could not be loaded. {graph.error instanceof Error ? graph.error.message : ""}</p>
                <button type="button" onClick={() => graph.refetch()} className="min-h-[44px] rounded-md border border-[var(--border)] px-4 text-sm">Retry</button>
              </div>
            ) : data?.graphStatus === "provisioning" ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--dim)]">
                {data.graphName} is still being set up — its database is being started.
              </div>
            ) : allNodes.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--dim)]">
                Nothing in this graph yet — add a file, or ask the agent to import one.
              </div>
            ) : (
              <GraphCanvas
                nodes={visibleNodes}
                edges={visibleEdges}
                typeColors={typeColorMap}
                selectedKey={focusedKey}
                neighborKeys={brightKeys}
                focusKey={focusKey}
                focusNonce={focusNonce}
                fitNonce={fitNonce}
                onSelect={(key) => { if (key) chooseNode(key); else exitWalk(); }}
              />
            )}
            {data?.graphStatus === "live" && allNodes.length > 0 && visibleNodes.length === 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-4">
                <p className="rounded-md bg-[var(--surface)] px-3 py-2 text-center text-sm text-[var(--dim)]">Everything is filtered out — open Filter types and turn some types back on.</p>
              </div>
            )}

            {/* Node detail slide-over sheet */}
            {selectedNode && (
              <section
                aria-label={`Details for ${selectedNode.name}`}
                className="absolute inset-x-0 bottom-0 z-20 max-h-[72%] overflow-y-auto rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface)] px-4 pt-3 pb-5 shadow-2xl md:inset-x-auto md:right-0 md:bottom-0 md:max-h-none md:h-full md:w-96 md:rounded-none md:border-t-0 md:border-l"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold break-words">{selectedNode.name}</h2>
                    <p className="mt-0.5 flex items-center gap-1.5 text-sm text-[var(--dim)]">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorForLabel(selectedNode.label) }} />
                      {selectedNode.label} · {selectedNode.degree} links
                    </p>
                  </div>
                  <button type="button" onClick={exitWalk} aria-label="Close details" className="min-h-[44px] shrink-0 rounded-md border border-[var(--border)] px-3 text-sm">Close</button>
                </div>

                {orderedSelectedProps.length > 0 && (
                  <dl className="mt-3 space-y-1">
                    {orderedSelectedProps.map(({ key, value, machine }) => (
                      <NodePropRow
                        key={`${selectedNode.key}:${key}`}
                        propKey={key}
                        value={value}
                        allProps={selectedNode.props}
                        machine={machine}
                      />
                    ))}
                  </dl>
                )}

                {selectedTemporal.length > 0 && (
                  <div className="mt-4">
                    <h3 className="text-sm font-semibold">Time</h3>
                    <dl className="mt-1 space-y-1">
                      {selectedTemporal.map((k) => (
                        <div key={k} className="flex gap-2 text-sm">
                          <dt className="shrink-0 text-[var(--dim)]">{k}</dt>
                          <dd className="break-words">{formatInstant(String(selectedNode.props[k]))}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}

                <div className="mt-4">
                  <h3 className="text-sm font-semibold">Connected to</h3>
                  {neighborGroups.length === 0 ? (
                    <p className="mt-1 text-sm text-[var(--dim)]">Nothing is linked to this item in the current view.</p>
                  ) : (
                    neighborGroups.map((g) => (
                      <div key={`${g.direction}:${g.type}`} className="mt-2">
                        <p className="text-xs text-[var(--dim)]">{g.direction === "out" ? "Links to" : "Linked from"} · {g.type}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {g.neighbors.map((n) => (
                            <button
                              key={n.key}
                              type="button"
                              onClick={() => chooseNode(n.key)}
                              className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-[var(--border)] px-3 text-sm"
                            >
                              <span className="h-2 w-2 rounded-full" style={{ background: colorForLabel(n.label) }} />
                              <span className="max-w-44 truncate">{n.name}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-4">
                  <h3 className="text-sm font-semibold">Jobs for this node</h3>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button type="button" disabled={dispatchMut.isPending} onClick={() => fileNodeJob("cleaning", "Clean up")} className="min-h-[44px] rounded-md border border-[var(--border)] px-3 text-sm disabled:opacity-50">Clean up</button>
                    <button type="button" disabled={dispatchMut.isPending} onClick={() => fileNodeJob("categorizing", "Categorize")} className="min-h-[44px] rounded-md border border-[var(--border)] px-3 text-sm disabled:opacity-50">Categorize</button>
                    <button type="button" disabled={dispatchMut.isPending} onClick={() => fileNodeJob("embeddings", "Embed")} className="min-h-[44px] rounded-md border border-[var(--border)] px-3 text-sm disabled:opacity-50">Embed</button>
                  </div>
                  {nodeJobFiled && <p className="mt-1.5 text-sm text-[var(--accent)]">Filed — watch it under Activity</p>}
                  {dispatchMut.isError && <p className="mt-1.5 text-sm text-[#ff7b72]">Could not file the job — try again.</p>}
                </div>
              </section>
            )}
          </div>

          {/* Advanced Cypher disclosure */}
          <div className="border-t border-[var(--border)] bg-[var(--surface)]">
            <button
              type="button"
              aria-expanded={showCypher}
              onClick={() => setShowCypher((v) => !v)}
              className="flex min-h-[44px] w-full items-center px-3 text-left text-sm font-medium"
            >
              Advanced — run a query
            </button>
            {showCypher && (
              <div className="max-h-[46dvh] overflow-y-auto px-3 pb-3">
                <div className="flex flex-wrap gap-1.5">
                  {CYPHER_PRESETS.map((p) => (
                    <button key={p.label} type="button" onClick={() => setCypherText(p.statement)} className="min-h-[44px] rounded-full border border-[var(--border)] px-3 text-sm text-[var(--dim)]">{p.label}</button>
                  ))}
                </div>
                <label htmlFor="cypher-input" className="mt-2 block text-sm text-[var(--dim)]">Read-only query — runs against {activeGraph?.name ?? "the active graph"}</label>
                <textarea
                  id="cypher-input"
                  value={cypherText}
                  onChange={(e) => setCypherText(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={cypherRun.isPending || cypherText.trim().length === 0}
                    onClick={() => cypherRun.mutate(cypherText)}
                    className="min-h-[44px] rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-[#06251f] disabled:opacity-50"
                  >
                    {cypherRun.isPending ? "Running…" : "Run query"}
                  </button>
                  {cypherResult?.ok && <span className="text-xs text-[var(--dim)]">{cypherResult.rowCount} rows{cypherResult.truncated ? " (first 200 shown)" : ""}</span>}
                </div>
                {cypherResult && !cypherResult.ok && <p className="mt-2 text-sm text-[#ff7b72]">{cypherResult.error}</p>}
                {cypherResult?.ok && cypherResult.fields.length > 0 && (
                  <div className="mt-2 overflow-x-auto rounded-md border border-[var(--border)]">
                    <table className="w-full border-collapse font-mono text-xs">
                      <thead>
                        <tr className="bg-[var(--surface-alt)] text-left">
                          {cypherResult.fields.map((f) => <th key={f} className="px-2 py-1.5 font-medium whitespace-nowrap">{f}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {cypherResult.rows.map((row, i) => (
                          <tr key={i} className="border-t border-[var(--border)]">
                            {row.map((cell, j) => <td key={j} className="max-w-56 truncate px-2 py-1.5" title={cell}>{cell}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= ASK TAB ================= */}
      {activeTab === "ask" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={chatThreadRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {chat.isPending ? (
              <p className="text-sm text-[var(--dim)]">Loading…</p>
            ) : chat.isError ? (
              <div>
                <p className="text-sm text-[#ff7b72]">The conversation could not be loaded.</p>
                <button type="button" onClick={() => chat.refetch()} className="mt-2 min-h-[44px] rounded-md border border-[var(--border)] px-4 text-sm">Retry</button>
              </div>
            ) : chatThread.length === 0 ? (
              <p className="text-sm text-[var(--dim)]">No messages yet. Ask a question below, or pick a job and write what you want done.</p>
            ) : (
              chatThread.map((m: ChatMessage) =>
                m.role === "user" ? (
                  <div key={m.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-lg rounded-br-sm border border-[var(--accent)] bg-[var(--surface)] px-3 py-2">
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.text}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--dim)]">
                        <span>You · {formatTime(m.createdAt)}</span>
                        {m.status === "awaiting-agent" && <span style={{ color: "#f5b04c" }}>Waiting for the agent</span>}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="flex justify-start">
                    <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                      <p className="text-[11px] text-[var(--accent)]">Agent · {formatTime(m.createdAt)}</p>
                      <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap">{m.text}</p>
                    </div>
                  </div>
                ),
              )
            )}
          </div>

          <div className="border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
            <div role="group" aria-label="What to send" className="flex flex-wrap gap-1.5">
              {COMPOSER_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={composerMode === m.id}
                  onClick={() => { setComposerMode(m.id); setComposerHint(false); setComposerFiled(false); }}
                  className={`min-h-[44px] rounded-full border px-3 text-sm ${composerMode === m.id ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-[#06251f]" : "border-[var(--border)]"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PIPELINE_PRESETS.map((p) => (
                <button
                  key={p.category}
                  type="button"
                  onClick={() => { setComposerMode(p.category); setComposerText(p.task); setComposerHint(false); setComposerFiled(false); }}
                  className="min-h-[36px] rounded-full border border-dashed border-[var(--border)] px-2.5 text-xs text-[var(--dim)]"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <form
              className="mt-2 flex items-end gap-2"
              onSubmit={(e) => { e.preventDefault(); submitComposer(); }}
            >
              <label htmlFor="composer-input" className="sr-only">
                {composerMode === "ask" ? "Message for the agent" : "What you want done"}
              </label>
              <textarea
                id="composer-input"
                value={composerText}
                onChange={(e) => { setComposerText(e.target.value); setComposerFiled(false); }}
                rows={2}
                placeholder={composerMode === "ask" ? "Ask the agent…" : composerMode === "dream" ? "Leave empty to run a full dream pass…" : "Write what you want done…"}
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
              />
              <button
                type="submit"
                disabled={sendChatMsg.isPending || dispatchMut.isPending}
                className="min-h-[44px] shrink-0 rounded-md bg-[var(--accent)] px-4 text-sm font-semibold whitespace-nowrap text-[#06251f] disabled:opacity-50"
              >
                {sendChatMsg.isPending || dispatchMut.isPending ? "Sending…" : "Send"}
              </button>
            </form>
            {composerHint && <p className="mt-1.5 text-sm text-[#f5b04c]">Write what you want done, then tap Send</p>}
            {composerFiled && <p className="mt-1.5 text-sm text-[var(--accent)]">Filed — watch it under Activity</p>}
            {sendChatMsg.isError && <p className="mt-1.5 text-sm text-[#ff7b72]">Message could not be sent — try again.</p>}
            {dispatchMut.isError && composerMode !== "ask" && <p className="mt-1.5 text-sm text-[#ff7b72]">Could not file the job — try again.</p>}
          </div>
        </div>
      )}

      {/* ================= ACTIVITY TAB ================= */}
      {activeTab === "activity" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <h2 className="text-base font-semibold">Jobs</h2>
          {requests.isPending ? (
            <p className="mt-1 text-sm text-[var(--dim)]">Loading…</p>
          ) : requests.isError ? (
            <div>
              <p className="mt-1 text-sm text-[#ff7b72]">Jobs could not be loaded.</p>
              <button type="button" onClick={() => requests.refetch()} className="mt-2 min-h-[44px] rounded-md border border-[var(--border)] px-4 text-sm">Retry</button>
            </div>
          ) : requestList.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--dim)]">No jobs yet. File one from the Ask tab.</p>
          ) : (
            <ul className="mt-1 divide-y divide-[var(--border)]">
              {requestList.map((r) => {
                const lines = (r.result ?? "").split("\n");
                const long = (r.result ?? "").length > 240 || lines.length > 3;
                const expanded = expandedResults.has(r.id);
                const shownResult = r.result == null ? null : long && !expanded ? lines.slice(0, 3).join("\n") : r.result;
                return (
                  <li key={r.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border px-2.5 py-1 text-xs font-medium" style={{ color: STATUS_COLORS[r.status], borderColor: STATUS_COLORS[r.status] }}>
                        {STATUS_WORDS[r.status]}{r.status === "running" ? ` · ${elapsedText(r.createdAt)}` : ""}
                      </span>
                      <span className="text-sm font-medium">{CATEGORY_LABELS[r.category]}</span>
                      <span className="text-xs text-[var(--dim)]">Filed {formatInstant(r.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-sm break-words">{r.task}</p>
                    {r.nodeKey && <p className="mt-0.5 text-xs text-[var(--dim)]">About: {r.nodeName ?? r.nodeKey}</p>}
                    {shownResult != null && shownResult.length > 0 && (
                      <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-[var(--dim)]">{shownResult}</p>
                    )}
                    {long && (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setExpandedResults((prev) => { const next = new Set(prev); if (next.has(r.id)) next.delete(r.id); else next.add(r.id); return next; })}
                        className="mt-1 min-h-[44px] rounded-md border border-[var(--border)] px-3 text-sm"
                      >
                        {expanded ? "Hide details" : "Full details"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <h2 className="mt-6 text-base font-semibold">Review queue</h2>
          {reviewItems.isPending ? (
            <p className="mt-1 text-sm text-[var(--dim)]">Loading…</p>
          ) : reviewItems.isError ? (
            <div>
              <p className="mt-1 text-sm text-[#ff7b72]">The review queue could not be loaded.</p>
              <button type="button" onClick={() => reviewItems.refetch()} className="mt-2 min-h-[44px] rounded-md border border-[var(--border)] px-4 text-sm">Retry</button>
            </div>
          ) : reviewList.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--dim)]">Nothing waiting for review.</p>
          ) : (
            <ul className="mt-1 divide-y divide-[var(--border)]">
              {reviewList.map((item) => {
                const filed = filedResolutions[item.id];
                return (
                  <li key={item.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-medium">{reviewKindLabel(item.kind)}</span>
                      <span className="text-xs text-[var(--dim)]">{item.id} · Raised {formatInstant(item.at)}</span>
                    </div>
                    <DetailLines value={item.subject} />
                    {filed != null ? (
                      <p className="mt-2 text-sm text-[var(--accent)]">Resolution filed — the agent will apply it</p>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.choices.map((c, i) => {
                          const val = choiceValue(c);
                          return (
                            <button
                              key={`${val}-${i}`}
                              type="button"
                              disabled={resolveReview.isPending || val.length === 0}
                              onClick={() => resolveReview.mutate({ id: item.id, choice: val })}
                              className="min-h-[44px] rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-[#06251f] disabled:opacity-50"
                            >
                              {choiceLabel(c)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {resolveReview.isError && filed == null && (
                      <p className="mt-1 text-sm text-[#ff7b72]">Could not file the resolution — try again.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <h2 className="mt-6 text-base font-semibold">Decisions</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" aria-pressed={decisionKind === "all"} onClick={() => setDecisionKind("all")} className={`min-h-[44px] rounded-full border px-3 text-sm ${decisionKind === "all" ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)]"}`}>All kinds</button>
            {decisionKinds.map((k) => (
              <button key={k} type="button" aria-pressed={decisionKind === k} onClick={() => setDecisionKind(k)} className={`min-h-[44px] rounded-full border px-3 text-sm ${decisionKind === k ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)]"}`}>{decisionKindLabel(k)}</button>
            ))}
          </div>
          {decisions.isPending ? (
            <p className="mt-1 text-sm text-[var(--dim)]">Loading…</p>
          ) : decisions.isError ? (
            <div>
              <p className="mt-1 text-sm text-[#ff7b72]">Decisions could not be loaded.</p>
              <button type="button" onClick={() => decisions.refetch()} className="mt-2 min-h-[44px] rounded-md border border-[var(--border)] px-4 text-sm">Retry</button>
            </div>
          ) : shownDecisions.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--dim)]">No decisions recorded yet.</p>
          ) : (
            <ul className="mt-1 divide-y divide-[var(--border)]">
              {shownDecisions.map((d) => {
                const expanded = expandedDecisions.has(d.id);
                return (
                  <li key={d.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{decisionKindLabel(d.kind)}</span>
                      <span className="text-xs text-[var(--dim)]">{formatInstant(d.at)}</span>
                    </div>
                    <p className="mt-0.5 text-sm break-words">{d.subject}</p>
                    {d.revertedAt && <p className="mt-0.5 text-sm text-[#ff7b72]">Later undone · {formatInstant(d.revertedAt)}</p>}
                    {d.detail != null && (
                      <>
                        {expanded && <DetailLines value={d.detail} />}
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setExpandedDecisions((prev) => { const next = new Set(prev); if (next.has(d.id)) next.delete(d.id); else next.add(d.id); return next; })}
                          className="mt-1 min-h-[44px] rounded-md border border-[var(--border)] px-3 text-sm"
                        >
                          {expanded ? "Hide details" : "Details"}
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* ================= ADD TAB ================= */}
      {activeTab === "add" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <h2 className="text-base font-semibold">Add a file</h2>
          <p className="mt-1 text-sm text-[var(--dim)]">
            Text files for this graph: md, markdown, txt, csv, json, jsonld, ttl, rdf, xml, cypher — up to {UPLOAD_MAX_CHARS.toLocaleString()} characters each.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept={UPLOAD_ACCEPT}
            aria-label="Choose a text file to add"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void onPickUploadFile(file);
            }}
          />
          <button
            type="button"
            disabled={uploadMut.isPending || activeGraphId == null}
            onClick={() => fileInputRef.current?.click()}
            className="mt-2 min-h-[44px] rounded-md bg-[var(--accent)] px-4 text-sm font-semibold text-[#06251f] disabled:opacity-50"
          >
            {uploadMut.isPending ? "Adding…" : "Choose a file"}
          </button>
          {uploadError && <p className="mt-2 text-sm text-[#ff7b72]">{uploadError}</p>}

          {uploads.isPending ? (
            <p className="mt-3 text-sm text-[var(--dim)]">Loading…</p>
          ) : uploads.isError ? (
            <div>
              <p className="mt-3 text-sm text-[#ff7b72]">Files could not be loaded.</p>
              <button type="button" onClick={() => uploads.refetch()} className="mt-2 min-h-[44px] rounded-md border border-[var(--border)] px-4 text-sm">Retry</button>
            </div>
          ) : uploadList.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--dim)]">No files added yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-[var(--border)]">
              {uploadList.map((u) => (
                <li key={u.id} className="py-3">
                  <p className="text-sm font-medium break-words">{u.filename}</p>
                  <p className="mt-0.5 text-xs text-[var(--dim)]">{formatBytes(u.sizeBytes)} · Added {formatInstant(u.createdAt)}</p>
                  {importFiledIds.has(u.id) ? (
                    <p className="mt-1.5 text-sm text-[var(--accent)]">Import filed — watch it under Activity.</p>
                  ) : (
                    <button
                      type="button"
                      disabled={dispatchMut.isPending}
                      onClick={() =>
                        dispatchMut.mutate(
                          {
                            category: "import",
                            task: `Import the uploaded file "${u.filename}" (upload id ${u.id}) into this graph: fetch its content via the getUpload action (upload id ${u.id}), parse it, and load it into the Relate store as nodes and edges, following the existing schema where one exists. Report before/after node and edge counts and counts by label and relationship type.`,
                            nodeKey: null,
                            nodeName: null,
                          },
                          { onSuccess: () => setImportFiledIds((prev) => new Set(prev).add(u.id)) },
                        )
                      }
                      className="mt-1.5 min-h-[44px] rounded-md border border-[var(--border)] px-3 text-sm disabled:opacity-50"
                    >
                      Import this file
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h2 className="mt-6 text-base font-semibold">Apply an ontology</h2>
          <p className="mt-1 text-sm text-[var(--dim)]">An ontology gives the graph a shared set of types and words. Applying one files a job for the agent.</p>
          {presetFiled && <p className="mt-1.5 text-sm text-[var(--accent)]">Filed — watch it under Activity.</p>}
          {presetError && <p className="mt-1.5 text-sm text-[#ff7b72]">{presetError}</p>}
          {presets.isPending ? (
            <p className="mt-2 text-sm text-[var(--dim)]">Loading…</p>
          ) : presets.isError ? (
            <div>
              <p className="mt-2 text-sm text-[#ff7b72]">Ontologies could not be loaded.</p>
              <button type="button" onClick={() => presets.refetch()} className="mt-2 min-h-[44px] rounded-md border border-[var(--border)] px-4 text-sm">Retry</button>
            </div>
          ) : (
            <ul className="mt-2 divide-y divide-[var(--border)]">
              {presetList.map((p) => {
                const unavailable = p.available === false;
                return (
                  <li key={p.id} className={`py-3 ${unavailable ? "opacity-55" : ""}`}>
                    <p className="text-sm font-medium">{p.name}{unavailable ? " — Not available" : ""}</p>
                    <p className="mt-0.5 text-sm text-[var(--dim)]">{p.blurb}</p>
                    <button
                      type="button"
                      disabled={unavailable || applyPresetMut.isPending}
                      onClick={() => { setPresetFiled(false); applyPresetMut.mutate(p.id); }}
                      className="mt-1.5 min-h-[44px] rounded-md bg-[var(--accent)] px-4 text-sm font-semibold text-[#06251f] disabled:opacity-50"
                    >
                      Apply
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
