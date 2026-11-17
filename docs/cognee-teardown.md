# Cognee — Feature Teardown & Adoption List

**Date:** 2026-11-16 · **Method:** RepoMix run first on the repo (cloned `--depth 1` into
`~/workspace/_scratch/cognee`; pack at `_scratch/repomix-cognee.xml`, 5,275 files / 52MB /
~18.4M tokens), then the core modules, prompts, and docs read directly from the clone.
Every feature below traces to Cognee's own code, prompts, or in-repo docs — no blog-post
features. **Scope: teardown + mapping only; nothing in our stack was edited.**

Repo: `topoteretes/cognee` (Python, Apache-2.0, v1.6.8 at HEAD `5870f15`). Read alongside
`utopia-graphiti-teardown.md` and `nvidia-agentic-graphrag-teardown.md` — this file
complements them and flags overlaps instead of re-stealing.

---

## 1. What Cognee actually is

Cognee is an **agent-memory platform**: a Python library (plus REST API, CLI, MCP server)
that turns documents, code, and conversations into a persistent knowledge graph an agent
can search across sessions. Its unit of work is not the document — it is the **DataPoint**,
a Pydantic model that is simultaneously the extraction schema, the graph node, and the
vector-index record. Three stores sit underneath, all embedded/local by default:

- **Relational** (SQLite default, Postgres optional) — Data items, datasets, users,
  pipeline runs, per-item completion stamps.
- **Graph** (Kuzu/Ladybug embedded default; Neo4j, Neptune, Turso, Postgres-demo
  adapters) — `cognee/infrastructure/databases/graph/`.
- **Vector** (LanceDB default; pgvector, Turso) — one collection **per indexed field per
  type**, named `<TypeName>_<field>`.

The API verbs are `add` → `cognify` → `search`, plus `memify` (enrich an existing graph),
`improve` (conflict review), `forget`/`delete`/`prune`, and the newer session pair
`remember`/`recall` (`cognee/api/v1/`).

### The pipeline, end to end

`cognify()` runs **two chained pipelines per dataset** (`cognee/modules/cognify/memory_pipelines.py`,
task lists in `cognee/api/v1/cognify/cognify.py::get_default_tasks` / `get_indexing_tasks`):

1. **Indexing pipeline (no LLM).** `classify_documents` → chunk (`TextChunker`,
   paragraph-based, size-bounded; `cognee/modules/chunking/`) → store chunks as graph
   nodes + embed chunk text. The moment this finishes, the dataset answers `CHUNKS`,
   `CHUNKS_LEXICAL`, `RAG_COMPLETION`, and `HYBRID_COMPLETION` searches — **the corpus is
   searchable before a single entity exists.**
2. **Cognify pipeline.** `find_indexed_chunks` (reuse the stored chunks, never re-embed)
   → `extract_graph_and_summarize` (one LLM structured-output call per chunk producing a
   `KnowledgeGraph`, plus a per-chunk `TextSummary` — by default derived from the
   extraction itself, `summary_method="from_extraction"`, no extra LLM call) →
   `add_data_points` (upsert the whole DataPoint tree into graph + vector stores;
   the opt-in provenance ledger is written at this same storage seam).

Extraction is where Cognee earns its keep for us — see §2. Runs are incremental by
default: per-item stamps (`is_item_stamped`) skip already-processed items, per-item
rollback drops a failed item's artifacts without touching completed ones, and a failed
extraction leaves the indexed chunks searchable.

---

## 2. Feature inventory

### Data model — DataPoint (`cognee/infrastructure/engine/models/DataPoint.py`)
- Every node is a `DataPoint` subclass. **A field holding another DataPoint becomes an
  edge named after the field**; scalar fields become node properties. The graph schema
  *is* the Pydantic class tree.
- `metadata.index_fields`: fields to embed. Each gets its **own vector collection**
  (`Entity_name`, `DocumentChunk_text`, …) — name embeddings and text embeddings never
  share a space.
- `metadata.identity_fields`: fields whose values derive the node id via `uuid5`
  (normalization in `cognee/infrastructure/engine/utils/generate_node_id.py`: lowercase,
  spaces → `_`, strip apostrophes, class-namespaced). **The same real-world thing maps
  to the same node id on every ingestion, so graph writes merge by construction.** A
  subclass without identity fields gets a random id and can never merge — the docstring
  says so in as many words.
