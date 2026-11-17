# NVIDIA Auto-Ontology × Agentic GraphRAG — Feature Teardown & Adoption List

**Date:** 2026-11-16 · **Method:** RepoMix run first on the two core repos (cloned
`--depth 1` into `~/workspace/_scratch/`; packs at `_scratch/repomix-nvidia-auto-ontology.xml`
/ `_scratch/repomix-nvidia-ca-rag.xml`), then READMEs, `docs/architecture.md`, and the
extraction/planner/eval code read directly. The VSS blueprint repo
(`NVIDIA-AI-Blueprints/video-search-and-summarization`) was also cloned in full and
checked after checkout: it carries no GraphRAG code of its own — CA-RAG reaches it as a
deployed service (only a config test references it) — so the substantive GraphRAG code
is the standalone `NVIDIA/context-aware-rag` repo, cloned and read in full.
Every feature traces to NVIDIA's own repo/docs/code — no blog-post features.
**Scope: teardown + mapping only; nothing in our stack was edited.**

Repos: `NVIDIA/auto-ontology` (Python, Apache-2.0, Agent Knowledge Foundation, Oct 2026) ·
`NVIDIA/auto-ontology-eval` (Python, Apache-2.0) · `NVIDIA/context-aware-rag` (Python,
Apache-2.0 — the CA-RAG / GraphRAG module of the VSS Blueprint).

**One correction before the inventory, because the coverage gets it wrong:** third-party
write-ups describe Auto-Ontology as "generating knowledge graphs from unstructured text."
The repo does no such thing. Auto-Ontology induces an ontology from **relational database
metadata + query history** (tables, columns, keys, profiling statistics) for text-to-SQL
agents. NVIDIA's unstructured-text GraphRAG (CA-RAG) uses the opposite approach — a
**config-supplied** node/relationship type list, no induction at all. "NVIDIA auto-ontology"
and "NVIDIA GraphRAG" are two different systems with two different schema philosophies, and
the mapping below treats them separately.

---

## 1. Auto-Ontology — feature inventory

### The ontology model (six elements)
- **Term** (concept): a business concept (*Customer*, *Invoice Line*) with description +
  synonyms, proposed by an LLM, certified by a person — README "How it works".
- **Mapping**: column attributes tie each term to the tables/columns that hold it.
- **Relationship**: joins between tables — declared keys, plus inferred links **confirmed
  against the data** (below).
- **Metric**: SQL attributes — reviewed SQL expressions stored under a term (a margin, a
  rolling total), reused so every answer computes a measure the same way.
- **Lineage**: every term/attribute links to its source tables/columns; every answer
  returns its SQL.
- **Certification**: experts certify names/descriptions/attributes; certified elements are
  marked reviewed in UI and search results. Certification does **not** change retrieval —
  it is a trust marker, not a ranking input — README; `docs/architecture.md` "Output and
  certification".

### Generate — catalog ingest (deterministic first)
- Extract tables, columns, keys, views, and **query history** via SQL — `ingestion_service/ingest.py`.
- PII detection: rules first, LLM only for columns the rules can't decide (off by default).
- Embed tables and columns into pgvector (`EMBED` role).

### Generate — per-table pass (profiling before any model call)
- **SQL profiling**: sample up to 1,000 rows; a column is marked unique at
  `distinct_ratio` ≥ 0.95; lowest distinct values of suspected key columns kept; distinct
  values of low-cardinality columns collected; date formats inferred by rules
  (`semantic/date_format.py`) — `docs/architecture.md` "Per-table pass";
  `semantic/visit_enter.py` (`process_table`, three tables at a time).
- LLM (all compilation calls use the `REASONING` role, ≤6 concurrent): foreign-key
  candidates + junction-table marking, merged with declared keys
  (`semantic/fk_suggester.py`); column descriptions (`semantic/deterministic.py`);
  term naming (`semantic/term_extractor.py`).
