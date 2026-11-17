# Relate Usage Audit — 2026-11-16

**Question (Johnny):** "Make sure you're using Relate how you should be."
**Method:** RepoMix pack of the Relate source (`~/workspace/_scratch/repomix-relate.xml`, clone of
github.com/relatedb/relate at HEAD `51432cf`, v1.0.3 source) read first, then the repo's own
docs, then relatedb.ai, then our files read fresh. Every verdict below cites the doc/source it
rests on. Where source and docs disagreed, the live installed binary was the tiebreaker.
**Version note:** we run **Relate v1.0.1** (`~/.local/bin/relate --version`); the cloned source
is v1.0.3. Every capability this audit recommends was verified present in the v1.0.1 binary
itself (serve `--help` surface + live probes on a throwaway store), so no fix below waits on an
upgrade.

**Live probes run on our v1.0.1 binary** (temp store in /tmp, deleted after):

- `vector.similarity.cosine([1,0],[0,1])` → **0.5**; `([1,0],[1,0])` → **1.0**
- `CREATE VECTOR INDEX` + `SEARCH … SCORE AS` + `CALL db.index.vector.queryNodes` all work;
  query `[0.9,0.1]` scored alpha `[1,0]` at 0.9969418 and beta `[0,1]` at 0.5552157 — exactly
  (1 + raw cosine)/2 of the raw cosines our Python computes (0.99388 → 0.99694; 0.11043 → 0.55522)
- `CREATE CONSTRAINT … REQUIRE name IS UNIQUE` works; a duplicate `CREATE` was refused with
  `ConstraintValidationFailed`
- `relate serve --help` on v1.0.1 lists `--mcp`, `--bolt`, `--tx-idle-timeout-secs`,
  `--max-open-transactions`, and `--safe`

---

## The cosine question (Q1) — verdict in one line

**Our (1+cos)/2 observation is correct — it is Relate's documented, Neo4j-matching semantics in
both the scalar function and the index scan; we are not calling it wrong, and raw cosine is
recoverable exactly as 2·score − 1 (or via `vector_distance(…, COSINE)`), so the Python rescan
is a choice, not a necessity.**

Evidence:

- `docs/reference/functions.md` §Similarity functions: "These return a **rebounded similarity**
  in `[0, 1]`… not the raw cosine of the angle"; `vector.similarity.cosine(a, b)` — "Cosine
  similarity rebounded to `[0, 1]` (`1.0` = same direction, `0.5` = orthogonal, `0.0` =
  opposite)".
- Source, scalar path — `relate/relate-executor/src/eval/vector.rs`, `vector_cosine`:
  `let raw = (dot / (nx * ny)) as f32 as f64; Ok(Value::Float(((1.0 + raw) / 2.0) as f32 as f64))`.
- Source, index-scan path — `relate/relate-executor/src/vector_similarity.rs`,
  `cosine_similarity_values`: "The CIP-121 cosine score for the scan path (ADR-0256), with the
  float32-rounded `(cos + 1) / 2` chain". (CIP-121 is the Neo4j vector spec — the rebound is
  Neo4j compatibility, not a Relate quirk.)
- Live on our binary: orthogonal vectors score 0.5, not 0.0 (probe above).
- The raw-metric alternative exists: `vector_distance(v1, v2, COSINE)` "returns the **raw
  metric** value (not rebounded)… lower means closer" (functions.md §Distance functions) — but it
  takes constructed `vector(...)` values, not plain lists.
- Caveat for any switch: native scores are float32-rounded (both source paths round via f32);
  our Python computes float64. Threshold behavior at the 7th decimal can differ; nothing else.

---

## Scoreboard