- Every node carries `feedback_weight` and `importance_weight` (both default 0.5),
  `version`/`updated_at`, `ontology_valid` + `ontology_uri` (the stable external IRI a
  node was grounded in, preserved end-to-end), and `source_*` provenance fields
  (pipeline, task, node set, user, content hash).
- `Entity` (`cognee/modules/engine/models/Entity.py`): `identity_fields=["name"]`,
  `index_fields=["name"]`; its type is a separate `EntityType` node reached by an `is_a`
  edge that can itself carry retrieval text. `Triplet` is a first-class DataPoint
  (`text`, `from_node_id`, `to_node_id`) — though see the deprecation note under Search.
- Typed edges: `Edge[Source, Target, RelationshipType]` (`cognee/infrastructure/engine/models/Edge.py`)
  lets a custom model declare exactly which relationship names the LLM may emit
  (`Literal[...]`) or leave them free-form (`str`); edges carry `weight`/`weights`,
  arbitrary `properties`, and `edge_text` — "rich embedding representation" text stored
  on the edge itself.

### Extraction (`cognee/tasks/graph/extract_graph_from_data.py`, `cognee/shared/data_models.py`)
- Per chunk, the LLM fills `KnowledgeGraph { nodes: [{id, name, type, description}],
  edges: [{source_node_id, target_node_id, relationship_name, description}] }`.
  The edge `description` is specified in the schema as: *"Concrete one-sentence fact
  expressed by this edge, using endpoint names."*
