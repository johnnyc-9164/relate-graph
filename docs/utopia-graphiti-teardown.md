# Utopia × Graphiti — Feature Teardown & Steal List

**Date:** 2026-11-16 · **Method:** RepoMix run first on both repos (cloned `--depth 1` into
`~/workspace/_scratch/`; packs at `_scratch/repomix-utopia.xml` / `repomix-graphiti.xml`),
then READMEs, Utopia's `docs/design/*` + `docs/pipeline.md` + MCP guide, and Graphiti's core
modules read directly. Every feature below traces to the repo's own README/docs/code — no
blog-post features. **Scope: teardown + mapping only; nothing in our stack was edited.**

Repos: `deeplethe/utopia` (Rust, Apache-2.0, v0.1) · `getzep/graphiti` (Python, Apache-2.0).

---

## 1. Utopia (DeepLethe) — feature inventory

### Ingestion
- Multi-format upload: PDF, DOCX, PPTX, XLSX/XLS, ODS, CSV, TSV, Markdown, HTML, plain text, legacy encodings auto-detected — README "Knowledge ingest"; `crates/utopia-ingest/src/parsers.rs`, `table.rs`, `html.rs`.
- OCR for scans/images via MinerU service or a vision model — README; `utopia-ingest/src/mineru.rs`, `utopia-server/src/readers/ark_ocr.rs`.
- Recording transcription with speaker labels — README; `utopia-ingest/src/transcript.rs`.
- Scheduled source sync: web pages, RSS, GitHub, GitLab, Jira, Notion, Google Drive, WebDAV, S3-compatible buckets — README; `utopia-server/src/ingest_sources.rs`, `github_repo.rs`, `gitlab_issues.rs`, `jira_issues.rs`, `notion.rs`, `google_drive.rs`, `object_storage.rs`, `rss_full_content.rs`.
- Source checkpoints: a source declares where its reading stopped; sync resumes from a timestamp boundary — `docs/design/sources.md`; decisions 0013, 0072, 0075.
- Push API: external systems push observations directly in the extraction contract, stamped with the observation's own time (no LLM in between) — README use cases; decision 0054.

### Extraction
- "Open contract" extraction: per chunk, the model returns *things* and *statements* — each statement opens with its own **verbatim quote**, names subject/object in words, keeps the relation phrase as written, qualifiers keyed by the document's own role words, `when`/`ended` time words — `docs/design/extraction.md`; `crates/utopia-extract/src/open.rs`.
- Named vs described things: proper names/fixed terms resolve across documents; role phrases ("the company") exist only inside their document — extraction.md; decision 0044.
- Mood qualifier: required/planned/expected/conditional statements are marked with the passage's own mood words and **never materialize as typed facts** — extraction.md (#745).
- Per-item failure accounting: a malformed item drops alone, never the chunk; every drop lands in `extraction_drops` with one of 11 reason codes, visible in the UI — `docs/pipeline.md` §1.
- The chunk is the context: chunker rules are extraction rules; every chunk records where its words came from (document, section, offsets) — decisions 0039, 0040; `utopia-ingest/src/chunker.rs`, `provenance.rs`.
- Time mentions resolved against the document's own date as extraction proceeds — decision 0045/0064; `utopia-extract/src/time.rs`.
- Phrase alignment: free-text relation phrases align to ontology predicates, or stay *proposed* — `utopia-extract/src/phrase_align.rs`, `align.rs`; decisions 0010, 0051, 0053.

### Entity resolution
- A name is a fact: every name is a `known_as` value fact with its quote and both clocks; aliases are name facts, not a side list — `docs/design/identity.md`; decision 0041.
- Two-channel recall: exact match over name facts (incl. generic-suffix-stripped keys) + name-vector channel that only *proposes* pairs — identity.md.
- Three tiers on profile-embedding similarity: ≥0.55 attach · 0.35–0.55 create + queue for adjudication · <0.35 create quietly. "Prefer splitting over merging" — `docs/pipeline.md` §2.
- Containment recall (`Holmes` ⊂ `Sherlock Holmes`, ≥4 chars, capped per run) for the prefix blind spot — pipeline.md §2.
- Shared-name pairs queue for adjudication, never auto-merge; declared `disjointWith` (inherited down both hierarchies) hard-blocks merges — identity.md; decisions 0001, 0009.
- Adjudication: an agent judges pairs in batches of 12 with ledger precedents in the prompt; doubtful pairs get a tool-using second look; verdict rules written once, read by both prompts — identity.md; `docs/design/governance.md`; `utopia-server/src/adjudication.rs`.
- Governor gate: an automatic merge is held for a person when it can't be undone cleanly or would leave the graph (functional contradiction, derivation, cited answer) — `utopia-extract/src/governor.rs`; decision 0027.
- **Reversible merges**: `entity_merges` records everything as it was; `revert_merge` restores facts, names, qualifiers, evidence — pipeline.md §2; identity.md.