| # | Area | Verdict |
|---|------|---------|
| 1 | Cosine semantics (Q1) | **ALIGNED** — our reading of the function is correct; see D3 for the scan it pushed us into |
| 2 | Vector index (Q2) | **DEVIATION** (D3) — none created anywhere; in-engine top-K unused |
| 3 | Full-text / hybrid search | **DEVIATION** (D4) — native FULLTEXT INDEX + SEARCH (+ preview COMBINE/WRRF) unused; keyword leg hand-scanned in Python |
| 4 | Agent route: MCP vs raw HTTP (Q3) | **DEVIATION** (D5) — the surface Relate built for agents is not enabled; raw HTTP is legitimate but bypasses it |
| 5 | One serve process per graph (Q4) | **ALIGNED** — that is the design (one open database per serve process; one graph per store) |
| 6 | Parameterized queries (Q5) | **MOSTLY ALIGNED** — the brief's premise is stale: bin/relate binds values as parameters throughout; residual is identifier interpolation (inherent to Cypher, allowlist-gated) + D7 |
| 7 | Write atomicity / transactions | **DEVIATION** (D1) — write-batch is multi-request and non-atomic although the HTTP surface offers managed transactions |
| 8 | Schema enforcement (constraints/indexes) | **DEVIATION** (D2) — slug uniqueness is enforced by our post-hoc scans, never by engine constraints; slug lookups are unindexed full scans |
| 9 | `--auth none` on loopback (Q6) | **ALIGNED posture, DEVIATION from default** (D6) — `none` is a documented spelling and loopback is the default bind; the authenticated default and `--safe` mode go unused |
| 10 | Graph lifecycle / provisioning | **ALIGNED** — blank store → serve → registry mirrors the one-database-per-process design; the direct `--database` open in provision-graph.sh happens pre-serve only |
| 11 | Embedding generation | **ALIGNED** — Relate has no embedding-generation feature (docs/guides/README contain no Ollama/OpenAI integration); it stores and searches vectors. Ollama-side generation + list properties is the guide's own model ("Store embeddings as list properties", vector-similarity guide) |
| 12 | Pipeline call discipline | **ALIGNED with one latent flaw** (D7) — stages are instructed to use the typed CLI; the shared context blurb still teaches the raw route with empty parameters |
| 13 | Space server-side Relate calls | **UNVERIFIED** — action surface confirmed (22 actions, all graph reads "queried live from the graph's Relate API", runcypher read-only by contract); the Space's source is not readable through the artifact tools, so its statement construction (parameters? indexes? tx?) cannot be audited from outside |

Deviation count: **7 — 1 high, 2 medium, 1 low-medium, 3 low.** Ranked below by correctness,
then performance, then idiomatic-ness.

---

## Deviations, ranked

### D1 — HIGH (correctness): write-batch applies across many auto-commit requests; the surface offers managed transactions and we never use them

