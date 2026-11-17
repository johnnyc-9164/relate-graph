---
name: local-relate-graph-building
description: Expert knowledge-graph construction for the Relate stack — ontology-first modeling, source-grounded LLM extraction, evidence-ladder entity resolution, bitemporal updates by retirement, PROV provenance, embedding/community practice, and verifier QA gates for the relate-pipeline stages.
---

# Relate Graph Building — Expert Practice for Our Stack

Version 1 — 2026-11-16. This is the expertise the `relate-pipeline`
stages follow. It distills how expert graph builders actually work —
Neo4j's official modeling guidance, Microsoft GraphRAG, Neo4j's LLM
graph builders, the record-linkage literature (Fellegi–Sunter / Splink
/ Dedupe), Snodgrass bitemporal modeling, and W3C PROV — translated
into rules for our engine and our conventions. Where the research and
our standing conventions meet, the conventions in §0 win; they are
already live and are not to be contradicted.

## When to use
- Any `relate-pipeline` run, at any stage: intake, import, ontology,
  categorizing, normalization, cleaning, embeddings, communities,
  verify, writeback.
- Any by-hand graph work against a Relate store (ad-hoc Cypher through
  the Query API) that writes nodes or edges.
- Reviewing a graph someone else (or another agent) built for us.

## 0. The stack — fixed facts
- **Engine:** Relate by Neo4j (openCypher / Cypher 25). One graph =
  one single-file `.rl` store, served by its own `relate serve`
  process. HTTP Query API v2: `POST <apiBase>/db/neo4j/query/v2`,
  body `{"statement": "<Cypher>", "parameters": {}}`, response
  `{"data": {"fields": [...], "values": [[...]]}}`. Per-graph ports
  and apiBase values live in
  `~/workspace/relate-space/graphs/registry.json` — read it, never
  guess a port.
- **Pipeline:** the saved workflow `relate-pipeline` (launched by
  name) is the engine; the Relate Graph Space is only a client. This
  skill is the expertise those stages execute.
- **Embeddings:** local `embeddinggemma` via Ollama, 768-dim. Nodes
  carry `embedding`, `embedding_dim` (=768), `embedding_model`
  (='embeddinggemma'). A dimension that doesn't match the model is a
  hard stop, not a degradation.
- **Live conventions (do not contradict):**
  - Node identity is the stable `slug` property, unique per label.
  - A graph builds ONLY from sources named in the job. Nothing else
    gets imported, ever.
  - `SIMILAR_TO` edges are lead-grade only (`confidence:'lead'`) and
    are created only when the job explicitly asks for a similarity
    pass.
  - Bitemporal property names are `validFrom` / `validTo` /
    `recordedAt` / `retiredAt`; a missing property means unbounded
    on that end.

## 0.5 The determinism mandate — Johnny's standing order (2026-11-16)
> "Make most of this deterministic. Only reasoning when it's
> needed. Everything typed tools — no vibes."

A standing order, not a preference. It governs every pipeline
stage and every by-hand operation this skill covers.

- **Mechanical work is deterministic code.** Ontology stamping
  and reconcile, embeddings, verification gates, contradiction
  detection, counts and censuses, and write enforcement run as
  typed tools with JSON in / JSON out — same input, same output,
  same report, every run. The tool layer is the `custom.relate`
  CLI (`~/workspace/custom-connectors/custom.relate/bin/relate`;
  graphs addressed by registry slug):
  - Landed: `graphs`, `status`, `counts`, `labels`, `types`,
    `node`, `query`, `signals`, `provision`.
  - Landing (in flight — a named blocker until each exists):
    `stamp`, `reconcile`, `scan-conflicts`, `embed-missing`,
    `verify`, `write-batch`, `normalize-scan`, `categorize`,
    `clean-scan`, `communities`, `supersede`.
- **A stage that calls a tool returns the tool's JSON as its
  result.** It does not improvise equivalent Cypher, interpret or
  "fix" tool output, or paper over a tool error. A missing or
  failing tool means the stage fails honestly with the tool's
  error and the gap is reported as a blocker. Improvising in
  place of a tool is a defect, on par with inventing a label (§2).
- **Reasoning is reserved for the work that is actually
  judgment:** extraction from source text (§4), summarization
  (§4, §9), genuinely ambiguous adjudication (the §5 review band;
  the superseded-vs-undecidable call in §6.5), and preparing
  review items with their evidence and explicit choices.
  Everything else is a tool call.
- **Every reasoning-produced write is bracketed:** a
  deterministic scan before (`scan-conflicts`, `normalize-scan`,
  `clean-scan`, as applicable), the write itself through
  `write-batch` — the only sanctioned write path for extracted
  data — and the `verify` gates after (§10). Reasoning never
  writes to the graph directly.

## 1. Modeling rules — ontology first, queries first
Neo4j's modeling method is query-driven and iterative: name the
questions the graph must answer → draft entities/relationships →
test against the questions with real Cypher → refactor. A model that
wasn't tested against its questions is a guess.

- **Labels are named, indexed subsets** (PascalCase: `Person`,
  `SourceDocument`). A node is an entity or a reified fact (§1.3).
  A node may carry several labels; a relationship has exactly ONE
  type.
- **Relationship types are specific and verb-first**
  (UPPER_SNAKE: `WORKS_AT`, `MENTIONS`, `DESCRIBED_IN`). Favor a
  specific type over a generic type + a `type` property: property
  access is one of the most expensive lookups in Neo4j, while
  type-directed traversal is cheap. The specificity ladder runs
  `HAS_CONTACT {type:'phone'}` → `:HAS_PHONE_CONTACT` →
  `:HAS_CURRENT_PHONE_CONTACT`. If generic traversals are also
  needed, keep the specific types and add the generic one alongside
  — never replace specific with generic.