### Temporal model
- Two clocks on every fact: `valid_from`/`valid_to` (world) and `recorded_at`/`invalidated_at` (record); **every read takes `at` and `as_of` as separate parameters** — `docs/design/time.md`; decision 0019.
- Precision ladder (year→second) stored per bound; **an unknown bound is not an open bound** — unknown ends carry `attested_from/to` anchors taken from the document's own dates — time.md; decisions 0022, 0024.
- Temporal engine: on relations declared functional or inverse-functional, a new value **closes the open predecessor automatically**; engine-drawn ends are marked `end_derived` and recomputed order-independently — time.md.
- Successor grading: a successor whose start couldn't be anchored (grade C) closes nothing and opens no conflict — time.md; decision 0045.
- Fact-kind normalization: events (one moment), eternal facts (no dates), states (intervals) behave differently on write and read; empty state spans are refused — decision 0031.
- Corrections close and link: a corrected fact closes the old version and links the new one to it; nothing is overwritten — README "Bitemporal graph".

### Ontology governance
- Cold-start packs ship in the binary: schema.org, W3C Org, PROV-O, FOAF, IOF Core, picked at base creation — README; `crates/utopia-server/packs/` (`.rdf.gz`/`.ttl.gz` files + `packs/README.md`).
- Scenario packs: a vocabulary **plus the competency questions it must answer** (contract-chain, enterprise-profile, personnel-records) — decision 0073; `packs/scenarios/*.json`.
- Ontology growth loop: terms outside the packs are **counted as they appear**; common ones are proposed; a person confirms and they join the ontology — README "Ontology and cold start"; decision 0003; `utopia-extract/src/ontology_agent.rs`.
- The ontology is proposed from the open graph and **judged by its questions** (competency-question regression) — decision 0061; `utopia-server/src/ontology_regression_routes.rs`, `question_routes.rs`, `utopia-extract/src/question_agent.rs`.
- Ontology as contract: relation signatures (domain/range) are enforced at write; a reversed fact is swapped and the correction **recorded** (`direction_corrected`), never silent; if the swap is also invalid the predicate is dropped but subject/object/evidence stay — `docs/pipeline.md` §1; decision 0012.
- Out-of-vocabulary is preserved, not faked: unknown types → `proposed_type` + free-text `specific_type`; unknown predicates → `proposed_predicate`; "no relation is no relation" (empty predicate beats a fake "related to") — decisions 0009, 0010; pipeline.md §1/§3.
- Type resolution: two incomparable candidate routes (profile→class space, neighbor-vote→entity space) unioned, never scored together; retype inside the original subtree is automatic, crossing a classification axis goes to a human — pipeline.md §3.

### Conflict & review
- One review queue for all doubtful cases: low-confidence extractions, suspected duplicates, cardinality conflicts — README "Entity resolution and review"; `utopia-server/src/review_routes.rs`.
- Three conflict kinds, each with explicit resolution choices: fact-vs-fact (close old / keep both / reject new); axiom violations — self-loop, asymmetry, transitive cycle, cardinality (retract fact / relax axiom / accept both) — README "Conflict detection".
- The ontology itself is consistency-checked first, because violations of a self-contradictory ontology are noise — decision 0017.
- Agent adjudication closes the loop: the agent decides from common sense + business documents; low-confidence calls go to humans; **human decisions are recorded and used to tune the agent** — README "Agent adjudication".
- Every review queue is itself governed (who may decide, what auto-applies) — decision 0043.