- **Relate contract:** the HTTP Query API has managed-transaction routes —
  `POST /db/{name}/query/v2/tx` (begin, 201 + `transaction: {id, expires}`),
  `POST …/tx/{id}` (run statement), `POST …/tx/{id}/commit`, `DELETE …/tx/{id}` (rollback)
  (docs/api/http/spec.md route table; ADR-0237 "Query API v2 managed-transaction routes on
  engine transactions": "The engine has had real explicit transactions all along"). Idle
  timeout default 60s, open-tx cap 128 (limitations.md; serve `--tx-idle-timeout-secs` /
  `--max-open-transactions`, both present in our v1.0.1 binary). Note: docs/api/http/
  description.md still says "no managed transactions" — that line is stale against ADR-0237,
  the spec, and limitations.md; the routes are real and live in our binary.
  relatedb.ai's own agent quickstart (landing page, crawled 2026-11-17): "Import in a
  transaction where supported."
- **Our usage:** `bin/relate` `run_query` (line 172) only ever POSTs the auto-commit statement
  route. `write-batch` applies nodes, then edges, item by item across separate requests;
  CONNECTOR.md states it plainly: "NOT batch-atomic: nodes apply before edges are validated, so
  a refused edge leaves its applied nodes in place — per-item atomicity only." The same exposure
  covers merge/supersede + their Decision-ledger writes (CONNECTOR.md documents the
  `UNLOGGED CHANGE` failure mode: a mutation lands, its ledger write fails, the change stands
  unlogged). Grep confirms zero uses of `/tx` anywhere in bin/relate, bin/relate-search, or the
  pipeline workflow.
- **Fix:** give `run_query` a transaction-scoped variant and run each `write-batch` (and each
  merge/supersede + ledger pair) inside one managed transaction: begin → apply → commit;
  DELETE (rollback) on any refusal. Refusals then cost zero writes instead of a partial batch.
- **Cost:** medium. One client change in bin/relate + call-site changes in the multi-statement
  commands. Watch the 60s idle timeout on slow batches (statements keep the tx alive; a batch
  is a burst, so this is a non-issue in practice). No server change — same serve processes.

### D2 — MEDIUM (correctness): slug integrity is detective (our scans), not preventive (engine constraints); no index on our primary key

- **Relate contract:** `CREATE INDEX`, `CREATE VECTOR INDEX`, `CREATE FULLTEXT INDEX`, and
  `CREATE CONSTRAINT … REQUIRE n.prop IS UNIQUE / IS NODE KEY` are all in the language
  (docs/reference/cypher-syntax.md §§457–491). "Constraints are checked per statement, plus at
  commit for constrained values" (docs/limitations.md) — i.e., the engine refuses a duplicate
  at write time, atomically. Verified live on v1.0.1 (probe: duplicate refused with
  `ConstraintValidationFailed`).
- **Our usage:** grep finds zero `CREATE INDEX` / `CREATE CONSTRAINT` in bin/relate,
  bin/relate-search, and the workflow. Every slug lookup is `MATCH (n {slug: $slug})` — a full
  scan. Duplicate slugs are caught after the fact by `scan-conflicts` and the `verify` gates.
  CONNECTOR.md already records the adjacent race in our own ledger: decision ids are "allocated
  inside the create statement; this engine does not serialize count+create across concurrent
  statements, so a raced writer renumbers its own entry" — the same check-then-write pattern
  guards slugs.
- **Fix:** one-time DDL per graph (at provision time and in `stamp`): a UNIQUE constraint on
  `slug` for each content label (Person/Group/SourceDocument, or a node-key where the model
  allows) plus a plain `CREATE INDEX` on slug for the bookkeeping labels. Pre-existing
  duplicates must be reconciled first — `reconcile` already does this for ontology terms.
- **Cost:** low. A DDL step in provision-graph.sh + stamp; a one-off reconcile-then-constrain
  pass on Main and TEST. Benefit compounds with D1 (constraint checks also run at tx commit).

### D3 — MEDIUM (performance): no vector index exists; all similarity is full-pull Python scans

- **Relate contract:** `CREATE VECTOR INDEX … FOR (a:Label) ON (a.embedding)` enables the
  `SEARCH` clause and `CALL db.index.vector.queryNodes(name, k, $vec)` — top-K **inside the
  engine**. "A vector index is schema metadata, not an ANN structure: top-k search is an exact
  scan over the indexed vectors (bounded top-k heap), so results are exact with no recall
  trade-off" (vector-similarity guide, tip). ADR-0256: the scan kernel is SIMD-style with a
  bounded heap and `WITH [...]`-filter pushdown; benchmarked 1M×768d in 61ms single-thread.
  There is no recall excuse for avoiding it — it is exact, like our Python.
- **Our usage:** `bin/relate` `_similar_pairs` (line 2200) fetches every stored vector over HTTP
  and computes pairwise raw cosine in Python (O(n²) for similar/similar-scan).
  `bin/relate-search` fetches **every** node's embedding plus **all** edges per query
  (lines 288–305) and cosines in Python — the ~7–13s/query measured when it landed. No graph
  carries a vector index (zero CREATE INDEX of any kind, D2).
- **Fix:** create a vector index per content label at stamp/embed time; repoint the
  relate-search vector leg at `queryNodes`/`SEARCH` per label (rebounded scores; apply
  raw = 2s − 1 where a raw cosine is genuinely needed, e.g. threshold gates calibrated on raw
  cosine); repoint similar-scan at per-node in-engine top-K.
- **Cost:** medium. Index DDL is trivial; the work is the two tools' query rewrites + threshold
  recalibration (our 0.25 candidate gate and 0.60/0.85 pair thresholds are raw-cosine numbers;
  native equivalents are 0.625 / 0.80 / 0.925 in rebounded space — convert, don't re-tune).

### D4 — LOW-MEDIUM (performance + retrieval quality): keyword leg is a Python substring scan; native full-text (and native RRF fusion) unused

- **Relate contract:** `CREATE FULLTEXT INDEX … ON EACH [n.name, n.summary]` + `SEARCH … IN
  (FULLTEXT INDEX …)` with tokenization/analyzers and `db.index.fulltext.queryNodes/
  queryRelationships` procedures (cypher-syntax.md §§204, 465, 635–671; vector-similarity
  guide §Hybrid). Beyond that, `SEARCH … IN (COMBINE (VECTOR INDEX … WEIGHT w, FULLTEXT
  INDEX … WEIGHT w) USING WRRF WITH CONSTANT 60)` fuses both ranked lists natively — weighted
  reciprocal rank fusion is a built-in (CIP-278), albeit behind the
  `RELATE_PREVIEW=hybrid-search` preview gate (cypher-syntax.md §Hybrid search (COMBINE,
  preview)).
- **Our usage:** relate-search's keyword leg pulls all node text over HTTP and does weighted
  substring matching in Python (lines 322–348), and the whole three-leg RRF fusion (k=60 —
  the same constant COMBINE defaults to) is hand-rolled. Substring matching also differs from
  tokenized full-text behavior (no term boundaries, no analyzer folding).
- **Fix:** fulltext index over name/summary/alias/legalName; keyword leg via fulltext SEARCH.
  Evaluate COMBINE for the vector+keyword fusion; keep the traversal leg and any final fusion
  in Python (traversal has no native counterpart).
- **Cost:** medium, and it shares the relate-search rewrite with D3 — do them together.

### D5 — LOW (idiomatic): the MCP server — the surface Relate built for agents — is not enabled anywhere

- **Relate contract:** "The MCP surface lets LLM agents run Cypher against a Relate store
  through the Model Context Protocol… where Bolt speaks to drivers, MCP speaks to agent hosts —
  Claude Desktop, Claude Code, and other MCP clients" (docs/api/mcp/description.md). Exactly
  three tools mirroring the reference `mcp-neo4j-cypher` server: `get_schema` (labels, types,
  sampled property types), `read_cypher` (**read-only enforced by plan classification — writes
  AND schema DDL are rejected**), `write_cypher` (mutation counters; the tool is not even
  listed under a `--read-only` serve) (docs/api/mcp/spec.md lines 74–76). relatedb.ai positions
  it the same way: "MCP endpoint — Lets agents that speak MCP connect without glue code."
  `relate serve --mcp PORT|stdio` exists in our v1.0.1 binary; one serve process hosts
  HTTP + MCP + Bolt on the same open database, sharing one connection cap
  (surfaces/relate-cli/src/help/serve.rs).
- **Our usage:** both systemd units run `relate serve --database … --http <port> --auth none`
  — HTTP only. Agents reach the graphs through raw HTTP wrapped in our hand-rolled CLI. What
  that bypasses: engine-enforced read/write separation for ad-hoc agent queries (our
  read-only guarantees live in our own Space/CLI code instead), `get_schema` discovery, and
  direct attachment by any MCP host. What raw HTTP + our CLI buys that MCP does not: the typed
  gate layer (ontology conformance, provenance, contradiction scan, decision ledger) — MCP is
  a bare Cypher surface, so the CLI stays the pipeline's write path regardless.
- **Fix:** add `--mcp <port>` alongside `--http` in both unit templates (and provision-graph.sh
  for future graphs) so MCP hosts can attach directly; keep the CLI as the sanctioned write
  path and say so in CONNECTOR.md. Optionally serve a second, `--read-only` MCP endpoint for
  pure-exploration agents (write_cypher disappears automatically).
- **Cost:** low. Unit-template edit + restart per graph + a CONNECTOR.md paragraph.

### D6 — LOW (posture): `--auth none` is a documented option, but we run it by default and skip `--safe`

- **Relate contract:** auth resolution is "`--auth user:password` flag, then `RELATE_AUTH`,
  else a generated token; **`none` disables auth**" (docs/api/http/spec.md, HttpConfig entry
  points). Serve help: "`--auth USER:PASSWORD`… `none` disables auth. Default: RELATE_AUTH,
  else a generated token printed at startup (persisted as `<dir>.auth-token`, 0600)". Bind
  host: "Default 127.0.0.1 (loopback only). Any other host deliberately exposes the PLAINTEXT
  surfaces to the network — serve has no TLS — and a loud WARNING prints at startup"
  (help/serve.rs). The design center is "a single user or agent per process" (README;
  limitations.md "Single-process engine"). Separately, ADR-0477 adds `--safe`: "Refuse
  agent-typical dangerous statement shapes on the served store" — unbounded full-graph reads
  and label-less writes — built exactly for handing a store to an agent. (ADR marked Proposed
  in source; the flag is present in our v1.0.1 serve help.)
- **Our usage:** `--auth none` in both units; loopback by default (we never pass `--host`) —
  the access control is the loopback bind, as CONNECTOR.md states. `--safe` is not enabled.
- **Verdict nuance:** this is an intended, documented configuration for a single-user local
  agent box — not a smell by itself. It is a deviation from the authenticated default, and it
  means anything that can reach loopback (any local process, any future tunnel) has full
  read/write on every graph.
- **Fix options:** (a) accept and document — defensible today; (b) generated-token auth
  plumbed through every client (Space, bin/relate, relate-search, bot, hook) — medium cost,
  touches everything; (c) `--safe` on the serves — low cost but needs a compatibility pass
  first: it refuses LIMIT-less non-aggregate full reads, and bin/relate has some (e.g. the
  node fetch `MATCH (n:{label}) … RETURN n`, line 376) that would need LIMITs. Recommend (a)
  now, (c) after D3/D4 land, (b) only if a tunnel or second user ever appears.
- **Cost:** (a) zero; (b) medium; (c) low-medium.

### D7 — LOW (latent): the pipeline's shared context teaches the raw route with empty parameters

- **Our usage:** `~/workspace/.jarvis/workflows/relate-pipeline.js` ctxParts DATABASE blurb
  documents the job's database access as `POST …/db/neo4j/query/v2` with body
  `{"statement": "<Cypher>", "parameters": {}}` and a curl example that omits parameters
  entirely. The same file's determinism mandate routes mechanical work through the typed CLI —
  and in practice stages obey the mandate — but the blurb is the only place the raw API is
  described, and it models exactly the interpolate-and-send style Q5 worried about. (The
  candidates stage also repeats the "(1+cos)/2" warning to keep agents off the native
  function; post-D3 that instruction should point at the native top-K instead.)
- **Fix:** rewrite the blurb: CLI-first wording, and if a raw example stays, show a bound
  parameter (`{"statement": "MATCH (n {slug: $slug}) RETURN n", "parameters": {"slug": "…"}}`).
- **Cost:** trivial — one string in one file.

---

## Aligned areas (with the receipts)

- **One process per graph (Q4) — the design, not a workaround.** "serve hosts Relate's network
  surfaces on **one open database** until SIGINT/SIGTERM. At least one surface flag is
  required" (help/serve.rs). A store holds only the three fixed namespaces (`neo4j`, `system`,
  `system_ontologies`); "you cannot open several databases in a session and switch between
  them" (docs/limitations.md). README: "one graph per store, a single user or agent per
  process". Our per-graph systemd units + registry are exactly this shape. One caution the
  design imposes: "A directory-backed database is used from **one process**" (limitations.md) —
  opening a served store directly via `relate query --database` from a second process would
  break it. provision-graph.sh does that open only before the service starts; nothing audited
  opens a live served store directly.