- The term-extraction prompt is a **restrictive contract**, not an open invitation:
  strongly prefer ONE term per table (a second only for a true junction); every candidate
  column assigned to exactly one term; friendly display names with spaces; **no IS_A,
  PART_OF, or ROLE relationships may be proposed**; variant tables (ARC/HIST/STAGING/
  DELETED/TEMP) get qualifying name prefixes — `term_extractor.py` `_SYSTEM`.
- Synonym extraction is evidence-bound: only aliases *explicitly written* in a description
  ("also known as", a parenthetical) — "Do NOT infer, guess, or add any name that is not
  directly written" — `term_extractor.py` `_SYNONYM_SYSTEM`.

### Generate — cross-table pass
- **Term families** by rules: copies of one schema told apart by a name prefix
  (`OLD_ROOMS` / `NEW_ROOMS`) grouped so later stages can tell the copies apart
  (`semantic/term_families.py`).
- **Semantic foreign keys, data-confirmed**: declared key first; otherwise embedding
  search + LLM pick, confirmed by comparing the two columns' distinct values, then a
  shortlist of keys whose values contain the column's. **An inferred link is stored only
  if joining the two columns returns a row** (retried with both sides cast to text), and
  never points into another family's copy (`semantic/semantic_fk.py`). One default join
  per group of alternative links (LLM, deterministic fallback).
- Unmatched FK columns attached by LLM+embeddings to their table's term (or a new term
  for a junction table) — `semantic/unmatched_fks.py`.