### Reasoning
- Ontology axioms compile to rules: transitivity, symmetry, inverses, sub-property → forward-chaining derivation of new facts — README "Reasoning and derivation"; `crates/utopia-reason/` (`rules.rs`, `derive.rs`, `expressions.rs`).
- Derived facts are marked as derived, carry validity + confidence + what they were derived from; **an asserted fact always beats a derived one** in a contradiction; derivation is **off by default** — README.
- Business rules written by people over attribute facts conclude types or relations, with the rule + premises as the explanation — decisions 0021, 0047, 0060; `rule_routes.rs`; MCP `list_rules`/`rule_matches`.

### Retrieval / search
- Hybrid search: Tantivy full-text + pgvector vectors fused with reciprocal-rank fusion — README; `crates/utopia-search/`.
- Chat answers stream with **inline citations that open the exact source passage**; graph facts are cited too — README; `utopia-server/src/api/chat*.rs` (incl. `chat_graph_citation_tests.rs`).
- As-of search: search the base as it stood at a moment — superseded chunks keep their vectors and stay retrievable — MCP guide `search_chunks` (`as_of` param).
- Agentic retrieval: the built-in agent searches documents, walks the graph (an entity's facts as of any date; what changed in a period), and queries mounted databases — README "Agent harness and agentic RAG"; `docs/design/chat-and-mcp.md`.

### Agent interface
- MCP server per knowledge base, token-scoped; **reads are typed and dated, writes are proposals** (`remember` needs a write token and goes to a person first) — README use cases; `web/src/docs/mcp.md`.
- Typed read tools: `search_chunks`, `get_document`, `find_entities` (with name disambiguators), `entity_facts` (`at` + `as_of`), `neighbors` (grouped by predicate), `timeline`, `paths_between` (≤3 hops, time-filtered), `changes` (record-time event stream), `list_rules`, `rule_matches`, `search_docs` — `web/src/docs/mcp.md`.

### Audit / governance
- **Decision ledger**: append-only; confirming/rejecting a fact, merging/reverting an entity, rebuilding the graph each leave who + when + the object as it looked at the time; a record outlives its object, even its base — README; `docs/design/ledger.md`.
- A decision records *why*, not just what — decision 0026.
- Export says what is contested: exports mark disputed facts instead of presenting them as settled — decision 0062; `export_routes.rs`.
- Alert center for conflicts and failures needing a person — decision 0005; `alerts_routes.rs`, `alerting.rs`.
- Governance reads the ledger before it decides (precedents are inputs, not decoration) — decision 0025.

### UI
- One web console: system console + graph browser + ontology workbench — README "A complete application"; `utopia-server/src/api/graph_routes.rs`, `ontology_routes.rs`.

---

## 2. Graphiti (Zep) — feature inventory

### Ingestion
- Episodes are the unit of ingestion: raw text, message, or structured JSON, each with a `reference_time`; `add_episode` / bulk `add_episodes` integrate incrementally — **no batch recomputation** — README; `graphiti_core/graphiti.py`, `utils/bulk_utils.py`.
- Long episodes are chunked before extraction — `graphiti_core/utils/content_chunking.py`.
- Concurrent ingestion mode: a window of episodes extracts in parallel, commits in call order, and repairs only colliding items at commit — README "Concurrent Ingestion"; `graphiti_core/ingestion/` (`phases.py`, `delta.py`, `scheduler.py`, `change_set.py`).

### Extraction
- LLM extraction of entities + edges in one pass, driven by **developer-defined Pydantic entity/edge types** (prescribed ontology) or emergent types (learned ontology) — README; `graphiti_core/prompts/extract_nodes.py`, `extract_edges.py`, `extract_nodes_and_edges.py`.
- Every edge carries a natural-language **`fact` sentence** plus typed attributes — `graphiti_core/edges.py` (`EntityEdge.fact`, `attributes`).
- Temporal extraction: `valid_at`/`invalid_at` read from the text; future-tense plans use the episode reference time, soft deadlines are not `invalid_at` — `edges.py` field descriptions.
- Configurable prompt library per instance + per-prompt model routing (cheap model for dedupe, strong model for extraction) — README "Configurable Prompts" / `llm_runtime`; `graphiti_core/llm_client/`.

### Entity resolution
- Candidate funnel: exact-name matches → **identity-property matches** (developer-declared per type, e.g. `Person.email`, extracted before resolution) → semantic candidates at cosine ≥ 0.6 → LLM makes the final call — `graphiti_core/utils/maintenance/node_operations.py` (`NODE_DEDUP_COSINE_MIN_SCORE = 0.6`, `_collect_identity_property_candidate_nodes`, `_semantic_candidate_search`, `_resolve_with_llm`).
- Dedupe can be routed to **decision models** (TypeSafe Jev, OpenAI Decisions) that return probabilities with duplicate/contradiction thresholds — and are used *only* for dedupe/resolution, never generation — README "Jev dedupe"; `llm_client/jev_client.py`, `openai_decisions_client.py`.
- Edge dedupe: exact-duplicate detection on (source, target, normalized fact) including reversed direction, then LLM edge resolution — `utils/maintenance/edge_operations.py` (`find_exact_duplicate_edge`).

### Temporal model
- Edges are bi-temporal: `valid_at` / `invalid_at` (world), `expired_at` (when the system invalidated it), `reference_time` (the episode's clock) — `graphiti_core/edges.py`.
- **Automatic fact invalidation**: when a resolved new edge contradicts candidate edges, the candidates get `invalid_at` set from the new edge's `valid_at` — invalidated, never deleted — `edge_operations.py` (`_apply_temporal_invalidation`).
- Episodes carry `valid_at` = when the source document was created — `graphiti_core/nodes.py` (`EpisodicNode`).

### Ontology governance
- Prescribed + learned ontology in one system: Pydantic types up front, structure may also emerge — README.
- `edge_type_map` constrains which edge types may connect which entity-type pairs — `graphiti_core/graphiti_types.py`; `utils/ontology_utils/entity_types_utils.py`.
- (No ontology growth loop, no competency questions, no signature auto-correction — contrast with Utopia.)

### Conflict & review
- Contradiction handling is **automatic invalidation only** — there is no human review queue in graphiti-core. (Stated plainly: this is the biggest governance gap vs Utopia.)

### Reasoning
- **None.** No derivation/rule engine in the repo. Facts come from extraction or manual triplets only.

### Retrieval / search
- Hybrid search over edges, nodes, episodes, and communities: BM25 keyword + vector similarity + graph traversal (BFS), fused — README; `graphiti_core/search/search.py`.
- Named, composable **search recipes**: RRF, MMR (diversity), cross-encoder rerank, **node-distance rerank** (results re-ranked by graph distance to a center node), episode-mentions — `search/search_config_recipes.py` (20+ recipes).
- Cross-encoder rerankers: BGE, OpenAI, Gemini — `graphiti_core/cross_encoder/`.
- First-class **search filters**: node labels, edge types, valid-at windows, group — `search/search_filters.py`.
- Edges are searchable by their own `fact_embedding`; entities by `name_embedding` — `edges.py`, `nodes.py`.

### Communities & summaries
- Communities built by **label propagation** over the projection, then LLM-summarized into named CommunityNodes with their own name embeddings; incremental `update_community` for a changed neighborhood — `utils/maintenance/community_operations.py`.
- Entity summaries **evolve**: each EntityNode carries a summary regenerated from its surrounding edges — `nodes.py`; `prompts/summarize_nodes.py`.
- **Sagas**: a chain of episodes grouped as one narrative unit (SagaNode) with incremental summarization and watermarks (`last_summarized_episode_valid_at`), so long-running storylines get rolling summaries without re-reading everything — `nodes.py` (`SagaNode`); `prompts/summarize_sagas.py`.

### Agent interface
- Reference MCP server with tools: `add_memory`, `search_nodes`, `search_memory_facts`, `get_episodes`, `get_episode_entities`, `get_entity_edge`, `delete_entity_edge`, `delete_episode`, `add_triplet`, `build_communities`, `summarize_saga`, `clear_graph` — `mcp_server/src/graphiti_mcp_server.py`.
- `add_triplet`: write a structured subject–predicate–object directly, bypassing extraction — MCP server; core `add_triplet` in `graphiti.py`.
- Reference REST server (FastAPI) — `server/`; README (both reference servers ship with an explicit no-auth warning).
- `group_id` tenancy on every node/edge/episode — throughout `graphiti_core`.

### Audit / provenance
- Every edge lists the **episode uuids that produced it** (`episodes` field); episodes are first-class nodes holding the raw content — full lineage from fact to source — `edges.py`, `nodes.py`.
- (No decision ledger, no merge log: merges/invalidations are state, not an auditable event stream. Stated plainly.)

### Maintenance
- Dangling-endpoint cleanup (edges whose endpoint nodes were removed) — `utils/maintenance/dangling_endpoints.py`.
- Pluggable graph backends: Neo4j, FalkorDB, Amazon Neptune drivers — `graphiti_core/driver/`.

---

## 3. Steal list — mapping to our stack

Our status key: **HAVE** = already true in the live stack · **PARTIAL** = mechanism or data
exists but the behavior doesn't · **GAP** = absent. Effort: **S** = rule/prompt change or one
CLI command · **M** = new stage behavior or store + verification · **L** = new subsystem/UI surface.

| # | Feature (source) | Ours | Lands in | Effort | Priority |
|---|---|---|---|---|---|
| 1 | Corrections close-and-link: new fact closes predecessor's `validTo`, stamps `retiredAt`, links successor (Utopia temporal engine; Graphiti `_apply_temporal_invalidation`) | **PARTIAL** — bitemporal props + Space as-of reads exist, but import/normalization MERGE-overwrite in place; nothing retires or links | Pipeline normalization + import stage rules; skill rule | M | **P1** |
| 2 | Review queue for doubtful cases — low-confidence extractions, suspected duplicates, conflicts, each with explicit resolution choices (Utopia) | **GAP** — verify stage lists blockers in a run report; nothing persists for Johnny to decide | Space (review panel) + pipeline stages enqueue instead of silently blocking; bot surfaces queue count | M–L | **P1** |
| 3 | Edges carry a `fact` sentence + their own embedding (Graphiti `EntityEdge.fact`/`fact_embedding`) | **GAP** — our edges are bare types; only nodes are embedded | Pipeline import (write fact string) + embeddings stage (embed edges); connector search | M | **P1** |
| 4 | Three-stage resolution funnel with thresholds (exact/alias → identity props → similarity tiers → adjudication) (both) | **PARTIAL** — exact/normalized-name + evidence-only rule exist; no similarity tiering, no identity-property declarations | Pipeline normalization; house ontology (identity props per class); skill evidence ladder | M | **P2** |
| 5 | Merge log + undo: every merge recorded with before-state; revert restores facts/names/evidence (Utopia `entity_merges`) | **GAP** — merges are one-way Cypher writes | Pipeline normalization (write `(:MergeRecord)` or connector-side log before merging); connector `undo-merge` | M | **P2** |
| 6 | Decision/change ledger + `changes` feed: append-only who/when/what for every mutation decision; queryable "what changed last week" (Utopia ledger + MCP `changes`) | **GAP** — Space agent-request records cover pipeline jobs only, not graph mutations | Connector (per-graph append-only ledger + `changes` command); pipeline writeback writes entries | S–M | **P2** |
| 7 | Per-fact verbatim-quote provenance: every statement carries its source quote + chunk offsets (Utopia extraction contract) | **PARTIAL** — provenance stops at SourceDocument nodes (document level); edges don't say which passage asserted them | Pipeline import stage contract; house ontology (quote props on edges) | M | **P2** |
| 8 | Episodes as first-class provenance: every edge lists the source(s) that asserted it (Graphiti `episodes[]`) | **PARTIAL** — DESCRIBED_IN/MENTIONS link documents to entities, but a fact edge doesn't name its asserting source(s) | Pipeline import (stamp `sources` on edges); house ontology | S–M | **P2** |
| 9 | Hybrid retrieval recipes: keyword + vector + traversal fused (RRF), node-distance rerank, search filters (Graphiti) | **PARTIAL** — chat answering retrieves by node-vector cosine only; no keyword leg, no fusion, no rerank | Connector `search` command; hook worker answering flow | M | **P3** |
| 10 | Evolving entity summaries + community summaries stored on nodes (Graphiti) | **PARTIAL** — communities stage writes summaries into its run report, not onto nodes; known gap: 58/65 SourceDocuments in Main have no `summary` | Pipeline: extend communities stage + a summarize pass in normalization; fills the known summary gap | M | **P3** |
| 11 | Precision-aware time: precision per bound; unknown ≠ open; attestation anchors from the source's own date (Utopia 0022/0024) | **PARTIAL** — flat ISO strings; missing prop = unbounded conflates "unknown" with "always" | Skill rule + house ontology (`validFromPrecision`, `attestedFrom` props); Space Time section display | S–M | **P3** |
| 12 | Functional-relation auto-close: relations declared functional in the ontology close predecessors deterministically (Utopia temporal engine) | **GAP** — no functional declarations in house ontology | House ontology (`functional: true` on chosen types) + rule from steal #1 | S (after #1) | **P3** |
| 13 | Typed temporal read tools: `entity_facts(at, as_of)`, `timeline`, `paths_between`, `neighbors` (Utopia MCP) | **PARTIAL** — connector CLI has counts/labels/types/node/query/signals; no as-of-aware typed reads, no paths/timeline | Connector CLI: `facts`, `timeline`, `paths`, `changes` subcommands reusing the Space's as-of Cypher semantics | M | **P3** |
| 14 | Ontology growth loop: out-of-pack terms counted as they appear; frequent ones proposed for confirmation (Utopia) | **PARTIAL** — house ontology is static; ontology stage audits labels but never counts/proposes new terms | Pipeline ontology stage (term census + proposals in stage report → review queue #2) | M | **P3** |
| 15 | Mood guard: planned/expected/conditional statements never materialize as facts (Utopia) | **GAP** — import stage has no mood handling; a "will hire" sentence can land as a fact | Pipeline import stage rule; skill | S | **P3** |
| 16 | Signature enforcement with recorded direction-correction (Utopia) | **GAP** — house ontology declares types but no domain/range signatures; nothing corrects or records reversed edges | House ontology (domain/range per type) + import/normalization check | M | P4 |
| 17 | Derived facts from ontology axioms (transitivity/symmetry/inverse/sub-property), marked derived, asserted beats derived, off by default (Utopia) | **GAP** — no reasoning anywhere in our stack | New pipeline category `reasoning` (opt-in per job); house ontology axioms (curated — the TTL deliberately does *not* declare `DESCRIBED_IN` inverseOf `MENTIONS`) | M–L | P4 |
| 18 | `add_triplet` typed direct write (Graphiti) | **PARTIAL** — connector `query` escape hatch can write Cypher, but there's no typed, validated triplet command | Connector CLI `add-triplet` | S | P4 |
| 19 | Sagas: episode chains with incremental rolling summaries + watermarks (Graphiti) | **GAP** — SourceDocuments aren't chained; no rolling summary over a source series | Pipeline import (chain docs of one series) + summarize pass | M | P4 |
| 20 | Broader ingestion formats: DOCX/PPTX/XLSX/ODS/HTML parsing, OCR, transcription (Utopia) | **PARTIAL** — Space uploads are text formats only (md/txt/csv/json/jsonld/ttl/rdf); pipeline reads local files | Space uploads + import stage parsers (Office formats are the valuable slice) | L | P4 |
| 21 | Scenario packs: ontology pack + the competency questions it must answer (Utopia 0073) | **PARTIAL** — ontology pack + preset picker exist; no question sets, no regression run | Ontology pack (add `questions` per pack) + verify stage runs them | S–M | P4 |
| 22 | Contested-fact export: exports mark disputed facts (Utopia 0062) | **GAP** — no export command at all | Connector `export` command (depends on #2/#6 to know what's contested) | S | P5 |
| 23 | Push API for systems/agents to write observations in a fixed contract (Utopia 0054) | **GAP** — writes happen only via dispatched pipeline jobs | Connector `push` command writing statement nodes for the pipeline to materialize | M | P5 |
| 24 | Dangling-endpoint cleanup as a named maintenance op (Graphiti) | **PARTIAL** — cleaning stage audits orphans among its other checks | Pipeline cleaning (name it, count it separately) | S | P5 |

Already **HAVE** (no steal needed, listed so nobody rebuilds them): bitemporal properties +
as-of reads in the Space (live/valid/recorded modes, temporalCoverage) · evidence-only merge
*rule* (the funnel mechanics are #4, the rule itself is ours) · label-propagation communities
with summaries (Graphiti's exact method — ours writes them to the stage report, see #10) ·
ontology cold-start packs + preset picker (Utopia's packs pattern — ours are the W3C/FOAF/
schema.org standards + house ontology in `custom.relate/ontologies/`) · multi-graph tenancy
(Graphiti's `group_id` ≈ our separate graphs + registry) · an MCP surface exists at the engine
layer (Relate's own serve exposes MCP per its `--help`; our typed interface is the connector CLI
by design).

---

## 4. Not worth it for this stack

| Feature | Why not |
|---|---|
| Multi-user roles/permissions per knowledge base (Utopia owner/admin/editor/viewer, OIDC SSO) | Single user, loopback-only APIs; access control is the loopback binding itself. |
| Ontology2SQL / mounted enterprise databases (Postgres/MySQL/ClickHouse/Trino/Databricks/Snowflake federation) | Johnny's graph data doesn't live in mounted OLTP/lakehouse systems; this solves an enterprise federation problem we don't have. |
| Decision intelligence / scenario replay (Utopia) | Marked "in development" upstream; speculative even for them. |
| Alert center UI (Utopia) | The Space bot already reports provisions/launches/failures to chat — that *is* the alert channel for one user. |
| Concurrent ingestion with commit-order repair (Graphiti) | Our writes are serialized by design (bot → one workflow run at a time); the repair machinery solves a parallelism problem we deliberately don't have. |
| Pluggable graph backends (Graphiti Neo4j/FalkorDB/Neptune drivers) | Relate is the chosen engine; backend abstraction is Zep's product need, not ours. |
| Hosted reference servers as a pattern (Graphiti REST/MCP servers) | They ship with an explicit no-auth warning; our connector CLI + Space actions already cover the interface need locally. |
| Full Datalog rule language / business-rule authoring UI (Utopia) | The axiom-derivation slice (#17) captures the value; a general rule language is a product unto itself. |
| Scheduled sync from SaaS sources (GitHub/Jira/Notion/RSS/WebDAV/S3) | Possible later via cron + import, but it's connector plumbing, not graph expertise; nothing in either repo's *graph* design depends on it. |
| Telemetry (Graphiti PostHog usage stats) | Obviously not. |

---

## 5. Top 5 steals, in priority order

1. **Retire-and-link corrections (temporal invalidation).** Both products independently built
   the same core mechanic — a new fact closes its predecessor (`validTo`/`invalid_at` set,
   `retiredAt`/`expired_at` stamped, successor linked) and *nothing is ever overwritten*. We
   already have the four bitemporal properties and as-of reads in the Space; the only missing
   piece is the pipeline write rule. Highest leverage per unit effort in either repo: it makes
   our bitemporal UI honest instead of decorative. (M — normalization/import stage rules + skill.)
2. **A persistent review queue in the Space.** Utopia routes *every* doubtful case — low-confidence
   extraction, suspected duplicate, cardinality conflict — to one queue where a person picks
   from explicit choices, and those decisions feed back into adjudication. Ours currently die
   as "blockers" in a run report nobody re-opens. This is the difference between a graph that
   asks good questions and one that silently guesses or silently drops. (M–L — Space panel +
   stages enqueue.)
3. **Fact sentences + embeddings on edges.** Graphiti's edges carry a human-readable `fact`
   and their own vector. Our edges are bare type labels, which caps retrieval at node level
   and makes cited chat answers impossible. Embedding edges (embeddinggemma is already local)
   upgrades search, the chat's grounding, and any future citation UI in one move. (M — import +
   embeddings stages.)
4. **The three-stage resolution funnel + reversible merges.** Exact/identity-property match →
   similarity tiers with a queue-the-doubtful band → adjudication, with every merge logged and
   undoable (Utopia's `entity_merges` + Graphiti's funnel, cosine ≥ 0.6 candidate gate). Our
   evidence-only *rule* is right; what's missing is the machinery — candidate tiers, an identity
   property per class in the house ontology, and a merge log that makes a wrong merge a
   revert instead of a rebuild. (M — normalization + house ontology + connector undo.)
5. **An append-only decision/change ledger.** Utopia records who/when/what-the-object-looked-like
   for every confirm, reject, merge, revert, and rebuild — outliving the object itself — and
   turns it into a `changes` feed ("what changed last week") and adjudication precedents.
   Cheap to start (the pipeline already produces stage reports; the ledger makes them durable
   and queryable), and steals #2 and #4 both get better the moment it exists. (S–M — connector
   ledger + `changes` command + writeback entries.)

*Runner-up:* per-fact verbatim-quote provenance (steal #7) — Utopia's extraction contract puts
the source sentence on every statement. It loses the #5 slot only because our SourceDocument
anchors already give document-level provenance; quote-level is the refinement, the ledger is
the missing foundation.