- **HTTP Query API v2 as a programmatic surface — first-class.** It "speaks the Neo4j Query
  API v2 statement shape… so existing Query API clients… work against Relate unchanged"
  (docs/api/http/description.md). Our path (`/db/neo4j/query/v2`, database name `neo4j`) is the
  fixed user-data namespace — correct. Bolt would add driver semantics we don't need from
  Python/shell clients.
- **Parameters (Q5) — the API fully supports them, and the current bin/relate uses them.**
  Spec: "`parameters` | object | `$name` bindings" with plain-JSON dialect under
  `application/json` (docs/api/http/spec.md §401). In bin/relate: `run_query` sends
  `parameters` (line 172); `apply_props` binds every value as `$v_<key>` with property keys
  filtered by `_IDENT_RE` (lines 402–410); write-batch binds `$slug`/`$v_*` and UNWINDs row
  parameters (lines ~818, 1674); `similar` binds `$cos`/`$at` (line 2236). What remains
  interpolated is **identifiers** — labels, relationship types, property names — which Cypher
  cannot bind as parameters in any engine; each is gated by `_IDENT_RE` or the stamped-ontology
  allowlist (write-batch refuses an edge type "not a stamped object property"). relate-search
  sends only static statements (no interpolation at all). The deliberate exception is the
  `query` escape hatch — raw by design and documented as such in CONNECTOR.md. **The audit
  brief's premise ("mostly interpolate values with empty parameters") describes an earlier
  state of the tools, not the files on disk today.**