- **SQL attributes mined from query history**: up to 10 expressions per term parsed from
  real past queries (the doc admits usage ranking "isn't active yet — these are the first
  10 found, not the most used") — `semantic/sql_attribute_suggester.py`. Bridge-table SQL
  attributes: LLM writes them, the `RERANK` model picks which term owns each — the only
  place reranking is used; answering never calls it.
- Tagging rules replayed over catalog + ontology after each pass (rules, no model).

### Certification & the Learn loop
- Compilation runs at startup, every 24h, and on demand — but **processes only tables
  that don't have a term yet**, so human edits and certifications survive recompilation.
  One documented exception: which semantic FK each join uses is re-selected every
  compilation, so turning one off doesn't stick — `docs/architecture.md`.
- Edits are **re-embedded the moment they save**, so the next question uses them.
- Draft is tested with real questions (Chat, or `check_answerable` / `ask_question` over
  MCP) *before* certification — test-then-certify is the workflow, not an afterthought.
- Import/export of the whole semantic model as **Apache Ossie YAML**
  (`POST /api/model/import|export`), so the ontology is portable across tools.

### Answer — a ReAct loop with deterministic tool-side validation
- The answering agent is a ReAct loop: the `REASONING` model starts with **no schema**
  and chooses one tool at a time (`retrieval/text_to_sql/react/`). Follow-up questions
  are rewritten standalone first (cheap model); a chart is planned after.
- Tools: `retrieve` (pgvector meaning search + name substring search over terms,
  attributes, definitions, analyses; returns tables/columns **with stored values**,
  join paths to already-shown tables via `find_join_path`, and near-copy tables with
  row counts; `purpose=information` mode answers in words), `run_sql`, `submit`,
  optional `grep` over oversized results, optional `predict` (KumoRFM).
- **Validation is in the tools, not the prompt**: `run_sql` checks every table/column
  name against the catalog (suggesting the closest real names for unknown ones) and
  **rejects tables no `retrieve` result named**; `submit` applies the same checks, runs
  the final query, and an error goes back to the model to fix. "There's no separate
  intent classifier, SQL judge, or repair model."
- **Budgets are published numbers**: 24 tool calls / 10 SQL runs / 2 predict calls per
  question; 8,000 chars per tool result; 100 rows shown. A repeated identical tool call
  is not re-run — the model is pointed at the earlier result — **and the repeat still
  counts against the budget**. Stop conditions are first-class: clean submit → answer;
  budget exhausted → refusal ("can't be answered from this data"); two nudges with no
  tool call → refusal; endpoint failure → refusal. The agent never asks clarifying
  questions inside the loop.
- Every answer returns **its SQL and the steps that produced it** — the working is part
  of the answer, checkable against the source.

### Answerability — a graded pre-check (MCP `check_answerable`)
- `POST /api/question-entity-coverage` (`retrieval/entity_coverage/`): (1) LLM extracts
  the entities the question names; (2) embedding search + LLM relevance judgment gathers
  candidate attributes/definitions per entity; (3) **deterministic grade: coverage =
  share of entities with a candidate within the distance threshold**.
- The calling agent decides from the number: coverage 0.5 with "no term covers *ad spend*"
  → the agent says what the data *can* answer and asks, instead of generating SQL against
  a concept that doesn't exist (README quickstart, step 6).

### Agent interface
- Read-only MCP server (FastMCP): `check_readiness`, `search_terms`, `get_term`,
  `get_term_columns`, `get_term_sql_attributes`, `get_sql_attribute`, `describe_table`,
  `check_answerable`, `ask_question` — every call runs as the signed-in user.
- Four separately configured **model roles** — `REASONING`, `NON_REASONING`, `EMBED`,
  `RERANK` — any OpenAI-compatible endpoint; NIM by default, self-hostable.

---

## 2. CA-RAG GraphRAG (VSS Blueprint) — feature inventory

### Ingestion / graph construction
- Corpus is VLM dense captions of video chunks (plus subtitles). Chunking 500 tokens /
  10 overlap by default (`graph_rag/ingestion/graph_ingestion.py`).
- Extraction is a LangChain graph transformer with a fallback transformer and retries
  (`ingestion/base.py` `aconvert_to_graph_documents`, `_extract_entities_with_fallback`).
  **The schema is config, not induction**: `node_types` param, defaulting to
  `[Person, Vehicle, Location, Object]`; `relationship_types` default empty (open).
- **Hybrid graph**: content-centric (Chunk nodes `PART_OF` Document, `NEXT` / `SIMILAR`
  chunk relationships) *and* entity-centric (entities extracted from captions, chunks
  linked by `HAS_ENTITY`) — VSS FAQ, docs.nvidia.com.
- Entity embeddings are created for vector entity search; optional node deduplication
  gated on an embedding similarity threshold (`deduplicate_nodes`, `duplicate_score_value`).
- VSS 2.4 additions (developer blog): entity deduplication in the KG, cross-camera
  entity merging via graph postprocessing, Neo4j **or** ArangoDB backends, cuGraph
  acceleration of graph functions.

### Retrieval — three tiers of increasing agency
1. **Basic GraphRAG** (`retrieval/graph_retrieval.py`): vector search over entities →
   the chunks mentioning them, **ranked by how many matched entities each chunk
   contains** (`planner_constants.py` `ENTITY_SEARCH_QUERY`: chunks ordered by distinct
   matched-entity count), plus chunk vector search.
2. **Advanced GraphRAG** (`retrieval/adv_graph_retrieval.py`): a question-analysis LLM
   call first — `QUESTION_ANALYSIS_PROMPT` returns JSON only: entity types **drawn from
   the graph's available type list**, relationships of interest, time references, a
   `similarity | temporal` retrieval strategy, and a sort key — then targeted retrieval
   executes the plan (`constants.py`).
3. **Planner GraphRAG** (`retrieval/planner.py`, `planner_retrieval.py`): a LangGraph
   state machine with **separate planner and executor agents**. The thinking agent
   never calls tools: it reasons in `<thinking>` tags and emits structured XML
   `<execute>` blocks, then `[Pause]`; an execution node parses and runs the tools;
   results return for interpretation and replanning; a separate response agent writes
   the final answer (`graph_rag/prompt.py`).
   - Tools are **self-documenting**: each tool class (`ChunkSearch`, `ChunkFilter`,
     `EntitySearch`, `BFS` traversal, `NextChunk`, `ChunkReader` = VLM visual QA over a
     chunk) generates its own prompt section — XML format, use case, rules — so the
     planner prompt is assembled from the tools that actually exist
     (`prompt.py` `PromptCapableTool`).
   - An **evaluation prompt** is injected as standing loop policy: never repeat an
     identical failed call; conclude when repeated calls converge on the same answer;
     a concrete fallback ladder (search specific entities → decompose complex terms →
     read the top hit directly → try adjacent chunks); temporal disambiguation rules
     (first = earliest timestamp, after X = strictly later, …) — `prompt.py`
     `create_evaluation_prompt`.
   - Response-agent rules: evidence-based answers with timestamps/locations, **no
     internal IDs in the output**, and the literal string "No relevant information
     found" when nothing was found.
- A fourth path, GNN retrieval (`retrieval/gnn_retrieval.py`), uses a learned graph
  neural network retriever — present in the repo, not part of the default flows.

### What CA-RAG does *not* have
No ontology induction, no entity-resolution funnel (threshold dedup only), no
bitemporal model, no review queue, no decision ledger, no answer evaluation harness.
Its governance story is the planner's prompt rules; its correctness story is the
response agent's evidence discipline. (Stated plainly: on governance, our stack is
ahead of this repo; on retrieval agency, it is ahead of ours.)