- **Property vs node:** a value stays a property while it is a leaf
  attribute of its owner (display/filter only). Promote it to a node
  when any of these hold: it is shared by many nodes/edges; other
  facts hang off it; it repeats verbatim across relationships
  (de-duplication); queries need to traverse *through* it. The
  canonical failure is one property repeated on a thousand edges
  where one shared node would do.
- **Intermediate nodes for n-ary facts.** A property graph has no
  hyperedges: a relationship joins exactly two nodes. Any fact that
  connects 3+ things, or that other facts must point at, is reified
  as an intermediate node — `Employment` between `Person`,
  `Company`, and `Role` holding `start`/`end`; in our graphs:
  memberships, claims, events, extractions. Reification is also what
  makes a fact bitemporal- and provenance-addressable (§5, §6).
- **Identity is an invariant, not a hope.** `slug` is unique per
  label, the way a uniqueness constraint / node key would enforce
  it. Where the engine enforces constraints, declare them; where it
  doesn't, the verifier enforces the identical checks as queries
  (§9). Corollary from Neo4j practice: adding a uniqueness
  constraint scans existing data and FAILS on violations — so the
  duplicate/missing-key audit always runs BEFORE the invariant is
  asserted, and a failure is a QA finding, not a surprise.
- **Schema before extraction.** The ontology stage produces the
  canonical schema (labels, relationship types, key property per
  label, allowed patterns) BEFORE import extracts anything against
  a new domain. Extraction conforms to the schema (§3); it never
  invents it (§2).

## 2. Ontology governance
- The canonical schema for a graph is owned by the ontology stage.
  It is a recorded artifact of the run: labels, types, key
  properties, and the allowed `(sourceLabel, TYPE, targetLabel)`
  pattern triplets.
- **No drift.** Import and extraction may not invent labels, types,
  or patterns mid-run. An entity that fits no existing type is
  reported as a blocker (or held under an explicit holding label the
  schema names) — never silently minted into a new label. This is
  the pruner discipline from Neo4j's KG builder: undefined types and
  properties are stripped/rejected, not retained by default.
- **Vocabulary discovery, not silent absorption** (the Utopia
  pattern). Terms extraction meets that fit NO existing type are
  counted as they appear — term, frequency, source episodes — in a
  discovery list attached to the run. A term is promoted into the
  ontology only on explicit confirmation (an ontology job, §2
  above), at which point held extractions using it are restated.
  Un-promoted terms stay visible as counts; they never quietly
  become labels, and they are never silently dropped either —
  a rising out-of-ontology term is the signal the schema is
  missing something real.
- **Schema changes are ontology jobs.** Adding/renaming a label or
  type, or changing a key property, happens in an ontology pass that
  records: what changed, why, how many nodes/edges were restated.
  Renames restate the data in the same pass; a graph never carries
  two generations of the same concept under different names.
- **Category vocabularies are governed schemes,** not free text:
  the `category` values the categorizing stage assigns come from
  the graph's SKOS concept scheme (§3 of the ontology pack, below).
  A new category is a scheme addition, not a stage improvisation.
- Naming: labels PascalCase, types UPPER_SNAKE verbs, properties
  camelCase. Consistent casing is a correctness issue — Cypher
  matching is case-sensitive and drift here manufactures duplicates.

## 3. Ontology pack — use the standards, don't reinvent them
House ontologies live in
`~/workspace/custom-connectors/custom.relate/ontologies/`, indexed
by `ONTOLOGIES.md` in the connector root
(`~/workspace/custom-connectors/custom.relate/`). Pipeline stages
LOAD house ontologies from that directory; they do not restate
vocabularies from memory and do not invent terms inline during a
run.

Which standard governs which concern:
- **People, organizations, social ties:** FOAF + schema.org
  (`Person`, `Organization`, `knows`, `memberOf`, …).
- **Provenance:** PROV-O (§6) — entities, activities, agents,
  derivation and attribution relations.
- **Time:** OWL-Time patterns sit behind the bitemporal properties
  (§5) — intervals, instants, `time:hasBeginning`/`hasEnd` thinking,
  stored in our flat `validFrom/validTo/recordedAt/retiredAt` form.
- **Category schemes:** SKOS — categories are concepts in a scheme,
  with broader/narrower structure, not ad-hoc strings.
- **Source documents:** Dublin Core Terms — `creator`, `date`,
  `source`, `title`, `description` for `SourceDocument` nodes.

The pack also holds **cold-start packs**: per-domain starter
ontologies (seed labels, types, patterns, category scheme) that a
new graph loads on day one instead of starting from a blank schema
and drifting — the ontology stage begins from the pack and records
its deviations, per §2.

Rule for growth: a new house ontology is packaged the same way —
a file in `ontologies/` plus an entry in `ONTOLOGIES.md` — in its
own pass, reviewed like a schema change (§2). An ontology that
exists only inside one run's prompt does not exist.

## 4. Extraction rules — source-grounded, schema-guided
How the import stage turns named sources into graph, following the
GraphRAG / Neo4j-builder consensus:

- **Chunk first.** Split each source into chunks (TextUnits) before
  extracting anything. Default ≈1200 tokens with ≈100 overlap
  (GraphRAG's default, with its warning: larger chunks = faster but
  lower fidelity and less meaningful provenance references; go
  smaller for dense factual text). Chunks are the unit of
  provenance: every extracted node and edge traces to the chunk(s)
  it came from.
- **Keep a lexical layer.** `SourceDocument` nodes (Dublin Core
  properties) connect to their chunks; chunks connect to the
  entities extracted from them (the `PART_OF` / `NEXT_CHUNK` /
  `HAS_ENTITY` pattern; our live edge vocabulary — `DESCRIBED_IN`,
  `MENTIONS`, `ABOUT` — carries the same trace). An entity with no
  path back to a chunk has no provenance and fails §6.