- **Embedding generation outside Relate — correct division of labor.** No embedding-generation
  feature exists in Relate's docs or guides; the vector guide's model is host-side generation +
  list properties in the graph + native search. Our Ollama embeddinggemma flow matches it,
  including storing `embedding_dim`/`embedding_model` alongside (our own bookkeeping, harmless).
- **Loopback posture (part of Q6).** Default bind is 127.0.0.1; we never override it. Combined
  with `--auth none` this is the documented local-agent configuration (see D6 for the residual
  judgment call).
- **First-class `VECTOR` type exists and we don't need it.** `vector(list, dims, type)`
  constructs typed vectors and `vector_distance` requires them; plain lists are accepted by
  the similarity functions and indexable (guide examples store lists). Staying on lists is
  compatible with every native feature in D3/D4.

## Unverified

- **Space server-side implementation (relate-graph artifact).** The published action surface
  was inventoried read-only via artifact.list_actions (22 actions). Descriptions confirm the
  Space queries each graph's Relate API live (getgraph/getnode/listdecisions/listreviewitems)
  and that runcypher is read-only by contract. The artifact's server source is not exposed
  through the artifact tools, so whether the Space binds parameters, could use the D3/D4
  indexes, or writes atomically is **UNVERIFIED** — D1/D2/D3 fixes should include a Space-side
  review once its source is accessible to an auditor.
- **relatedb.ai website vs repo docs.** The site was fetched (landing page, 2026-11-17) and
  matches the repo's positioning and guidance; the deep references live in the repo's `docs/`
  (README: "The deep references live in `docs/` in this repository"), which is what this audit
  cites throughout.

## Top 3 fixes (from the ranked list)

1. **D1 — wrap write-batch in managed transactions** (`/query/v2/tx` … `/commit`, rollback on
  refusal). Kills the only known silent-partial-write exposure; also makes mutation + Decision
  ledger atomic.
2. **D2 — engine DDL per graph:** UNIQUE constraint + index on `slug`, created at
  provision/stamp time. Turns our best detective control into a preventive one, cheaply.
3. **D3 + D4 — native indexes for search:** VECTOR INDEX per content label and FULLTEXT INDEX
  over name/summary, with relate-search's vector/keyword legs moved in-engine (SEARCH /
  queryNodes). Removes the full-graph pull per query and the O(n²) Python similarity pass;
  thresholds convert to rebounded space (raw = 2s − 1) rather than being re-tuned.