- The prompt (`cognee/infrastructure/llm/prompts/generate_graph_prompt.txt`; guided /
  oneshot / strict / simple variants alongside) is the most copyable artifact in the
  repo. Rules that matter: elementary types only ("Person", never "Mathematician" —
  profession goes in the description); snake_case relationship names; **coreference
  resolution — always use the most complete identifier**; edge descriptions must "use
  the endpoint names, stay dry and efficient", may carry qualifiers, and must not add
  outside knowledge ("Good: *Alice works at Acme as a platform engineer on the search
  team.* Bad: *This edge describes an employment relationship.*"); numbers stay in
  descriptions, never become nodes.
- **Chunk graphs are integrated, not concatenated**: nodes deduped by id across chunks
  (`_remove_duplicate_extracted_nodes_by_id`), edges checked against identities already
  in storage so re-runs don't duplicate (`find_existing_edge_identities`), and each
  chunk keeps `contains` edges to the graph it produced — fact-level provenance back to
  the exact passage.
- The extracted edge description is stored on the graph edge as **`edge_text`**
  (`cognee/modules/graph/utils/expand_with_nodes_and_edges.py`,
  `prepare_edges_for_storage.py`) and is the text retrieval resolves edges back into
  (`resolve_edges_to_text.py`).
- **Custom extraction targets**: `cognify(graph_model=…)` accepts any DataPoint tree as
  the schema — the ontology you want is literally the Pydantic model you pass.
  `cascade_extract` handles hierarchical documents; `extract_graph_from_code` builds
  code graphs.
- **No-LLM path**: with no LLM key, `graph_extractor="auto"` falls back to a local
  GLiNER model (`cognee/tasks/graph/gliner_demo/`) for extraction and a local embedding
  model — the whole platform runs on CPU.

### Temporal model
- Time is **reified, not propertied**: the extraction prompt makes a point in time a
  `Timestamp` node named by its normalized string (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`,
  `YYYY-MM-DD HH:MM:SS`), a stated period **one** Timestamp named `<start>/<end>`, and
  links facts to it with verb-specific edges — `born_at`, `founded_at`, `begins_at`,
  `ends_at`, `{verb}_during` for periods. Precision is never invented beyond what the
  text states. An `Event` node is created only when no concrete node can own the time.
- Relative expressions are resolved **deterministically before the LLM call**:
  `_temporal_hints_for` computes `TEMPORAL_NORMALIZATION_HINTS` against the document's
  own date and injects them into the prompt as instructions, never as content.
- `TEMPORAL` search (`cognee/modules/retrieval/temporal_hybrid_retriever.py`): hybrid
  retrieval plus a window pass — Timestamps inside the query's interval are looked up,
  chunks attached to them join the candidate set (similarity barely sees dates, so the
  window's rows are mostly outside the fetched set), and candidates are reranked by how
  tightly their best timestamp fits the window.

### Entity resolution
- **Inline resolution is identity-by-construction only** (name → uuid5, above). There
  is no LLM dedupe call in the default cognify pipeline.
- Near-duplicate merging is a separate, opt-in **memify** pipeline:
  `consolidate_entities` (`cognee/memify_pipelines/consolidate_entities.py`) — vector
  similarity ≥ 0.85 + name match, `dry_run` supported, protected node types, cross-type
  merges off by default; sibling `consolidate_entity_descriptions` LLM-merges the
  descriptions of merged entities.

### Ontology support (`cognee/modules/ontology/`)
- `RDFLibOntologyResolver` (`rdf_xml/`) parses RDF/XML/OWL files with rdflib; optional
  **OWL 2 RL closure** expansion (`owlrl`) before lookup; matching strategies include
  fuzzy matching (cutoff 0.8).
- During extraction integration, matched entities are **canonicalized and enriched with
  the ontology subgraph** (`construct_data_points_and_edges_with_ontology.py`), in two
  modes: `annotate` (ground + enrich, keep going) and `strict`. Grounded nodes keep
  their `ontology_uri` in the stored graph, so the memory graph can be exported as RDF
  and linked outward.
- An `extract_ontology` prompt + `ontologies` API also let an ontology be produced from
  text, and the DLT/relational path uses the resolver + authoritative sources to align
  table schemas deterministically (`get_dlt_tasks`).

### Conflicts (`cognee/modules/engine/models/FactConflict.py`, `cognee/modules/improve/`, `cognee/memify_pipelines/review_conflicts_pipeline.py`)
- A conflict is a **node**: `FactConflict` keyed by (dataset, entity, attribute), with
  `kind` (`time_varying` vs `fixed`), all competing `values` + `sources`, and a full
  resolution record — `selected_fact`, `rejected_fact_ids/texts`, `resolved_by/at`,
  `resolution_reason`, `resolution_source` (review vs user; an explicit user decision
  survives later reviews while its fact still exists).
- `improve()` runs conflict review as a memify pipeline; edges carry `conflict_marks`,
  and **retrieval surfaces conflicts in the answer context** (`cognee/modules/retrieval/utils/conflict_context.py`)
  instead of silently picking a winner.

### Retrieval / search (`cognee/modules/search/types/SearchType.py`, `cognee/modules/retrieval/`)
- 23 named search types: `SUMMARIES`, `CHUNKS`, `CHUNKS_LEXICAL`, `RAG_COMPLETION`,
  `HYBRID_COMPLETION` (+ a decomposition variant that splits the question first),
  `GRAPH_COMPLETION` (+ decomposition, chain-of-thought, and context-extension
  variants), `GRAPH_SUMMARY_COMPLETION`, `TEMPORAL`, `CYPHER` / `NATURAL_LANGUAGE`
  (gated behind `ALLOW_CYPHER_QUERY`), `AGENTIC_COMPLETION`, `FEELING_LUCKY`
  (auto-selects the type), `GRAPH_REPORT`, `BROAD`, `CODE`, `CODING_RULES`, `SKILLS`.
- **`GRAPH_COMPLETION` is triplet retrieval** (`cognee/modules/retrieval/utils/brute_force_triplet_search.py`):
  vector-search the node index-field collections and the `EdgeType_relationship_name`
  collection → project the matching fragment (whole graph or a seeded neighborhood)
  into an in-memory `CogneeGraph` → map vector distances onto nodes *and* edges →
  `calculate_top_triplet_importances` scores each triplet combining endpoint/edge
  distances (unmatched elements pay a fixed `triplet_distance_penalty` of 6.5),
  `importance_weight`, and `feedback_weight × feedback_influence` → top-k triplets are
  resolved to text lines and handed to the LLM. **The unit of retrieval is the fact,
  not the node.**
- `GRAPH_SUMMARY_COMPLETION` answers corpus-level questions from hierarchical global
  summaries built by the `global_context_index` memify pipeline (bucket summaries →
  root summary), the same local/global split as GraphRAG community reports.
- Deprecation worth knowing: **per-triplet embeddings were removed** (SDK-1115) and
  `TRIPLET_COMPLETION` now aliases to `GRAPH_COMPLETION` — Cognee tried embedding
  triplets as vectors and backed away; current triplet ranking is distance-combination
  over node/edge-type vectors plus graph structure, not a triplet vector.

### Memify — the graph improves after ingestion (`cognee/api/v1/memify/`, `cognee/memify_pipelines/`, `cognee/modules/memify/`)
Named, re-runnable enrichment pipelines over an existing graph, each a
detect-task → enrich-task pair under the dataset lock:
- `apply_feedback_weights`: session QA feedback (thumbs/ratings captured during
  `recall`) is blended (alpha) into the `feedback_weight` of the nodes/edges that
  produced the answers — which then **changes future triplet ranking**. Use makes the
  graph measurably more useful; nothing else in this teardown set has that loop.
- `cross_connect_entities`: proposes new edges between entities that are similar
  (≥ 0.5) and share neighborhood overlap (≥ 0.2), confidence-gated (≥ 0.7), capped per
  node, `dry_run` available.
- `consolidate_entities` / `consolidate_entity_descriptions` / `review_conflicts` /
  `global_context_index` / `persist_sessions_in_knowledge_graph` /
  `persist_agent_trace_feedbacks_in_knowledge_graph` (agent traces and their feedback
  become graph content).

### Sessions & agent memory
- `remember()` = ingest + cognify with session handling; `recall()` = search with
  session context and feedback capture (`cognee/api/v1/remember/`, `recall/`;
  `docs/recall-vs-search.md` is admirably honest about the difference).
- **Session distillation** (`cognee/modules/session_distillation/`): a curator/writer
  pair of prompts distills session lessons into durable graph memory instead of letting
  transcripts pile up as chunks.

### Ingestion (`cognee/api/v1/add/`, `cognee/infrastructure/loaders/`)
- Loaders for text, code, CSV, audio, image, video in core plus external loaders
  (PDF/Office via the external loader set); `add` accepts raw text, files, URLs, and
  data streams; a deterministic DLT path turns relational manifests into row chunks +
  schema-derived FK edges with **no LLM at all**.

### Audit / provenance
- Opt-in (`PROVENANCE_TRACKING`) **hash-chained ledger** recorded at the `add_data_points`
  storage seam — every writer covered, not just cognify — with optional HMAC-SHA256
  external anchoring so a rewritten-and-rechained ledger is detectable
  (`cognee/modules/provenance/`, `cognee/modules/cognify/config.py`).
- Pipeline runs are first-class relational records with per-item status, progress
  events, and rollback handlers (`cognee/modules/pipelines/`).

### Maintenance
- `forget()` / `delete` remove data items or whole datasets across all three stores
  (the unified engine has a dedicated `provenance_delete_planner`); `prune` clears
  system data. Deletion is hard and total by design.

### Evaluation (`cognee/eval_framework/`, `evals/`)
- A shipped benchmark harness: corpus building → QA → evaluation → HTML dashboard in
  one command (`cognee eval --benchmark HotPotQA --engine direct_llm`). Benchmark
  adapters for **HotPotQA, Musique, TwoWikiMultiHop, LongMemEval**, a dedicated
  **LoCoMo** runner (conversations ingested as dated 6-turn windows), and a **BEAM**
  suite whose QA prompts include contradiction-resolution, knowledge-update, and
  event-ordering categories. Judges: DeepEval or a direct-LLM judge.

---

## 3. Adoption list — mapping to our stack

Verdicts: **ADOPT** = take the mechanism as-is · **ADAPT** = take it, reshaped to our
rules (deterministic tools, evidence-only merges, retire-never-delete) · **SKIP** = not
for this stack. Effort: **S** = prompt/rule change or one CLI command · **M** = new stage
behavior or store + verification · **L** = new subsystem/UI surface.

| # | Cognee mechanism (where it lives) | Verdict | Concrete change in our stack |
|---|---|---|---|
| 1 | Per-chunk `KnowledgeGraph` extraction: nodes + relationship edges + mandatory one-sentence fact per edge (`cognee/shared/data_models.py`; `tasks/graph/extract_graph_from_data.py`) | **ADOPT** | New import-stage behavior: SourceDocuments are chunked and extracted into entity↔entity edges, not just MENTIONS/DESCRIBED_IN attachments. The pipeline's extraction contract becomes Cognee's schema verbatim. |
| 2 | The extraction prompt's discipline: elementary types, snake_case verbs, most-complete-name coreference, dry fact descriptions with qualifiers, no outside knowledge (`infrastructure/llm/prompts/generate_graph_prompt.txt`) | **ADOPT** | Copy the prompt rules into the pipeline's extraction step (and the skill). Cheapest high-leverage change in this whole file — it is a text file, not a subsystem. |
| 3 | Edge fact text stored on the edge (`edge_text`) and used as the retrieval text for that edge (`modules/graph/utils/expand_with_nodes_and_edges.py`, `prepare_edges_for_storage.py`, `resolve_edges_to_text.py`) | **ADOPT** | `write-batch` gains a required `fact` property on fact edges; embeddings stage embeds edge facts (embeddinggemma is already local). Same destination as Graphiti steal #3 — Cognee's prompt + storage path is the concrete implementation to copy. |
| 4 | Triplet-level retrieval: rank (source, edge, target) by combined node/edge vector distance + structure + weights, resolve top-k triplets to text as the answer context (`modules/retrieval/utils/brute_force_triplet_search.py`; `CogneeGraph.calculate_top_triplet_importances`) | **ADOPT** | `relate-search` gains a triplet mode: score edges by endpoint similarity + edge-fact similarity, return fact lines ("A —works_at→ B: fact") instead of node lists. The Space chat answers from facts, with the fact as the citation. |
| 5 | Identity-by-construction: deterministic id from normalized name + class namespace; merges happen at write time (`infrastructure/engine/models/DataPoint.py`, `utils/generate_node_id.py`) | **ADAPT** | Our slug is already name-derived; make the connector compute it deterministically (same normalization: lowercase, spaces→_, strip ') and treat same-slug writes as upserts by construction. Keep our evidence-only rule for anything fuzzier — Cognee's exact-name identity is the floor, not the ceiling. |
| 6 | Timestamp reification: time as nodes, `{verb}_at` / `{verb}_during` edges, precision never invented (extraction prompt §2; `tasks/graph/extract_graph_from_data.py::_temporal_hints_for`) | **ADAPT** | Extraction writes Timestamp nodes + verb_at edges alongside our bitemporal props. Props keep answering "as of when was this true"; Timestamp nodes make "what happened in March 2026" traversable and searchable. Complements Utopia/Graphiti temporal steals; replaces none of them. |
| 7 | Deterministic temporal hints resolved before the LLM call (relative dates → absolute, injected as instructions) | **ADOPT** | Import stage resolves "last Tuesday" / "in March" against the source document's own date in the typed tool layer and passes resolved hints into the extraction prompt. Reasoning reserved for the genuinely ambiguous — our determinism rule, implemented their way. |
| 8 | Two-stage availability: index chunks first (searchable immediately), extract second, reuse stored chunks (`modules/cognify/memory_pipelines.py`) | **ADAPT** | Pipeline stage order: chunk + embed + chunk-search live before extraction runs, so a long import answers questions mid-run instead of only at the end. Our bot already reports stage progress; this makes the intermediate state useful, not just visible. |
| 9 | Chunk→fact provenance: each chunk holds `contains` edges to exactly the graph it produced; edge identities checked against storage so re-runs don't duplicate (`integrate_chunk_graphs`) | **ADAPT** | Passage-level provenance under our SourceDocuments: chunk nodes between document and fact edges, so every fact edge names its passage, not just its document. This is Utopia steal #7 (verbatim-quote provenance) arriving via Cognee's construction path — take it once, from here. |
| 10 | Per-field vector collections: name embeddings and text embeddings in separate collections per type (`DataPoint.metadata.index_fields`) | **ADAPT** | Embeddings stage writes two vector sets per node (name, summary/fact) instead of one blended vector; `relate-search` queries the name collection for entity entry and the text collection for fact entry. |
| 11 | OWL/RDF grounding at extraction time: rdflib resolver + fuzzy match (0.8) canonicalizes extracted entities to ontology classes and preserves `ontology_uri`; annotate vs strict modes (`modules/ontology/`) | **ADAPT** | When an extracted name matches a stamped OntologyClass in the target graph, the import stamps `ontologyClass` + `ontologyUri` on the node at write time. Our ontology already lives in-graph; this grounds *instances* to it during import instead of auditing after. |
| 12 | Feedback weights on every node/edge + `apply_feedback_weights` memify pass blending session feedback into ranking weights (DataPoint fields; `memify_pipelines/apply_feedback_weights.py`) | **ADOPT** | `feedbackWeight`/`importanceWeight` props on nodes and edges (default 0.5); a new pipeline category `memify` updates them from Space chat outcomes; triplet scoring (row 4) multiplies them in. Neither Graphiti nor Utopia has this loop. |
| 13 | Memify as a named, re-runnable enrichment layer over a finished graph (`api/v1/memify/`, `memify_pipelines/` registry) | **ADAPT** | Our `dream` category grows up into a memify family: consolidate, cross-connect (as leads), feedback, global-summary — each a named job with dry-run, instead of one monolithic dream pass. |
| 14 | `FactConflict` nodes: per-(entity, attribute) conflict records with values, sources, selected/rejected facts, and user decisions that survive re-review (`modules/engine/models/FactConflict.py`; `modules/improve/`) | **ADAPT** | Our contested pairs are edge flags + review items; Cognee's shape is cleaner — one conflict node per contested attribute carrying both sides and the resolution record. Adopt the shape into the review store; keep our retire-and-link resolution mechanics. |
| 15 | Conflicts surfaced in answer context instead of silently resolved (`modules/retrieval/utils/conflict_context.py`) | **ADOPT** | Space chat answers name contested facts as contested ("the graph holds two values for X; you picked A on <date>") — a one-line change to the answering loop once row 14 exists. |
| 16 | Global context summaries: hierarchical bucket→root summaries over the whole graph for corpus-level questions (`memify_pipelines/global_context_index.py`; `GRAPH_SUMMARY_COMPLETION`) | **ADAPT** | Dream/memify writes a stored global summary node per graph (from community summaries), giving the answering loop a real global entry point instead of a label census. Extends Graphiti steal #10 from communities to the whole graph. |
| 17 | Question decomposition variants: split a multi-hop question, search per part, merge ranked results (`HYBRID_COMPLETION_DECOMPOSITION`, `GRAPH_COMPLETION_DECOMPOSITION`; `modules/retrieval/utils/query_decomposition.py`, `merge_results.py`) | **ADAPT** | One addition to the agentic answering loop: when the self-check finds a multi-hop gap, decompose instead of re-searching the same string. Small, surgical, ours to gate. |
| 18 | Session distillation: curator/writer prompts turn session transcripts into durable graph facts (`modules/session_distillation/`) | **ADAPT** | The dream/memify pass distills Space chat history (questions asked, corrections Johnny made) into fact edges and Question-node links — sessions become a source, not exhaust. |
| 19 | Benchmark harness shape: adapters for HotPotQA / LoCoMo / LongMemEval, dated-window ingestion for conversations, QA categories for contradiction & knowledge-update (`eval_framework/`, `evals/`) | **ADAPT** | Copy the harness *shape* for the answer-eval lane the NVIDIA teardown already prioritized: a small fixed question set over Main (asked of the graph, scored deterministically), plus a LoCoMo-style dated-window test if chat memory becomes a source. Don't import their stack; import their benchmark choices. |
| 20 | Custom graph models as extraction targets: the desired ontology is the schema object passed to extraction, with typed `Edge[S, T, Literal[...]]` relationship allowlists (`infrastructure/engine/models/Edge.py`; `cognify(graph_model=…)`) | **ADAPT** | Generate the extraction schema from the target graph's stamped ontology (classes → node types, properties → allowed relationship names) instead of one generic contract for every graph. Pairs directly with the NVIDIA auto-ontology lane: induced ontology stops being documentation and becomes the extraction contract. |
| 21 | GLiNER no-LLM extraction fallback (`tasks/graph/gliner_demo/`) | **SKIP** | GLiNER is NER-grade: entities without Cognee-quality relationship/fact extraction. Our local route is a local LLM (Ollama/OmniRoute) running the same prompt — relations included. Revisit only if extraction cost ever bites. |
| 22 | `forget()` hard delete across all stores (`api/v1/forget/`, `delete/`; unified `provenance_delete_planner`) | **SKIP** | Our rule is retire-and-link, never delete; file-level removal already goes to recoverable trash. A total-delete verb inside the graph tools contradicts the ledger discipline. |
| 23 | Embedded Kuzu/Ladybug + LanceDB store stack, unified graph+vector engine (`infrastructure/databases/`) | **SKIP** | Relate is our engine, chosen. Noted only as validation: a single-file embedded graph DB + local vector store is exactly the architecture Cognee defaults to as well. |
| 24 | Hash-chained provenance ledger with HMAC anchoring (`modules/provenance/`) | **SKIP** | Utopia's decision-ledger steal already covers this ground and ours landed as Decision nodes in-graph. Cognee's chain is opt-in and API-level; no new mechanism for us beyond tamper-evidence, which a single-user loopback store doesn't need. |

---

## 4. Top 5 steals, in priority order

1. **Triplet extraction as the import core (rows 1 + 2).** Replace document-attachment
   import with Cognee's per-chunk contract: chunk the source, one structured LLM call
   per chunk filling `KnowledgeGraph` under the `generate_graph_prompt` rules, edges
   mandatory and each carrying its one-sentence fact. *Build step:* new extraction stage
   in `relate-pipeline` (chunk → extract → construct) + a `relate extract` typed tool
   that validates the returned graph against the schema and hands it to `write-batch`.
   This is the direct, mechanical fix for the census in §5 — everything below it is
   leverage on top of it.
2. **Fact edges with `edge_text`, embedded (row 3).** The extracted fact sentence is
   stored on the edge and embedded by the embeddings stage. *Build step:* `write-batch`
   requires `fact` on fact edges and refuses fact edges without one; `embed-missing`
   gains an edge pass. (Graphiti steal #3 named this; Cognee supplies the prompt wording
   and storage path to copy.)
3. **Triplet-ranked retrieval (row 4).** *Build step:* `relate-search` gains a triplet
   mode — vector entry over node names + edge facts, score each candidate triplet
   (endpoint distance, fact distance, one graph-distance penalty for unmatched
   elements), return resolved fact lines. The Space chat's answering loop consumes fact
   lines as its context, so every answer is built from — and cites — traversable facts.
4. **Identity-by-construction writes (row 5).** *Build step:* the connector computes
   node identity deterministically from normalized name + class at write time (our slug
   scheme, Cognee's normalization), so the same entity mentioned in ten documents is one
   node with ten documents' worth of fact edges — no reconcile pass needed for the exact
   case, and the reconcile funnel keeps only the genuinely fuzzy work.
5. **The memify loop: feedback weights + named enrichment passes (rows 12 + 13).**
   *Build step:* add `feedbackWeight`/`importanceWeight` to the write schemas; add a
   `memify` pipeline category whose first pass blends Space chat feedback into weights
   that triplet scoring (steal 3) reads. This is the only mechanism in any of the four
   teardowns that makes the graph *more* useful the more it is used — and it is cheap
   once steals 1–3 exist.

*Runner-up:* Timestamp reification (row 6) — it loses the #5 slot only because our
bitemporal props already cover as-of reads; verb_at/Timestamp nodes are the search-side
refinement, and they fall out of steal 1's prompt almost for free when we choose to
enable that prompt section.

---

## 5. Why our graph doesn't surface useful data — and what fixes it

The live census of Main (verified 2026-11-16): **122 content nodes** (Person 50,
SourceDocument 65, Group 7) and content edges of exactly five kinds — **MENTIONS 116,
DESCRIBED_IN 56, IN_JOHNNYS_NETWORK 55, ABOUT 7, ASSISTANT_OF 1**. Every one of those
edge types says something about a *document* or about Johnny's network list. Not one of
them states a fact *between two entities*. Who Anthony is to Sky's, what Sky's does,
what Example is connected to, what changed in November — all of that exists only as
prose inside SourceDocument `content`/`summary` properties.

Consequences, mechanically:

- **Traversal is empty.** A graph query can only walk edges that exist. "How is X
  related to Y" has no path to walk unless a document mentions both — co-mention is the
  only relationship the graph can express.
- **Retrieval ranks containers, not facts.** Search embeds nodes; the best possible
  answer the answering loop can build is "these documents/people are similar to your
  question." The fact itself is never the retrieved unit, so it can never be the cited
  unit either.
- **The graph adds nothing over the files.** Everything Main can answer, `grep` over
  `~/memory/` can answer. A graph that only indexes its sources is a slower filing
  cabinet — Johnny's verdict is literally correct.

Which Cognee mechanisms fix which part:

| Defect | Cognee mechanism | Why it fixes it |
|---|---|---|
| Facts live in prose, not edges | Per-chunk `KnowledgeGraph` extraction with mandatory relationship edges (row 1) | The extraction contract *requires* entity↔entity edges; a chunk that yields only entities and no relationships is an incomplete extraction, visibly. |
| Edges carry no meaning | One-sentence fact per edge, stored as `edge_text` (rows 2–3) | The edge becomes a readable, embeddable, citable statement — the graph's atomic unit of usefulness. |
| Answers built from node neighborhoods | Triplet-ranked `GRAPH_COMPLETION` retrieval (row 4) | The retrieved unit is the fact triplet; synthesis starts from statements, not from "similar documents." |
| Entities fragment across documents | Identity-by-construction ids (row 5) | One node per real-world thing means its fact edges *accumulate* into a neighborhood — the network effect a graph exists for. Our 55 hand-maintained IN_JOHNNYS_NETWORK edges are what this looks like when done manually. |
| Time is unqueryable | Timestamp nodes + `{verb}_at` edges + TEMPORAL rerank (row 6) | "What happened in November" becomes a window lookup over traversable edges instead of a substring search over prose. |
| Use doesn't improve the graph | Feedback weights + memify passes (rows 12–13) | Answers Johnny rates, corrections he makes, and candidates he confirms change future ranking and structure — the graph compounds. |

One honest caveat Cognee itself supplies: they **removed** per-triplet embeddings
(SDK-1115) after shipping them. The lesson is that fact *text on the edge* is the
durable win; how you rank triplets can stay simple (distance combination + weights)
and still beat node-level retrieval. We should copy the current design, not the
deprecated one.

---

## 6. What Graphiti / Utopia already covered better — don't double-adopt

- **Temporal invalidation.** Graphiti's edge-level `valid_at`/`invalid_at` with
  automatic contradiction-driven invalidation, and Utopia's retire-and-link temporal
  engine, are both stronger than anything in Cognee: Cognee has **no fact
  invalidation** — old facts are not closed when new ones arrive; time is handled by
  Timestamp nodes at extraction and conflict review after the fact. Our temporal
  roadmap stays with the Utopia/Graphiti steals. Cognee contributes only the
  extraction-side Timestamp convention (row 6).
- **Entity resolution.** Graphiti's funnel (identity properties → cosine ≥ 0.6
  candidates → LLM final call) and Utopia's two-channel recall with similarity tiers
  and adjudication both beat Cognee's inline story, which is exact-normalized-name
  identity plus an opt-in memify consolidation pass at 0.85. Take Cognee's
  identity-by-construction as the write-time floor (row 5); the funnel itself stays
  Graphiti/Utopia's.
- **Review & governance.** Utopia's single governed review queue, governor gate, and
  precedent-fed adjudication remain the model. Cognee's `FactConflict` is a better
  *data shape* for one slice of it (per-attribute conflicts, row 14) — adopt the
  shape, not a second governance system.
- **Retrieval reranking.** Graphiti's composable recipes (RRF/MMR/cross-encoder/
  node-distance) are a superset of Cognee's scoring sophistication. Cognee's
  contribution is the *unit* (the triplet) and the *feedback term* in the score, not
  the ranking math.
- **Decision ledger.** Utopia's append-only ledger + `changes` feed (already landed
  here as Decision nodes) covers Cognee's opt-in hash chain for our purposes (row 24).
- **Where Cognee genuinely beats both:** the extraction contract as a single copyable
  artifact (schema + prompt); identity-by-construction as a default rather than a
  pipeline stage; staged availability (searchable chunks before extraction); the
  memify/feedback loop (neither Graphiti nor Utopia feeds usage back into ranking);
  OWL/RDF grounding of extracted instances at write time (Graphiti has no ontology
  files at all; Utopia's packs govern types, Cognee grounds instances to IRIs); and a
  shipped benchmark harness (neither teardown found one in the other two repos).

---

## 7. Honest limits

- **Nothing was run.** Cognee was not installed and no pipeline, extraction, or search
  was executed; extraction quality, GLiNER quality, and triplet-ranking quality are
  read from code and prompts, not measured. The eval harness exists and its benchmark
  choices are documented in-repo, but I did not run a benchmark or verify Cognee's
  published scores.
- **The repo is a moving target.** HEAD (v1.6.8, 2026-11-16) is mid-refactor:
  SDK-ticketed deprecations are in flight (triplet embeddings removed, `TRIPLET_COMPLETION`
  aliased, `remember`/`recall` layering over `add`/`search`). Anything adopted should
  be re-checked against the then-current code before building on it.
- **Skims, not reads:** `truth_subspace` (entities carry truth-alignment fields I did
  not fully trace), `agent_memory`/`agents`, the Cognee Cloud and frontend code, the
  MCP server internals, and the Neptune/Turso adapters. None of them change the
  adoption table, but they are not verified either.
- **Dedup quality is unverifiable from code alone.** Identity is exact after light
  normalization (case/spacing/apostrophes); whether the 0.85-similarity memify
  consolidation is enough in practice is an empirical question the repo doesn't answer.
- Scale behavior (the brute-force fragment projection loads the matching graph into
  memory per query) is asserted from the algorithm, not load-tested; at our graph
  sizes it is irrelevant, at Cognee-cloud sizes it's their problem, not ours.