- **Per-chunk extraction emits triples with descriptions:**
  entities as (name, type, description), relationships as
  (source, target, description). Descriptions are evidence text,
  not decoration — they are what gets summarized and embedded.
- **Deterministic consolidation before anything clever**
  (GraphRAG's merge rule): entities with the same normalized
  title + type merge into one node, their descriptions collected;
  relationships with the same source + target merge likewise. Then
  ONE summarized description per entity/relationship, capturing all
  distinct information from the collected list. This is mechanical
  consolidation of identical mentions — it is NOT entity
  resolution (§5) and never merges merely-similar entities.
- **Gleaning:** run one additional extraction pass per chunk
  (max_gleanings = 1) to catch entities the first pass missed.
  More passes show diminishing returns and rising invention risk.
- **Schema-guided:** extraction is restricted to the canonical
  schema's entity types and pattern triplets (§2). Output that
  violates the schema is rejected and reported, not kept "just in
  case."
- **Claims are covariates, not entities.** A factual claim ("X was
  at Y on date Z") is stored as a claim — reified (§1.3) with an
  evaluated status and time bounds — distinct from the entities it
  mentions. Claim extraction is off unless the job asks for it; it
  needs tuning to be useful (GraphRAG ships it disabled too).
- **Idempotency:** writes MERGE on `slug`, so re-running an import
  restates rather than duplicates. (LLM caching in GraphRAG exists
  for the same reason: same input → same extraction → no drift.)

## 5. Entity resolution — the evidence ladder
Resolution is a pipeline, not a vibe: **normalize → block →
pairwise score → two thresholds → cluster QA → promote.** The
normalization stage owns steps 1–2, and proposes; promotion to a
merged identity happens only through the gates below.

1. **Normalize first.** Canonical name forms (surname/given-name
   order), ISO dates, handle formats (strip `@`, lowercase),
   phonetic keys (Soundex/Metaphone class) for spelling variants.
   Matching on unnormalized data manufactures both false merges and
   false splits.
2. **Blocking generates candidates; it decides nothing.** Compare
   only pairs sharing a blocking key — but use MULTIPLE strict
   keys in union (normalized name; name+place; handle; DOB), so a
   typo in one field is rescued by another rule. Pre-count the
   comparisons a rule set generates before running it. A pair no
   rule admitted is `not_compared` — a different state from
   `compared_and_rejected`, and it is reported as such. Blocking is
   a recall decision: a true pair never generated can never be
   recovered downstream.
3. **Pairwise scoring is per-field and weighted** (Fellegi–Sunter):
   each field contributes `log2(m/u)` for agreement,
   `log2((1−m)/(1−u))` for disagreement. Agreement on a
   low-cardinality field (sex, birth month) is weak evidence;
   agreement on a rare value is strong. Apply term-frequency
   adjustment: sharing "Smith" earns less than sharing a rare name
   (floor rare values so a shared misspelling doesn't earn a
   fortune). Correlated fields (city + ZIP) violate the
   independence assumption — don't double-count them.
4. **Two thresholds, three outcomes.** Above the upper threshold:
   merge CANDIDATE (still gated by the ladder + cluster QA).
   Below the lower: non-match. Between: the review band — held as
   candidates with their scores, never auto-merged, never silently
   dropped. One cutoff is malpractice.
5. **Clustering is where false merges are born.** Pairwise scores
   are NOT transitive: A~B and B~C at 0.6 each imply A~C ≈ 0.36,
   yet connected components would merge all three. Before any
   cluster is promoted to one identity, run cluster QA:
   - **Bridge edges:** an edge whose removal splits the cluster —
     especially one joining two dense sub-clusters — is flagged
     for review before promotion.
   - **Size sanity:** an implausibly large cluster is prima facie
     false positives; inspect the largest clusters first.
   - **Density:** edges / possible edges. Large + sparse is more
     suspicious than large + dense.
6. **The evidence ladder — what justifies a merge, ascending:**
   1. *Vector/embedding similarity alone.* NEVER sufficient.
      Produces `SIMILAR_TO` leads only.
   2. *Name/handle string similarity* (fuzzy, phonetic). Candidate
      generation only.
   3. *One shared attribute* (same handle, same email, same DOB).
      Weak positive; needs corroboration.
   4. *Multiple independent attribute agreements* (name + DOB +
      place) with NO verified contradiction. Merge candidate,
      cluster-QA gated.
   5. *Explicit alias statement in a source* ("also known as",
      a record carrying legalName + alias). Strong — merge, citing
      the source.
   6. *Shared unique identifier* (same account ID, case number,
      verified canonical handle/URL). Strongest documentary
      evidence — merge.
   7. *The job's own explicit instruction* (Johnny states these
      are the same). Authoritative for this graph.
   **Veto rule:** one VERIFIED contradiction (two different DOBs,
   a source explicitly distinguishing the two as different people)
   blocks a merge at levels 1–5 regardless of score.
7. **Merges are non-destructive.** The canonical node survives;
   merged-away records remain as nodes linked to it (the PROV
   revision/specialization pattern), with the merge's evidence
   recorded in the run's changes. A merge that erases its inputs
   can never be audited or undone.
8. **Resolution is staged, reversible, and ledgered** (the Utopia
   pattern). Three stages: candidates proposed → decisions made →
   promotion executed. Every decision — confirmation, rejection,
   merge, rebuild — is written to a queryable **decision ledger**
   (who/what decided, when, on what evidence, ladder level). The
   review band from step 4 IS the human review queue: conflicts
   surface there with explicit resolution choices, not silent
   auto-resolution. Because merges are non-destructive (step 7),
   a wrong promotion can be UNDONE from the ledger — the merged
   records are still there to restore. An un-undoable merge is a
   design failure, not an accident.

## 6. Bitemporal convention — retire, never delete
Every worldly fact carries two independent time axes (Snodgrass):
- **Valid time** — when the fact was true in the world:
  `validFrom` / `validTo`. May be past or future; may be corrected.
- **Transaction time** — when the graph knew it: `recordedAt` /
  `retiredAt`. Set by the system at write time, never backdated,
  never edited, never extends into the future. A missing property
  means unbounded on that end (§0).

Rules:
- **Update by retirement.** To correct a fact: set `retiredAt` =
  now on the current version, insert the corrected version with
  `recordedAt` = now and its (possibly split) valid interval, and
  link new → old (the PROV `wasRevisionOf` relation, §7). The old
  version stays in the graph, queryable forever. This is
  Graphiti's edge invalidation and Utopia's close-and-link
  correction, and it is the ONLY correction mechanism. DELETE of a
  worldly fact is forbidden; in-place edits of a valid interval
  are forbidden.
- **Retroactive corrections split intervals.** If a fact recorded
  as "Bigtown from 1994" turns out to have an unreported Beachy
  period inside it, the corrected version splits the valid
  interval into Bigtown / Beachy / Bigtown segments — while the
  original version remains intact under its transaction interval,
  so "what did the graph believe on date T?" still answers
  truthfully.
- **As-of semantics — three different questions, never conflated:**
  - *As-of-valid:* true at valid time V (transaction = current).
  - *As-of-recorded:* what the graph believed at transaction
    time T (the rollback view).
  - *Bitemporal:* true at V as known at T — filter both axes.
  The default "current" view = `retiredAt` unbounded AND
  `validFrom` ≤ now < `validTo`.
- **Retraction = invalidation,** not deletion (PROV
  `wasInvalidatedBy` / `invalidatedAtTime` map onto `retiredAt`).
- Structural edges (chunk `PART_OF`-style traceability, ledger
  links) may stay untimed. Facts about the world get timestamps.
  When in doubt, timestamp: an untimed fact can never be
  as-of-queried later.

## 6.5 Contradiction handling — detect, retire or contest, never bury
§6 says how a correction is written; this section says how a
contradiction — two live facts that cannot both be true — is
found and disposed of. A contradiction silently overwritten,
silently kept, or silently dropped is a defect in all three forms.

- **Detection is deterministic and runs at import and
  normalization:** the `scan-conflicts` tool before a write,
  after a write, and inside `write-batch` before anything
  applies. Three kinds:
  1. **Single-valued property conflicts:** a property the
     in-graph ontology marks single-valued (`sourcePath`,
     `legalName` at minimum) holding two distinct live
     (unretired) values.
  2. **Conflicting edges:** a new edge between a pair that an
     existing live edge contradicts — an incompatible type, or
     the same type with a contradictory qualifier.
  3. **Identity conflicts:** two nodes asserting the same unique
     identifier with incompatible facts (cf. the §5 veto rule).
  Every detection is recorded in the stage result with BOTH
  sides and their sources (§7). A scan that finds nothing says
  so; a scan that wasn't run is a blocker, not a pass.
- **Resolution has exactly two paths:**
  - **Verifiably superseded → retire-and-link.** The new fact
    carries stronger or newer source evidence (a later-dated
    source; the source document itself correcting the earlier
    extraction). Execution is a fixed sequence, run by the
    `supersede` tool: set `retiredAt` on the old fact and close
    `validTo` where a valid interval exists; write the corrected
    fact with `recordedAt` = now; link old → new with a
    `SUPERSEDED_BY` edge (the graph-level form of PROV
    `wasRevisionOf`, §6). For a node-property fact, the old value
    is preserved in `supersededValues` and the node links to the
    correcting `SourceDocument`. Then re-scan: the contradiction
    must be gone from the live view. The old fact is never
    overwritten and never deleted (§6) — the as-recorded view
    still answers what the graph believed before.
  - **Undecidable → contest, don't resolve.** Neither side is
    verifiably wrong: both facts stay live, each marked
    `contested: true` with `contestedWith` naming the other
    side, and the pair goes to the review queue as an item
    carrying the explicit choices — keep A / keep B / keep both
    as disputed. No stage writes a resolution to an undecidable
    contradiction, ever.
  The superseded-vs-undecidable judgment is the one reasoning
  step in this section (§0.5); detection and both executions are
  deterministic.
- **Verifier gate (§10, gate 11):** a run FAILS verification on
  any unhandled live contradiction, any broken supersession
  chain (a retired fact with no `SUPERSEDED_BY` successor), and
  any contested pair whose other side was silently removed. A
  properly contested pair — both sides present, both marked —
  does NOT fail; it is an open decision, reported as one.

## 7. Provenance — no source, no fact (W3C PROV)
PROV's minimum complete record for an extracted fact is a triple:
**Entity** (the fact) ← generated by an **Activity** (the
extraction) that used a source Entity, run by an **Agent**. A bare
`wasDerivedFrom` with no activity and no agent cannot support any
trust judgment and does not count as provenance.

In graph terms, every extracted node and edge carries:
- **Derivation (content lineage):** which source it came from —
  an edge/prop to its `SourceDocument` and chunk (§4). Use the
  most specific true relation: verbatim excerpt = quoted-from;
  a revised extraction = revision-of; the original witness
  document = primary source; generic transformation =
  derived-from.
- **Attribution (responsibility):** which extraction run and
  pipeline stage produced it, and when — `recordedAt` doubles as
  the transaction timestamp (§6), plus the run/job identifier.
  Derivation and attribution are different claims ("the source
  said it" ≠ "the extractor produced it"); record both, never
  merge them into one vague "source" field.
- **The episode is the provenance unit** (the Graphiti pattern):
  one ingestion of one source by one run is an episode; every
  fact from it traces to that episode, and the episode itself is
  addressable — a fact whose episode can't be named is
  unprovenanced.
- **Answers cite.** Any answer produced from the graph (chat,
  query results, reports) cites its backing node/edge IDs and the
  source passage they trace to — GraphRAG's `[Data: Entities
  (…); Relationships (…)]` discipline, Utopia's inline citations
  to source passages. An uncitable answer is an unsupported one.
- **Hard rule:** a fact with no source does not enter the graph.
  Not "enters flagged" — does not enter.

## 8. Embeddings & similarity practice
- **Embed the summarized description** — entity name + type + its
  one summarized description (§4). GraphRAG embeds exactly three
  things by default: entity descriptions, chunk (TextUnit) text,
  and community report text. Do NOT embed raw mention lists or
  unsummarized duplicate descriptions; that embeds the same entity
  several times with partial text.
- **Properties:** `embedding` (768 floats), `embedding_dim` = 768,
  `embedding_model` = 'embeddinggemma' on every embedded node —
  always clear which model produced a vector; if the model ever
  changes, every vector is stale until re-embedded.
- **Re-embed on material change.** If a node's description changes
  materially, its old vector is a QA finding until refreshed.
- **Similarity passes are explicit, gated, and reproducible**
  (only on the job's explicit request, §0): KNN with BOTH a `topK`
  AND a similarity cutoff — topK alone forces bad neighbors in;
  pin the seed and run parameters so the pass is deterministic.
  Written edges are `SIMILAR_TO` with a `score` property,
  `confidence:'lead'`, and run provenance (model, dimension,
  cutoff, topK, seed) recorded with the run.
- **Hubness is real.** In high-dimensional space a few points
  become hubs — nearest neighbors to almost everything. After any
  similarity pass, check the reverse-neighbor (in-degree)
  distribution of the new edges; hub nodes' edges are suspect by
  construction. A similarity edge is promoted to a semantic
  relationship only with a second, independent signal (§5 ladder,
  level ≥3) — never on score alone.
- **Similarity edges stay in their own type** so they can be
  dropped and recomputed without touching the evidence graph.
- **Retrieval is hybrid** (the Graphiti pattern): semantic
  (vector) + keyword + graph traversal combined — no single one
  of the three is the whole answer path.
- **The answering loop (GraphRAG chat procedure — Johnny,
  2026-11-16):** embed the question → compare (hybrid search)
  → traverse from the hits → reason over what was found (what
  answers it, what is missing, which nodes/edges would settle
  it) → traverse again from the reasoned targets → reason →
  synthesize → respond. Bounded: at most 3 traverse–reason
  rounds, stop early when a round adds nothing relevant. A
  single search call is round 1, never the whole answer. Every
  claim in the synthesis traces to something a round actually
  retrieved (§7 provenance; the Space bot's grounding rule) —
  if the loop comes back empty, the answer is "that's not in
  this graph," not a fill-in.
- **Agentic upgrade (Johnny, 2026-11-16):** the loop is run by
  an agent, not a script. It classifies the question first —
  local/entity questions enter through hybrid search;
  global/corpus questions enter through community summaries +
  the label census, then drill into the communities that
  matter (the GraphRAG local/global split). It chooses the
  tool that fits each gap and self-checks sufficiency after
  every round — every claim sourceable? what is still
  missing? — before traversing again or synthesizing. Max 4
  rounds. The fixed sequence above is the floor; choosing
  WHERE to traverse is the agent's job.

## 9. Communities practice
- **Leiden, not Louvain.** Louvain can return communities that are
  internally DISCONNECTED (up to ~16% disconnected in the Leiden
  paper's experiments) and iterating it makes it worse while
  modularity still improves. Leiden guarantees connected
  communities. Our pipeline computes communities structurally
  (the Relate store has no GDS), so the enforceable minimum is:
  every reported community is verified internally connected —
  a disconnected "community" is split and reported, never shipped
  as one.
- **Hierarchical, with a stop rule:** recurse until a community-
  size threshold, and keep the level structure (level + community
  id per node), not just the final flat partition — levels are
  what make summaries and navigation useful at different scales.
- **Every community gets a summary.** An LLM report per community
  (size, dominant labels/categories, hub nodes, key internal
  relationships), written to the graph (a `Community` node or the
  community's properties), and the summary text is embedded (§8).
  A partition without summaries is half the artifact — the summary
  is the downstream-usable part (GraphRAG Phase 5).
- **Record the run:** algorithm, resolution parameter, seed
  (pinned), node/edge counts. Unpinned community runs are not
  reproducible and not QA evidence.
- **Post-checks:** size distribution reported (singletons and one
  giant blob are both findings); connectivity verified per above.
- **Communities are structure, not identity.** Co-membership is
  never evidence two nodes are the same entity (§5), and never
  phrased as an identity claim.

## 10. QA gates — what the verifier must check
The verifier is independent: it re-queries the API itself and
never trusts stage summaries. A run FAILS verification if any gate
fails; coverage is reported as numbers, not adjectives; a gate
that wasn't actually queried wasn't checked.

1. **Counts:** node/edge totals and per-label/per-type counts
   match the stage claims, including before/after deltas for
   every write stage.
2. **Schema conformance:** every label and type in the graph is
   in the canonical schema; every edge matches an allowed pattern
   triplet; zero drift labels/types.
3. **Identity integrity:** slug uniqueness ratio = 100% within
   each label (distinct/total — "mostly unique" is NOT unique);
   zero nodes missing their key property.
4. **Provenance coverage:** 100% of extracted nodes/edges trace
   to a source + episode (§7); offenders listed by slug.
5. **Orphans & gaps:** degree-0 nodes per label (excluding labels
   the schema allows to stand alone); nodes missing relationship
   types the schema expects of them; empty-string properties.
6. **Coverage metrics:** % nodes with `category` (after
   categorizing), % with community assignment (after communities),
   % of SourceDocuments with summaries — each as a number.
7. **Embedding coverage:** % of embeddable nodes carrying
   `embedding` with `embedding_dim` = 768 and the correct
   `embedding_model`.
8. **Bitemporal sanity:** no fact with `validTo` < `validFrom`;
   no retired version still appearing in the current view;
   no `recordedAt` in the future.
9. **Merge audit:** every merge in the run cites evidence at
   ladder level ≥5 (§5) or the job's explicit instruction;
   bridge-edge clusters and review-band items are accounted for
   in the decision ledger (§5.8) — decided, or explicitly still
   open.
10. **Spot checks:** 2–3 concrete stage claims (a merge, an
    import count, an embedding count, a community size)
    re-queried independently.
11. **Contradiction gate:** no unhandled live contradictions
    (§6.5); every retired-by-correction fact carries an intact
    `SUPERSEDED_BY` chain; contested pairs have both sides
    present and marked.
Repair discipline: one bounded repair loop; a wrong stage CLAIM
is corrected in the report — data is never edited to match a
wrong claim.

**Canonical gate list (D-04, 2026-11-17):** the conceptual gates
above are implemented as ONE list owned by the CLI — the
`gates` object in `relate verify` output (20 gates: totals,
label_census, type_census, missing_slugs, duplicate_slugs,
missing_category, category_values, normalization_consistency,
embedding_coverage, embedding_uniformity, bitemporal_sanity,
provenance, isolated_nodes, summary_gap, community_coverage,
bitemporal_coverage, duplicate_classes, duplicate_properties,
conflicts, similar_to_lead_grade). The pipeline verifier
enumerates exactly those names and re-derives none. Coverage
gates (missing_category, embedding_coverage,
community_coverage, normalization_consistency) are JOB-AWARE:
they fail a run only when the job included the corresponding
stage; otherwise they are reported as informational, like
summary_gap and bitemporal_coverage always are. A gate a prompt
expects that the CLI does not emit — or a CLI gate the verifier
ignores — is itself a discrepancy.

## 11. Anti-patterns — each of these has burned someone
- Merging identities on embedding or name similarity alone.
- A single merge threshold with no review band.
- Transitive-closure merges with no bridge/density/size QA.
- DELETE (or in-place interval edits) as a correction mechanism.
- Generic relationship type + `type` property (`HAS_CONTACT
  {type:'phone'}`) instead of specific types.
- Property dumps: shared values smeared across edges instead of
  promoted to nodes.
- Inventing labels/types mid-import (schema drift).
- Embedding raw mentions or unsummarized duplicate descriptions.
- KNN with topK but no similarity cutoff; unpinned seeds.
- Louvain (or any) communities shipped without a connectivity
  check; a partition with no summaries called "done."
- Facts with no source; provenance as a lone derived-from with
  no activity/agent; answers with no citations.
- Backdating `recordedAt`; resurrecting a retired version by
  clearing `retiredAt` instead of inserting a new version.
- Treating community co-membership as identity evidence.
- "Verified" asserted from stage summaries instead of re-queries.
- Blocking treated as a matching decision (an unblocked pair is
  `not_compared`, not a non-match).
- Out-of-ontology terms silently absorbed — or silently dropped —
  instead of counted and promoted on confirmation (§2).

## 12. Current pipeline — complies / gaps
Judged by reading `~/workspace/.jarvis/workflows/relate-pipeline.js`
(2026-11-16). The skeleton is right; the gaps are expertise the
stage prompts don't yet carry — which is what this skill supplies
when stages consult it.

**Complies:**
- Named-sources-only is a hard rule in shared context; import
  blocks honestly when a required source is missing.
- No merge on similarity alone; merges require evidence, and
  normalization must list every merge WITH its evidence.
- `SIMILAR_TO` lead-grade only, only on explicit request.
- Import writes with MERGE on stable keys (idempotent re-runs).
- After any write, stages must re-query counts and report
  before/after.
- Audited skips instead of invented work; honest blockers.
- Independent verifier re-queries the API, checks counts, label/
  type counts, category + community coverage, spot-checks claims;
  one bounded repair loop; never edits data to match a wrong
  claim; writeback of the verified result to the Space request.
- Embeddings stage: skips already-embedded nodes, composes text
  from name/handle/bio/text properties, stores all three
  embedding properties with the right model/dimension.
- Communities stage: structural detection over real edges,
  per-community summaries in its report, explicit
  community ≠ identity rule.
- Ontology stage produces a canonical schema and standardizes
  drift; categorizing derives category from label/properties/
  content, never from real-world identity guesses.

**Gaps (in pipeline order):**
- **Provenance absent.** No stage is instructed to record source/
  chunk/episode provenance on nodes and edges; §7's minimum
  record (source + activity + agent) is not required anywhere.
- **No lexical/chunk layer.** Import parses sources straight to
  nodes/edges: no chunking, no chunk→entity traceability, no
  gleaning pass, no description-collection + summarization step
  (GraphRAG's merge-then-summarize has no analog; descriptions
  are effectively first-wins).
- **Entity resolution is one sentence.** "Merge ONLY with
  evidence" — no blocking step, no pairwise scoring, no
  two-threshold review band, no cluster QA (bridges/density/
  size), no evidence ladder, no decision ledger, no undo.
- **Bitemporal not wired.** `validFrom/validTo/recordedAt/
  retiredAt` appear nowhere in the workflow: writes aren't
  stamped, corrections aren't specified as retire-and-link, and
  cleaning's "fix in place" / normalization's unspecified merge
  mechanics could silently violate update-by-retirement.
- **Ontology governance is soft.** The ontology stage audits and
  renames, but nothing forbids import from inventing labels,
  there is no allowed-pattern triplet list, no schema versioning
  or change record, no vocabulary-discovery counting, and no
  stage loads the house ontology pack (§3).
- **Similarity pass under-specified.** No topK + cutoff pairing,
  no seed pinning, no hubness check, no run provenance beyond
  `confidence:'lead'`.
- **Communities under-specified.** Algorithm is "compute it
  yourself": no connectivity guarantee/check, no hierarchy or
  levels, summaries live only in the stage report — not written
  to the graph, not embedded.
- **Verifier gates missing:** provenance coverage, slug
  uniqueness ratio, schema-pattern conformance, bitemporal
  sanity, and merge-evidence/ledger audit (§10 gates 2, 3, 4,
  8, 9) are not in the verifier's instructions.

## 13. Utopia + Graphiti — implementation status
§2, §5, §6, and §8 borrow patterns from two reference
implementations — Utopia (DeepLethe) and Graphiti (Zep). A
pattern being specified in this skill is NOT the feature
existing in the running system. Status lives in three buckets,
and any report on this system names the bucket, never just the
feature:

- **IN — verified working on live graphs:** ontology cold-start
  packs + in-graph stamping (§3); bitemporal properties + as-of
  reads (§6, and the Space's time modes); evidence-only merges +
  lead-grade similarity (§5 ladder, §0 `SIMILAR_TO` rule);
  hybrid retrieval via the `relate-search` companion tool —
  since 2026-11-17 the vector and keyword legs run IN-ENGINE
  (native VECTOR INDEX per content label + FULLTEXT INDEX over
  name/summary via `db.index.*.queryNodes`), fused with one-hop
  traversal by RRF, `--rerank` rescoring on top (tested live on
  Main 2026-11-17: "Example" → example #1, "painting" → Sky's
  Group #1, nonsense → empty set); the deterministic typed tool
  layer (stamp, reconcile, scan-conflicts, write-batch,
  normalize-scan, categorize, clean-scan, communities,
  supersede, similar, rename, merge/unmerge, embed-missing,
  embed-edges, the Decision/ReviewItem commands, ddl, chunks,
  extract, memify); contradiction handling (§6.5) with
  retire-and-link via `supersede` and conflict detection via
  `scan-conflicts` (all three §6.5 contradiction kinds
  since 2026-11-17: single-value violations, `edgeConflicts`,
  `identityConflicts` — see CONNECTOR.md); the §10 gate
  suite via `verify` (20 gates, one canonical list owned by
  the CLI, job-aware coverage in the pipeline verifier —
  D-04 fixed); a persistent review queue + decision ledger
  (§5.8) with a `changes` feed, mirrored by the Space's
  governance panel; reversible merges (merge stores the
  loser's full pre-merge state on the Decision node, unmerge
  restores it); batch-atomic `write-batch` over HTTP managed
  transactions (verified live 2026-11-17 on TEST: a batch with
  one undeclared edge type was refused whole — applied 0, the
  valid node never persisted; D-05 fixed); engine-enforced
  slug uniqueness (UNIQUE constraints per content label,
  applied to Main/TEST/johnny-muse and created by `ddl` at
  stamp/provision time); fact edges carrying embedded
  one-sentence facts (`embed-edges`) written by triplet
  extraction (`chunks` + `extract`, the Cognee contract —
  verified live on bestof-smoke: KNOWS/LEADS/OPERATES/
  WORKS_FOR/WORKS_ON fact edges landed from prose notes);
  identity-by-construction slugs in write-batch/extract
  (verified live 2026-11-17 on bestof-probe: four source
  documents naming Grace Hopper MERGE onto one node, sources
  accumulate, first summary stands); triplet-ranked retrieval
  (`relate-search --triplets` returns resolved fact lines —
  verified live 2026-11-17 on bestof-smoke); memify-lite
  (`relate memify`: state-based feedback_weight /
  importance_weight recomputed from resolved review items +
  Question ABOUT hits, folded into triplet scoring; dry-run
  verified 2026-11-17); the pipeline `query` category runs a
  real agentic GraphRAG answering stage (§8) whose grounded
  answer is the request's result text (D-03 fixed); the
  categorize tool's closed category set includes the
  `document` fallback for generic SourceDocuments
  (missing_category fix, verified live 2026-11-17 on
  bestof-smoke: residue [] and verify passed=true);
  `Question` nodes as a retrieval surface (`relate-search
  --questions` returns a `priorQuestions` section: stored
  questions ranked by vector cosine in the query space —
  stored questions are embedded with the query format,
  eg2-query-v1 — plus keyword over question text, RRF-fused,
  opt-in so default results stay byte-untouched; Question
  also sits in the search exclusion set so stored questions
  never pollute the content ranking; verified live
  2026-11-17 on bestof-probe: paraphrase retrieval cosine
  0.985, Main returns honest empty — no Questions stored
  there yet); vocabulary discovery (`relate vocab`:
  deterministic term counts from names/summaries/categories
  + fact sentences, each term marked covered/uncovered
  against the stamped ontology — proven live 2026-11-17
  on bestof-smoke: 36 distinct terms, 29 uncovered, the
  discovery signal working as §2 intends); auto-ontology
  induction as a pipeline stage (NVIDIA steal: the
  `induction` phase — deterministic corpus profile first,
  then ONE reasoning step under a restrictive evidence
  contract, draft Turtle pack written to
  ~/workspace/relate-space/ontology-drafts/ + a review
  item; a draft is NEVER stamped by the pipeline —
  verified live 2026-11-17, run
  workflow-run-4d4eae3fec82436288299f3b3a5cf7ce passed=true
  with the honest zero-proposal draft: every content node
  already fit a stamped class); the §5 resolution funnel
  as machinery in the normalization stage (blocking via
  normalize-scan, pairwise scoring via similar-scan
  cosines attached per pair — never estimated, cluster QA
  with density + bridge-pair flags; report-only, merges
  still only via typed `relate merge` — verified live
  2026-11-17, run workflow-run-399e0557fe9348feb695d7d5739ecc3f:
  21 blocked pairs scored, the designed sparse cluster
  flagged at density 0.40, the designed bridge pair named);
  an answer-evaluation harness (`relate-eval`, NVIDIA
  steal #1: the same verified question set run through
  plain search vs rerank+triplets, scored by executed
  checks only — expected slug/fact/edge, absence questions
  — no LLM judge; first Main run 2026-11-17: both arms
  13/14 questions, mean 92.86%, treatment fixed none and
  broke none; the one standing failure, "Who is Johnny's
  assistant?" not retrieving the `muse` node, is the
  harness's named open gap. We now evaluate the answer
  as well as the graph; relate-eval is the run-gate for
  answering-path changes).
- **WIRED-NOT-LANDED — the pipeline references the mechanism;
  the typed tools are in flight:** (none open as of
  2026-11-17 — every mechanism named here has either landed
  above or sits in LIST-ONLY.)
- **LIST-ONLY — named in the teardown, not built:** (none
  open as of 2026-11-17 — every pattern named in the
  teardowns has either landed above or been explicitly
  declined; new steals enter here when a teardown names
  them.)

**Bucket rule:** a feature moves buckets only on verified live
evidence — a tool's JSON output, a re-queried count, a run that
passed its gates — never on a stage's say-so, a wiring diagram,
or this skill's say-so. When this table and §12 disagree with
live state, live state wins and both get fixed in the same pass.
Full feature-by-feature mapping:
`~/workspace/relate-space/utopia-graphiti-teardown.md`.

## References — primary sources actually read for this skill
Modeling & schema:
- Neo4j Getting Started — Data Modeling:
  https://neo4j.com/docs/getting-started/data-modeling/
- Neo4j — Modeling Designs (intermediate/hyperedge nodes):
  https://neo4j.com/docs/getting-started/data-modeling/modeling-designs/
- Neo4j Support — Data Modeling Best Practices (specific types
  over property filtering):
  https://support.neo4j.com/s/article/360024789554-Data-Modeling-Best-Practices
- Neo4j Cypher Manual — Constraints:
  https://neo4j.com/docs/cypher-manual/current/schema/constraints/
- Neo4j Developer Blog — Data Profiling (QA audit practice):
  https://neo4j.com/blog/developer/data-profiling-holistic-view-neo4j/

LLM-driven construction:
- Microsoft GraphRAG — Default Dataflow (chunking, merge rule,
  summarization, Leiden, embeddings):
  https://microsoft.github.io/graphrag/index/default_dataflow/
- Microsoft GraphRAG — Index Overview & Configuration:
  https://microsoft.github.io/graphrag/index/overview/ ·
  https://microsoft.github.io/graphrag/config/yaml/
- Microsoft Research — GraphRAG announcement (citation
  discipline): https://www.microsoft.com/en-us/research/blog/graphrag-unlocking-llm-discovery-on-narrative-private-data/
- Neo4j LLM Knowledge Graph Builder — back-end architecture
  (lexical graph, KNN defaults, duplicate handling):
  https://neo4j.com/blog/developer/llm-knowledge-graph-builder-back-end/
- Neo4j GraphRAG for Python — KG Builder (schema modes, pruner,
  resolvers): https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_kg_builder.html

Entity resolution:
- Record Linkage / Entity Resolution (Fellegi–Sunter, blocking,
  two thresholds): https://en.wikipedia.org/wiki/Entity_resolution
- Splink — Blocking Rules; Fellegi–Sunter Theory; Term-Frequency
  Adjustments; Linked Data as Graphs; Cluster Graph Metrics:
  https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html ·
  https://moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html ·
  https://moj-analytical-services.github.io/splink/topic_guides/comparisons/term-frequency.html ·
  https://moj-analytical-services.github.io/splink/topic_guides/theory/linked_data_as_graphs.html ·
  https://moj-analytical-services.github.io/splink/topic_guides/evaluation/clusters/graph_metrics.html
- Dedupe — How It Works (non-transitivity of pairwise scores,
  clustering hazards): https://dedupe.io/documentation/how-it-works

Bitemporal:
- Jensen & Snodgrass — Semantics of Time-Varying Information:
  https://www2.cs.arizona.edu/~rts/pubs/ISJune96.pdf
- Temporal Database (SQL:2011 patterns, correction by closing +
  splitting): https://en.wikipedia.org/wiki/Temporal_database
- Martin Fowler — Bitemporal History:
  https://www.martinfowler.com/articles/bitemporal-history.html

Provenance:
- W3C PROV Overview: https://www.w3.org/TR/prov-overview/
- W3C PROV-O: https://www.w3.org/TR/prov-o/
- W3C PROV Primer: https://www.w3.org/TR/prov-primer/

Embeddings & communities:
- Traag, Waltman & van Eck — From Louvain to Leiden
  (Sci. Rep. 9:5233): https://arxiv.org/pdf/1810.08473
- Neo4j GDS — Leiden; Filtered KNN; Node Similarity:
  https://neo4j.com/docs/graph-data-science/current/algorithms/leiden/ ·
  https://neo4j.com/docs/graph-data-science/current/algorithms/filtered-knn/ ·
  https://neo4j.com/docs/graph-data-science/current/algorithms/node-similarity/
- Radovanović et al. — Hubs in Space (hubness), JMLR 11:
  https://www.jmlr.org/papers/v11/radovanovic10a.html

Reference implementations mined for patterns:
- Utopia by DeepLethe — staged entity resolution with undo and
  a review queue, queryable decision ledger, close-and-link
  corrections, ontology cold-start packs, vocabulary discovery,
  cited chat answers: https://github.com/deeplethe/utopia
- Graphiti by Zep — temporal edge invalidation over deletion,
  episodes as the provenance unit, hybrid retrieval:
  https://github.com/getzep/graphiti