---

## 3. Evaluation — auto-ontology-eval

- **Design**: the same model answers the same questions twice — **control arm**
  (`schema_only_sql`: question + raw schema dump, one prompt, no tools) vs **treatment
  arm** (`auto_ontology_sql`: the Auto-Ontology agent retrieving its own context) —
  on NeMo Gym (`NVIDIA-NeMo/Gym`).
- **Scoring is deterministic execution comparison**: each arm's SQL and the gold SQL
  are executed against the same database and result sets compared (BIRD execution
  accuracy; BEAVER `ex_acc`). **No LLM judge.**
- **Output is a single accuracy difference plus the per-question fixed/broke lists** —
  which questions the ontology fixed and which it broke — so the delta is auditable
  question by question, not a vibes average.
- Benchmarks wired: BIRD (1,534 dev), BEAVER (100-question dw sample), FDABench-Lite
  (169), Wide World Importers (41), BIRD-Interact (multi-turn, separate harness).
  Leaderboard claims (#1 BEAVER, #2 BIRD-Interact) are the repo's own badges —
  vendor-reported, not independently verified here.

---

## 4. Adoption list — mapping to our stack

Our status key: **HAVE** = already true in the live stack · **PARTIAL** = mechanism or
data exists but the behavior doesn't · **GAP** = absent. Verdict: **ADOPT** = build it ·
**ADAPT** = take the pattern, bent to our rails · **SKIP** = don't. Effort: **S** = rule/
prompt change or one CLI command · **M** = new stage behavior + verification · **L** =
new subsystem.

| # | NVIDIA mechanic (source) | Verdict | Ours | Lands in | Effort | Priority |
|---|---|---|---|---|---|---|
| 1 | A/B eval: same model ± ontology, deterministic execution verifier, fixed/broke lists (auto-ontology-eval) | **ADOPT** | **GAP** — our `verify` gates check graph integrity (19 gates); nothing measures answer quality or whether the ontology/GraphRAG loop beats plain vector search | New eval harness: per-graph seed question set with expected grounded facts; run on answering/pipeline changes; deterministic fact-presence scoring; fixed/broke report per run | M | **P1** |
| 2 | Corpus profiling before schema work: sampled distinct-ratio uniqueness, low-cardinality value census, date-format inference — all SQL/rules, zero model calls (AO per-table pass) | **ADOPT** | **GAP** — import goes straight to extraction; the ontology stage has no profile artifact to reason from | Pipeline intake: a typed `profile` step (source inventory, heading/section structure, name & term frequencies, date formats, value censuses) emitted as JSON, consumed by ontology + vocabulary discovery | M | **P1** |
| 3 | LLM schema induction under a restrictive prompt contract: one term per table unless true junction, every column assigned exactly once, forbidden relation classes, variant naming (AO `term_extractor`) | **ADOPT** | **GAP** — our schema comes from packs or an ontology job's free reasoning; there is no induction procedure and no draft artifact | Ontology stage, new-domain mode: profile (#2) + sample chunks → propose labels/types/pattern triplets with definitions + synonyms → written as a **draft pack file** in `custom.relate/ontologies/` + review items; never stamped from the draft directly | M | **P1** |
| 4 | Certification gate + preserved edits: draft → test with real questions → certify; recompilation touches only un-termed tables; certified work survives (AO Generate/Certify) | **ADAPT** | **PARTIAL** — review queue + ontology jobs exist; no `certified` state on stamped terms, and nothing stops a re-stamp/reconcile from overwriting a human-approved definition | House ontology + `stamp`/`reconcile`: `certified` flag on OntologyClass/OntologyProperty; tools refuse to overwrite certified terms (report instead); `verify` gate checks it; induction drafts (#3) land uncertified by construction | S–M | **P1** |
| 5 | Answerability pre-check with a deterministic coverage grade; below coverage → clarify with what IS covered (AO `check_answerable`) | **ADOPT** | **PARTIAL** — the grounding rule already forces "that's not in this graph", but only *after* retrieval fails, with no number and no structured offer of the covered alternative | Hook worker + bot answering flow: a coverage step in `relate-search` (question entities vs graph matches → coverage score in the JSON); below threshold the reply names the uncovered entity and the nearest covered ground, per their ad-spend example | S–M | **P1** |
| 6 | Tool-side validation of agent calls: names checked against the catalog AND against what retrieval actually returned; unknown names rejected with closest-match suggestions; errors fed back (AO `run_sql`/`submit`) | **ADAPT** | **PARTIAL** — our agentic loop (upgraded 2026-11-16: classify → tool-per-gap → sufficiency check, ≤4 rounds) trusts the slugs it traverses to; a hallucinated slug fails as an empty result, not a named rejection | Bot/hook worker loop rules + `relate-search`/`node` behavior: traversal targets must come from a prior round's results; an unknown slug returns exit 3 with nearest real slugs (the CLI already has the not-found code — surface candidates with it) | S | **P1** |
| 7 | Published loop budgets + duplicate-call discipline: numeric caps per tool class; an identical repeat isn't re-run but still burns budget; refusal is a first-class outcome (AO Answer limits) | **ADOPT** | **PARTIAL** — we cap rounds (4) but have no per-tool budgets and no repeat-call rule; a stuck loop can re-issue the same search until the round cap | Bot/hook worker instructions + skill §8: per-class budgets (searches, traversals, source reads), identical-call dedup with budget burn, explicit refusal state written to the Question node | S | **P2** |
| 8 | Question analysis → structured retrieval plan: entity types constrained to the graph's real type list, relationships, time refs, strategy + sort, JSON only (CA-RAG AdvGRAG) | **ADAPT** | **PARTIAL** — our classify step does local/global routing; it doesn't emit types/relations/time windows, and the plan isn't validated against the stamped ontology | Answering loop classify step: emit the fuller plan; validate its types against the target graph's in-graph OntologyClass names deterministically; `temporal` strategy maps onto our bitemporal as-of reads (validFrom/recordedAt windows) — their video-timestamp strategy is the same shape as our two clocks | S | **P2** |
| 9 | Evaluation guidance as standing loop policy: no identical repeats, conclude on convergence, fallback ladder, temporal disambiguation rules (CA-RAG planner evaluation prompt) | **ADOPT** | **PARTIAL** — our sufficiency self-check exists as a concept; their ladder is more concrete (search entities → decompose terms → read the top hit's source → adjacent items) | Bot/hook worker instructions + skill §8: replace the generic sufficiency text with the ladder, bent to our tools (relate-search → node reads → SourceDocument content → neighbor expansion) | S | **P2** |
| 10 | Data-confirmed inferred links: a proposed relationship is stored only if a deterministic check against the data confirms it (AO semantic FK: distinct-value containment + an actual join returning rows) | **ADAPT** | **PARTIAL** — our evidence ladder governs *identity* merges strictly, but an extracted relationship lands on extraction confidence; there is no post-extraction confirmation check for edges | Import stage + `write-batch`: an inferred edge type must be confirmed against its source chunk (both endpoints present, pattern attested) before it applies as asserted; unconfirmed stays lead-grade, mirroring our SIMILAR_TO discipline | M | **P2** |
| 11 | Hybrid content+entity graph; chunks ranked by matched-entity frequency (CA-RAG ingestion + entity search) | **ADAPT** | **PARTIAL** — skill §4 prescribes the lexical/chunk layer; the pipeline gap list records it as **not built** (no chunk nodes, descriptions first-wins). NVIDIA ships exactly this pattern in production | Pipeline import (chunk layer build — already our known gap; this raises its rank) + `relate-search`: add per-chunk matched-entity frequency as a traversal-leg signal when chunks exist | L / S | **P2** |
| 12 | Answer returns its working: SQL + steps with every answer (AO Answer) | **ADAPT** | **PARTIAL** — grounding rule requires named sources; the *path* (which searches, which traversals, which rounds) isn't persisted with the answer | Question-node write in the answering loop: record the rounds' tool calls + result counts alongside the embedding, so any answer is replayable from the graph; decision ledger already gives the pattern | S | **P3** |
| 13 | Self-documenting tools: each tool generates its own prompt section, so agent instructions can't drift from the tool surface (CA-RAG `PromptCapableTool`) | **ADAPT** | **PARTIAL** — CONNECTOR.md is hand-maintained; the correctness audit already caught docs-vs-reality drift once | Connector: generate the answering loop's tool list from the CLI's own usage/JSON surface at worker start (or a `relate tools` manifest command the bot reads), instead of prose copied into prompts | S | **P3** |
| 14 | Learn loop: certified corrections + usage folded back into the ontology (AO Learn; query history mined for SQL attributes) | **ADAPT** | **PARTIAL** — review resolutions + decision ledger exist; usage isn't mined. Our analog of their query history is the Question-node log + search misses | Ontology stage: mine Question nodes + zero-result searches as vocabulary-discovery input (skill §2 counting — specified, unbuilt); their "first 10 found, ranking not active" honesty is the bar for our first version too | M | **P3** |
| 15 | Planner/executor agent split (CA-RAG planner: thinking agent plans, execution node runs tools) | **SKIP** (mostly) | Our answering worker is one agent over typed tools; the split buys plan auditability at ~2× model calls per round. The audit trail it produces is covered cheaper by #12 | — | — | — |
| 16 | Entity dedup by embedding-similarity threshold at ingestion (CA-RAG `deduplicate_nodes`) | **SKIP** | Deliberate non-adoption: threshold-merging on embeddings is evidence-ladder level 1, which our rules say is *never* sufficient. Our normalize-scan + review band is strictly stronger | — | — | — |
| 17 | GNN learned retriever (CA-RAG `gnn_retrieval`) | **SKIP** | Needs model training + GPU stack; our deterministic hybrid search + rerank (landed 2026-11-16) covers the need at our scale | — | — | — |
| 18 | NIM model-role endpoints (REASONING/NON_REASONING/EMBED/RERANK as NIM services) | **SKIP** | GPU microservices we don't run; loopback rail. Our role separation already exists by stage (mechanical tools vs reasoning stages vs local embeddinggemma), and our rerank is deterministic features, not a model | — | — | — |
| 19 | NeMo Retriever / nv-ingest extraction NIMs (page-elements, OCR, table-structure) feeding ingestion | **SKIP** (the NIMs) | GPU services; the *need* (Office/OCR ingestion) is already on our backlog from the Utopia teardown (#20 there) and doesn't require NVIDIA's stack to fill | — | — | — |
| 20 | Ossie YAML ontology import/export (AO) | **SKIP** | Portability to external semantic-model tools is not a need; our packs live in-repo as TTL + Cypher with the stamp tool as the interchange | — | — | — |
| 21 | Term families for schema copies (AO `OLD_`/`NEW_` prefix copies) | **SKIP** (for now) | No multi-copy relational sources in Johnny's graphs. Caveat worth one line: dated memory/research files are copy-families in spirit — if imports ever span versioned file sets, this rules-based grouping is the pattern to reach for | — | — | — |
| 22 | Readiness check as a named agent-facing tool (AO MCP `check_readiness`) | **SKIP** (build) | `relate status` already answers it; Relate's own serve exposes an MCP surface if a client ever needs one — our typed interface is the CLI by design | — | — | — |

Already **HAVE** (no adoption needed, listed so nobody rebuilds them): an agentic
answering loop with local/global classification, tool-per-gap selection, and a
sufficiency self-check (upgraded 2026-11-16 — CA-RAG's planner is the same genus,
one generation more elaborate) · hybrid retrieval with a deterministic rerank stage
(`relate-search --rerank`, landed 2026-11-16) · evidence-only merges with a review
band and reversible merge/unmerge + decision ledger (Auto-Ontology has **no**
equivalent — its inferred links are data-confirmed, but it has no identity-resolution
governance at all) · bitemporal retire-never-delete with as-of reads (neither NVIDIA
repo has a temporal model) · contradiction detection/contest machinery (neither
NVIDIA repo has one) · ontology cold-start packs + in-graph stamping (AO generates
drafts for *relational* sources; for our document graphs the packs + induction in
#3 are the route).

---

## 5. Not worth it for this stack

| Feature | Why not |
|---|---|
| NIM microservices anywhere in the path (LLM/embed/rerank NIMs, hosted or self-hosted) | GPU services; violates the loopback, no-cloud-dependency shape of the stack. Our inference is agent-side, embeddings are local embeddinggemma. |
| KumoRFM predictions (`predict` tool) | A hosted service that uploads connected tables to a third party — a non-starter under our data rails, and prediction is not the graph's job. |
| Text-to-SQL as the answering paradigm | Our graphs are the data; there is no relational source under them to generate SQL against. What transfers is the *loop discipline* (validation, budgets, answerability), not the SQL. |
| Embedding-threshold entity dedup (CA-RAG) | Directly conflicts with the evidence ladder — similarity alone never merges, full stop. |
| GNN retrieval | A trained model where a deterministic fusion + rerank already works; unjustifiable machinery at 122-node scale. |
| VSS video machinery (VLM captioning, ChunkReader visual QA, cross-camera tracking) | Domain machinery for video corpora; our sources are text. The *pattern* underneath (read the source directly when metadata is insufficient) is already our loop's source-reading step. |
| Postgres/pgvector as a second store beside the graph (AO) | AO needs it because its ontology is *about* external data. Our ontology lives in the graph itself (stamped) — a second store would split the truth. |
| Multi-user auth/RBAC around the ontology (AO web app, per-user MCP) | Single user, loopback-only; the binding is the access control. |

---

## 6. Top 5 adoptions, in priority order

1. **An A/B answer eval with a deterministic verifier.** Auto-Ontology's eval repo asks
   the only question that settles whether any of this works: same model, same questions,
   with vs without the ontology — scored by executing the results, no LLM judge — and
   publishes which questions the ontology fixed and which it broke. We run 19
   deterministic gates on graph *integrity* and zero measurement on answer *quality*.
   A per-graph seed question set with expected grounded facts, scored by fact-presence,
   reported fixed/broke per change, is the highest-leverage build in either NVIDIA repo.
   (M — new eval harness.)
2. **Ontology induction as a pipeline stage: profile → propose → certify.** NVIDIA's
   Generate flow is the complete shape our ontology stage lacks: deterministic corpus
   profiling first (no model calls), LLM term/schema proposal second — under a prompt
   contract restrictive enough to be auditable (one term per table, every column
   assigned, whole relation classes forbidden) — landing as a **draft pack**, never
   stamped directly. For our document graphs the inputs change (chunks and name
   frequencies instead of columns and distinct ratios); the shape doesn't. (M —
   ontology stage + draft-pack artifact.)
3. **Certification as a protected state.** Their rule that recompilation only touches
   un-termed tables — human-certified work is never overwritten by the next automatic
   pass, with the one exception documented in the open — is a one-flag invariant our
   stamp/reconcile doesn't yet honor. Add `certified` to stamped terms, make the tools
   refuse to overwrite them, and gate it in `verify`. Cheap, and it is what makes
   adoption #2 safe to run more than once. (S–M — CLI + house ontology.)
4. **Answerability coverage before answering.** `check_answerable` turns our grounding
   rule from a post-failure apology into a pre-flight number: extract the question's
   entities, measure how many the graph covers, and below threshold answer with what
   *is* covered and name what's missing — their ad-spend example is our "that's not in
   this graph" with a coverage score and a useful alternative attached. (S–M —
   `relate-search` coverage output + worker flow.)
5. **Tool-call validation against retrieved context, with published budgets.**
   The ReAct loop's quiet discipline: a query may only name things the catalog *and
   the session's own retrieval results* contain; identical repeats burn budget without
   re-running; budgets are numbers, not vibes; refusal is a recorded outcome. Our
   agentic loop has the rounds cap but not the validation or the budgets — this is the
   fix for the hallucinated-slug traversal, the one failure mode our loop currently
   can't distinguish from an honest empty result. (S — worker instructions + CLI
   not-found surfacing.)

*Runner-up:* corpus profiling (#2 in the table) is folded into adoption #2 as its first
step; standalone it would rank #6. The planner/executor split and self-documenting
tools are real ideas at enterprise scale — at our scale their value is covered by
recording the answering path on the Question node (#12).

---

## 7. The single biggest gap

**NVIDIA evaluates the answer; we evaluate the graph.** Their eval harness A/Bs the
same model with and without the ontology and scores executed results deterministically,
question by question — fixed and broke lists included. Our entire QA apparatus (19
verify gates, the correctness audit, the contradiction gate) proves the graph is
internally consistent, and none of it proves a single chat answer was *right*, or that
the ontology and the GraphRAG loop earn their complexity over plain vector search.
Every other gap is downstream of this one: without an answer eval, the induction stage
in adoption #2 has no quality bar to clear, and "agentic" vs "fixed loop" stays an
argument instead of a measurement. Close second: schema induction itself — NVIDIA
*generates* the draft ontology from the corpus (metadata-side) while ours is authored
from packs or renamed into existence by an audit pass; adoption #2 closes it, and
adoption #1 is how we'll know it worked.

## Addendum 2026-11-17 — adoption status after the capability swarm

- Row #1 (A/B answer evaluation with a deterministic verifier): ADOPTED-LANDED. `relate-eval` runs the same verified question set through plain search vs --rerank/--triplets, scored by executed checks only, no LLM judge. First Main run 2026-11-17: both arms 13/14 questions (mean 92.86%); treatment fixed none, broke none; standing gap q09 ("Who is Johnny's assistant?" does not retrieve the `muse` node) named in the report at ~/workspace/relate-space/eval/.
- Row #2 (corpus profiling): ADOPTED-LANDED as the induction stage's deterministic profile (counts/labels/types + pattern/property censuses + fixed term-frequency procedure) and independently as `relate vocab`.
- Row #3 (ontology induction under a restrictive contract): ADOPTED-LANDED as the pipeline `induction` stage — draft Turtle pack to ~/workspace/relate-space/ontology-drafts/ + review item; NEVER stamped by the pipeline. First live draft (bestof-smoke, 2026-11-17) proposed zero terms on a corpus the house ontology already covers — the honest result, with below-floor discoveries counted, not absorbed.
- Top-5 #2 status: profile → propose landed; "certify" remains the review-queue flow by design (a draft becomes ontology only through a separate approved stamping job).
