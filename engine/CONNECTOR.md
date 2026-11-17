# Relate

- `custom.relate` connects Muse to the local Relate by Neo4j graphs through their HTTP Query API v2. Each graph is served by its own `relate serve` process and answers at `POST <apiBase>/db/neo4j/query/v2` with a JSON body of `{"statement": "<Cypher>", "parameters": {}}`.

- The typed helper is `~/workspace/custom-connectors/custom.relate/bin/relate`. It reads the graphs registry, runs the common reads as fixed queries, and prints JSON. Prefer it over hand-written curl calls.

- The same graphs also back the `relate-graph` Space and the `relate-pipeline` workflow. This connector is the direct read surface for agents. It does not replace the Space or the pipeline.

## No credential, by design

- There is no API key, token or password for this connector, and there is nothing to store in the Secure Vault. Do not run a credential or connect flow for it.

- The Relate APIs run with `--auth none`. Access control is the loopback binding instead. Every API process listens on 127.0.0.1 only, one process per graph, so nothing off this machine can reach them.

- Never change that posture from this connector. Do not rebind an API to a public interface, add a tunnel, or republish a graph endpoint without the user's explicit instruction.

## The graphs registry

- The registry at `~/workspace/relate-space/graphs/registry.json` is the source of truth for which graphs exist. Each entry carries the slug, name, port, apiBase, store path, systemd service and status.

- Two graphs are registered today. `main` answers on port 7475 through `relate-api.service` and backs the Space. `test-graph` answers on port 7476 through `relate-graph@test-graph.service`.

- The helper resolves every `<graph>` argument through the registry. An unknown slug fails with exit code 2 and lists the valid slugs.

## List graphs

- Read the registry without touching any API. Use it to discover slugs before running a graph command.

```text
~/workspace/custom-connectors/custom.relate/bin/relate graphs
```

- The output is a JSON array with slug, name, port, apiBase, status, service and store for each graph.

## Check status

- Check every registered graph in one call. Each entry reports whether the API answered a live count query and how many nodes it holds.

```text
~/workspace/custom-connectors/custom.relate/bin/relate status
```

- A graph whose API is down still appears, with `reachable` set to false and a recovery hint in the error field. The command itself does not fail.

## Read counts

- Read node and edge counts for one graph.

```text
~/workspace/custom-connectors/custom.relate/bin/relate counts main
```

- The output is a JSON object with graph, nodes and edges. Counts move as the graphs are worked; read them live, never from this file. (At the 2026-11-16 defect pass close: main 213 nodes / 307 edges, test-graph 80 / 66 including its Decision-ledger artifacts, plus a third graph johnny-muse at 0 nodes.)

## Read label and type breakdowns

- Read node-label counts for one graph, largest first.

```text
~/workspace/custom-connectors/custom.relate/bin/relate labels main
```

- Read relationship-type counts for one graph, largest first.

```text
~/workspace/custom-connectors/custom.relate/bin/relate types main
```

- Verified live on main: labels are SourceDocument 65, Person 50 and Group 7. Types are MENTIONS 116, DESCRIBED_IN 56, IN_JOHNNYS_NETWORK 55, ABOUT 7 and ASSISTANT_OF 1. An empty graph returns an empty list for both.

## Read one node

- Read one node matched on its `slug` property, with its labels, properties, distinct neighbor count and up to 25 neighbors with their relationship types.

```text
~/workspace/custom-connectors/custom.relate/bin/relate node main johnny
```

- A long embedding vector is replaced with a short placeholder that states its dimension. The full vector stays available through the `query` command.

- A slug that matches no node fails with exit code 3 and a plain message.

## Run a raw query

- Run any Cypher statement against one graph and print the result fields and rows as JSON.

```text
~/workspace/custom-connectors/custom.relate/bin/relate query main 'MATCH (n:Person) RETURN n.slug AS slug ORDER BY slug LIMIT 3'
```

- This is the deliberate escape hatch for reads the typed commands do not cover. The graphs are the user's own local data, so no allowlist is applied. Still, treat it as read-only in practice: data writes go through the typed `write-batch` command (see the tool layer below), and the `relate-pipeline` workflow orchestrates those writes and verifies its own work.

- A rejected statement fails with exit code 1 and passes through the API error code and message, so a syntax error reads as a syntax error.

## Read SpaceSignal nodes

- List the nodes labeled `SpaceSignal` in one graph, with kind, refId, graphSlug, at and consumed, oldest first.

```text
~/workspace/custom-connectors/custom.relate/bin/relate signals main
```

- SpaceSignal nodes exist on main (written by the Space's own actions when chat messages, dispatches and graph creations happen). The command returns an empty list and exit code 0 on a graph with none. It never errors just because the label is missing.

## The deterministic tool layer

Mechanical graph operations are fixed code with typed inputs and a single JSON object on stdout — no LLM judgment anywhere in this layer. Exit codes match the rest of the helper (0 ok, 1 API/query failure or a refused operation, 2 usage/unknown graph, 3 not found). Refusals print a JSON object with a `refused` reason and exit 1; a refused item never partially applies.

### Ontology stamping and bookkeeping

- `relate stamp <graph> <house|foaf|prov-o|owl-time|skos|dcterms|org|schema-org>` — parse the vocabulary file in `ontologies/` and materialize it INTO the graph: one `Ontology` node per vocabulary (slug = vocabulary id; house = `house-memory-graph`), `OntologyClass`/`OntologyProperty` nodes keyed by NAME (MERGE, never duplicate), `definedBy` accumulating every vocabulary that defines the term, and `DEFINES_CLASS`/`DEFINES_PROPERTY` edges. All eight vocabularies parse fully in stdlib (Turtle, RDF/XML, and the schema.org JSON-LD), so the output's `scope` field reads `full`. Re-running stamp is a structural no-op. Descriptive properties are filled only when null — stamp never overwrites existing prose.
- `relate reconcile <graph>` — merge duplicate OntologyClass/OntologyProperty nodes that share a name (union of `definedBy` and mappings, DEFINES edges re-pointed, emptied duplicates deleted). Bookkeeping nodes only; content is never touched. Each merge is re-counted after it lands and reported in `merged` only when exactly one node with the name remains, otherwise it lands in `unresolved` with the reason. Output carries before/after counts.
- `relate scan-conflicts <graph>` — READ-ONLY. Reports `duplicateClasses`, `duplicateProperties`, `duplicateSlugs`, `contested` pairs, and `singleValueViolations` (a single-valued property — `legalName`, `sourcePath` — carrying multiple distinct live values on ONE node record; in practice that means duplicate-slug nodes or list-valued writes). Since 2026-11-17 (D-19) it also reports `edgeConflicts` (§6.5 kind 2: parallel live edges grouped by (from, type, to) carrying ≥2 distinct values on one qualifier — `fact` primary, any other scalar qualifier too; bitemporal/embedding/weight bookkeeping exempted, bookkeeping types DEFINES_*/DECISION/SUPERSEDED_BY out of scope) and `identityConflicts` (§6.5 kind 3: distinct live content nodes sharing a `normalizedName` with ≥2 distinct `legalName` values — candidates only, never auto-resolved). All three §6.5 contradiction kinds are now detected; the keys are additive and verify's conflicts-gate behavior is unchanged.

### Verification and embeddings

- `relate verify <graph>` — the deterministic gate suite as one command (20 gates: label/type census, missing + duplicate slugs, category presence and values, normalization consistency, embedding coverage/uniformity, bitemporal sanity, provenance, isolated nodes, duplicate class/property gates, the scan-conflicts results folded in, and `similar_to_lead_grade`). The gates are hand-coded equivalents of the Part A validation queries in `ontologies/house-memory-graph.cypher` — that file is the spec; the CLI does not execute it. Output `{passed, gates: {name: {passed, detail}}}`. Scoping choices, all deliberate: the missing-slug gate excludes `SpaceSignal` (slug-less by design) and the isolated gate also excludes the control-plane labels `Decision`/`ReviewItem` and `Question` (a stored question with zero relevant matches legitimately has no edges); contested pairs are reported in the conflicts gate detail but do not fail it (contested is the handled state — unhandled duplicates and single-value violations do fail it); `summary_gap` and `bitemporal_coverage` are informational gates that never block.
- `relate embed-missing <graph> [--force]` — embed every content node (Person/Group/SourceDocument) lacking an `embedding`, via the local Ollama runtime (model `embeddinggemma-2`, 768-dim output measured live 2026-11-17; relaunched the documented way if down). Text follows the EmbeddingGemma 2 document format: `title: {name} | text: {summary + key properties}`. Writes `embedding`/`embedding_dim`/`embedding_model`/`embedding_format`; `embedding_model` records the RESOLVED identity (parent variant @ digest prefix from /api/tags — `embeddinggemma-2:740m-q8_0@f4981a15b998` — never the mutable tag) and `embedding_format` is `eg2-doc-v1`. `--force` re-embeds every content node (the corpus-migration path; used for the 2026-11-17 v1→v2 re-embed of main's 122 content nodes). Output `{embedded, alreadyHad, force, model, format, failed}`. The verify uniformity gate checks the (dim, model, format) triple, so a mixed corpus fails loudly. Companion: `relate-search` embeds queries with the documented query prefix (`task: search result | query:`) and its vector candidate gate was recalibrated to raw cosine ≥ 0.68 for the v2 prefixed distribution (true matches 0.70–0.78, best nonsense 0.6688, Main 2026-11-17; calibration record in `~/workspace/relate-space/relate-search-notes.md`).
- `relate embed-edges <graph>` — for every edge carrying a `fact` sentence whose `fact_embedding` is missing or stale-format, embed the fact text onto the edge as `fact_embedding`/`fact_embedding_dim`/`fact_embedding_model`/`fact_embedding_format`. Fact sentences are embedded in the EmbeddingGemma 2 symmetric format (`task: sentence similarity | query: {fact}`), format marker `eg2-sym-v1`, model stamp resolved the same way as node embeddings. Output `{embedded, alreadyHad, noFact, model, format, failed}`. The tool only embeds what exists; a graph whose edges carry no fact sentences reports `embedded: 0` and `noFact` = all edges (main's honest state: 0 / 0 / 307 at the 2026-11-17 migration).

### The sanctioned write path and pipeline scans

- `relate write-batch <graph> <batch.json>` — THE write path for extracted data. Batch: `{nodes: [{slug, label, props}], edges: [{from, to, type, props}]}`. **Batch-atomic (managed transactions, 2026-11-17):** EVERY item is validated against the live graph first; if anything is refused, nothing is written and the output is `{atomic: true, applied: {nodes: 0, edges: 0}, refused: [...]}`; otherwise the whole apply (nodes, SUPERSEDED_BY links, edges) runs inside one HTTP managed transaction (`POST /db/neo4j/query/v2/tx` … `/commit`, DELETE rolls back) and lands in full or not at all. Enforcement: (a) every label/type must be stamped in the graph's in-graph ontology, else refused; (b) every item needs provenance (`sourcePath`, `source`, `sourceSlug`, or a non-empty `sources` list), else refused; (c) an item with `props.supersedes` naming a live node retires it retire-and-link style, and a same-slug single-value conflict applies only with a strictly newer `recordedAt` (old value preserved in `supersededValues`, plus a `SUPERSEDED_BY` link to the correcting SourceDocument when the batch provenance resolves to one in the graph), otherwise the item is refused as an undecidable contested candidate; (d) MERGE on slug / on (from, to, type); (e) **fact requirement:** every edge whose type is not in the exemption list must carry a non-empty `fact` prop — a concrete one-sentence fact using the endpoint names. Exempt types (not fact edges): `MENTIONS`, `DESCRIBED_IN` (document attachment), `DEFINES_CLASS`, `DEFINES_PROPERTY` (ontology bookkeeping), `SUPERSEDED_BY` (correction link), `DECISION` (ledger link), `SIMILAR_TO` (written by `similar`, never write-batch). **Identity by construction:** a node with no `slug` but a `name` gets its slug computed deterministically (`identity_slug`: lowercase, apostrophes stripped, punctuation→spaces, whitespace→hyphens — Cognee's generate_node_id normalization adapted to the hyphen scheme), so the same entity written from two documents MERGEs onto one node at write time; `normalizedName`/`normalizedSlug` are filled from the name/slug when absent. Fuzzier identity stays evidence-only (normalize-scan + `merge`).
- `relate normalize-scan <graph>` — READ-ONLY candidate pairs with the rule that matched: name-equal-after-canonicalization, slug collision after canonicalization, shared alias, shared identity key (`legalName`/`email`/`sourcePath`). Candidates are evidence for a reasoning step or a `merge` call, never an automatic merge.
- `relate categorize <graph>` — apply the ontology's deterministic category rules (Person→person, Group→group, SourceDocument by sourcePath kind: people pages, groups pages, standing files, indexes, profiles; any other SourceDocument falls back to `document` — added 2026-11-17, closing the missing_category residue a generic source document used to leave). Idempotent. Output `{categorized, updated, residue}` — residue slugs are the ones no rule covers, left for reasoning.
- `relate clean-scan <graph>` — READ-ONLY `{duplicateEdges, selfEdges, isolatedContent, undeclaredTypes}`.
- `relate communities <graph>` — deterministic label propagation over content edges (slug-seeded order, fixed iteration cap), writes the `community` property, renames communities `community-1..N` by size. Output `{communities: [{id, size}], assigned}`. Summaries are NOT this tool's job.

### Triplet extraction (Cognee steals #1/#2)

- `relate chunks <file> [--size N]` — deterministic paragraph chunker (default 4000 chars; oversized paragraphs split on sentence boundaries). Prints the chunks with char offsets PLUS the extraction contract: the Cognee KnowledgeGraph schema and its prompt rules (elementary types only, most-complete-name coreference, snake_case relationships, every edge carrying a concrete one-sentence fact using endpoint names, no outside knowledge, numbers stay in descriptions). The reasoning step (pipeline extraction stage) fills the contract per chunk; everything else is this tool layer.
- `relate extract <graph> <extraction.json>` — validate a filled extraction `{source: {slug, path, name}, nodes: [{name, type, description}], edges: [{source, target, relationship, fact}]}` and apply it through write-batch: types must be stamped classes, relationships (upper-snaked) stamped object properties, every edge's fact non-empty, endpoints resolving to extracted or existing nodes — any violation refuses the WHOLE extraction with the violations listed (exit 1, nothing written). Node slugs are identity-by-construction; an extracted entity's provenance is the accumulating `sources` list (never a single `sourcePath` — that property is single-valued and belongs to the SourceDocument itself, which extract creates when absent and links to every entity with a `MENTIONS` edge). A live node's existing summary is never overwritten by a later extraction — the first summary stands until a summarize pass improves it.

### Engine schema (DDL) and the memify pass

- `relate ddl <graph>` (or `relate ddl --api-base <url>` during provisioning) — apply the engine schema idempotently: a UNIQUE slug constraint per content label (Person, Group, SourceDocument, Company, Project, Place, Event, Commitment, Bid, Account) + Question, a plain slug index for the bookkeeping labels (Ontology, OntologyClass, OntologyProperty, Decision, ReviewItem, SpaceSignal — plain, not constraints, because Decision/ReviewItem ids use a count+renumber flow a constraint would hard-fail), a VECTOR INDEX per content label on `embedding`, and one FULLTEXT INDEX `node_text` over name/summary/alias/legalName/normalizedName. `stamp` runs it after stamping terms; the provisioning script runs it at graph birth. Duplicate-slug writes are now refused by the ENGINE (`ConstraintValidationFailed`), verified live on main. Companion `relate-search` uses the native indexes when present (its vector leg runs `db.index.vector.queryNodes` per label with raw cosine recovered as 2·score − 1 and the calibrated ≥ 0.68 gate preserved; its keyword leg runs `db.index.fulltext.queryNodes`) and falls back to the original Python legs only when the indexes are absent — never on a leg failure. Output reports which legs ran native.
- `relate-search <graph> "<q>" --triplets` — triplet retrieval (Cognee GRAPH_COMPLETION): the retrieved unit is the fact edge. Fact lines (source —fact→ target) ranked by a fixed combination — 0.40·fact-sentence cosine (query embedded in the symmetric eg2-sym-v1 format to match the stored fact vectors) + 0.30·best endpoint cosine + 0.20·mean endpoint cosine + 0.10·structure (endpoints among the search seeds) — times a memify weight factor neutral at the default 0.5 weights. No per-triplet embeddings are created (Cognee removed theirs, SDK-1115); the win is fact text + simple ranking.
- `relate-search <graph> "<q>" --questions` — prior-question retrieval (added 2026-11-17): an OPT-IN leg (default off, so default results stay byte-untouched) returning a top-level `priorQuestions` section plus `counts.questionCandidates`. Stored (:Question) nodes are ranked by two sub-legs RRF-fused (k=60): vector (raw cosine of the query vector against each stored question vector, gated at the content leg's 0.68 — stored questions are embedded in the QUERY format, eg2-query-v1, so they live in the space the search compares against; computed in Python by design: Question has a slug constraint but no vector index, and counts are small) and keyword (fixed-weight substring match over question text). Each entry carries its ABOUT targets ({slug, name, label}). Question is in the search exclusion set (BOOKKEEPING_LABELS) — stored questions never enter the content ranking or bend traversal counts. Works alongside --rerank and --triplets. Verified live 2026-11-17 on bestof-probe (paraphrase cosine 0.985); Main returns honest empty (no Questions stored yet).
- `relate-eval [graph] [--questions PATH] [--outdir DIR] [--limit N]` — the answer-evaluation harness (NVIDIA steal #1, added 2026-11-17): grades the ANSWERING path, not the graph. The same question set runs two ways — Arm A plain relate-search, Arm B --rerank plus --triplets for relational questions — scored by executed checks only, NO LLM judge: expected slug in top-k (rank recorded), expected fact substring in the retrieved corpus (top-5 hits read back via `relate node`), expected edge carried by a top-10 retrieved node (Arm B may satisfy it from a triplet line), absence questions passing only on an empty result set. READ-ONLY (runs relate-search + relate node only); exit 0 on completion regardless of pass rate. Question set: ~/workspace/relate-space/eval/questions.json (14 questions, every expectation verified from live reads before inclusion); reports (JSON + markdown) land in ~/workspace/relate-space/eval/. First Main run 2026-11-17: both arms 13/14 questions, 25/28 checks, mean 92.86%; rerank+triplets fixed none and broke none at pass/fail level; the one standing failure is q09 "Who is Johnny's assistant?" (0/3 both arms — the `muse` node is not retrieved in the top 15 despite the verified muse —ASSISTANT_OF→ johnny edge; Main's edges carry no fact sentences yet, so the triplet leg has nothing to rank). Run it as the gate for any answering-path change; a re-run is the proof a retrieval fix worked.
- `relate memify <graph> [--dry-run]` — memify lite (Cognee steal #5): recompute `feedback_weight`/`importance_weight` from the graph's own usage signals as a pure function of current state (state-based → re-running is a no-op): node feedback = min(1, 0.5 + 0.10 × resolved review items naming it); node importance = min(1, 0.5 + 0.05 × Question ABOUT hits); fact-edge feedback = min(1, 0.5 + 0.10 × resolved items naming both endpoints); fact-edge importance = mean of endpoint importance. Only values that differ are written; signal-free nodes stay bare (the triplet scorer defaults missing weights to 0.5).

### Corrections, similarity, renames

- `relate supersede <graph> <fact-ref> <batch.json>` — one decided retire-and-link as a single command. The mutation and its Decision-ledger write run inside one managed transaction (same treatment for `merge`, `unmerge`, and `review-resolve`): the change and its ledger entry land together or not at all, and a ledger failure inside a transaction rolls the mutation back instead of leaving an unlogged change. fact-ref is JSON: `{slug, property}` for a node-property fact, `{from, to, type}` for an edge fact. Fixed order: scan the correction, retire the old fact (`retiredAt` set, `validTo` closed; a node-property value is preserved in `supersededValues` first, in the form `value=<old>|source=<src>|retiredAt=<ts>`), apply the corrected fact with `recordedAt`, link with `SUPERSEDED_BY`, re-scan. For a node-property fact the link runs node → the correcting SourceDocument named in the batch's provenance. For an edge fact, a property graph cannot endpoint an edge, so the link is recorded as a `supersedesFact` property on the corrected edge — the honest subset, stated here rather than faked. Anything not verifiably a supersession (no provenance, undecidable scan) is REFUSED with the reason; this tool never adjudicates.
- `relate similar <graph> <threshold>` — content-node pairs at raw cosine >= threshold, computed in Python from the stored vectors (Relate's native cosine returns (1+cos)/2, so it is never used). Pairs are written as `SIMILAR_TO` edges with `grade: "lead"` and `confidence: "lead"`, `basis: "embeddinggemma-2-text"`. Explicit jobs only — never run it from a dream pass.
- `relate similar-scan <graph> <threshold>` — READ-ONLY twin of `similar`: the same pairs, `written: 0`, nothing stored. This is what report-only consumers (the dream candidates stage) run.
- `relate rename <graph> <class|property> <old> <new>` — rename a stamped ontology term and its conforming references (content-node labels for classes, node properties and edge types for properties). Limit: an object-property rename is refused when existing edges of that type carry properties, because edge properties cannot be copied across a type rename in this API; rename before edges accumulate properties, or migrate those edges explicitly.

### Merge log, decision ledger, review store (Utopia/Graphiti steals, graph-side)

- `relate merge <graph> <winner-slug> <loser-slug> <basis-json>` — deterministic merge: union of properties (winner wins conflicts; loser's overwritten values preserved in the winner's `supersededValues`), all edges re-pointed, the loser slug stamped as an alias on the winner, and a `(:Decision)` node `{kind: "merge", winner, loser, basis, at, reversible: true}` linked to the winner by a `DECISION` edge. The loser's full pre-merge state (properties + edge list) is stored ON the Decision node as JSON (`loserState`), which is what makes the merge reversible. Since 2026-11-17 (D-15) the winner is RE-EMBEDDED after the merge commits (document format eg2-doc-v1, resolved model stamp) so its vector reflects the merged content; the output reports `embeddingReembedded` + `reembed {reembedded, model, format, dim}` — an embed failure is reported in-band, never silent, and non-content winners are skipped with a reason.
- `relate vocab <graph>` — READ-ONLY vocabulary discovery (skill §2; added 2026-11-17). Deterministic token counts from content-node name/summary/category plus edge `fact` sentences, ranked by count, each term carrying up to 5 sources, a source count, and `coveredByOntology` checked against the stamped OntologyClass/OntologyProperty names (incl. CamelCase/snake_case pieces). The uncovered terms are the discovery signal for ontology growth (and feed the pipeline's induction stage).
- `relate unmerge <graph> <decision-id>` — restore the loser node and its edges from the Decision record, remove the alias, stamp the Decision `revertedAt`, and append an `unmerge` Decision. Union-copied properties are NOT stripped from the winner (the Decision record is the audit trail for what was copied).
- `relate log-decision <graph> <kind> <subject> <detail-json>` — append one `(:Decision)` ledger entry. Kinds: merge, unmerge, supersede, contest, resolve, stamp, reconcile (free-form kinds are accepted; these are the guaranteed ones). `relate decisions <graph> [--kind K] [--since ISO] [--limit N] [--newest-first]` lists entries (oldest first by default; `--since` filters on the entry timestamp, inclusive; output carries `count`/`total`/`filters`). `relate changes <graph> [--since ISO] [--limit N]` is the changes feed: entries newest-first, each with a deterministic one-line `summary` derived from kind+subject only (e.g. `merged <loser> -> <winner>`, `resolved review item <id>`, `stamped ontology <slug>`) — no LLM text.
- Ledger discipline: a command writes a Decision ONLY when it changes the graph — `stamp` only when counts, term properties, or the Ontology node's own properties changed, `reconcile` only when at least one group merged, `supersede` and `merge`/`unmerge` whenever they act. If a mutation lands but its ledger write fails, the command now fails with an `UNLOGGED CHANGE: …` error naming the mutation instead of a bare query error (the change stands; do not blindly retry). Decision slugs are sequential (`decision-0001`, …) per graph, allocated inside the create statement; this engine does not serialize count+create across concurrent statements, so a raced writer renumbers its own entry to `decision-NNNN-<elementId tail>` — ids stay unique, and only genuinely raced entries carry the suffix. Outside the ledger contract (they mutate without writing Decisions): `write-batch`, `categorize`, `communities`, `embed-missing`, `embed-edges`, `similar`, `rename`, `review-add`.
- `relate review-add <graph> <kind> <subject-json> <choices-json>` — open a `(:ReviewItem)` `{kind: duplicate|conflict|low-confidence, subject, choices, status: "open", at}`. `relate review-list <graph>` lists open items. `relate review-resolve <graph> <id> <choice>` refuses a choice that is not one of the item's choices, marks it resolved, and logs a `resolve` Decision. (The Space panel that displays these is a separate build; this is the typed store.)

### Implementation notes

- Node objects returned by the API carry `elementId` as a bare numeric string, while Cypher `elementId(n)` returns the `4:rl-id:n<n>` form. Never match nodes on the API-returned value; always select `elementId(n)` inside Cypher. (The first reconcile build matched on the bare form, reported merges that never happened, and was caught by the prescribed re-scan; the fixed version asserts every delete and re-counts every group.)
- Allowlists: `write-batch` and `verify` know the labels Person, Group, SourceDocument, Question, SpaceSignal, Ontology, OntologyClass, OntologyProperty, Decision, ReviewItem and the house relationship types plus DEFINES_CLASS/DEFINES_PROPERTY/DECISION/SUPERSEDED_BY/SIMILAR_TO. SIMILAR_TO is allowlisted but guarded differently: the `similar_to_lead_grade` gate fails any SIMILAR_TO edge carrying neither `confidence` nor `grade` — an unmarked (stray or hand-written) similarity edge still gets caught, while the sanctioned tool's lead-grade writes pass.

## Provision a graph

- Provision a new graph by slug. The `relate provision` CLI helper validates the slug and refuses a slug that is already registered, then runs the house provisioning script at `~/workspace/relate-space/graphs/provision-graph.sh`. The SCRIPT itself (rewritten 2026-11-17, defect D-10) is idempotent and race-safe: it holds flock on `registry.json.lock` for the whole run, checks the slug inside the lock (an existing slug is a verified no-op — service healed if down, same port, exit 0), writes a new entry as "provisioning" with nextPort advanced before starting the service, rolls the entry back on any later failure, and flips status to "live" only after the API count check and `relate ddl` succeed.

```text
~/workspace/custom-connectors/custom.relate/bin/relate provision <slug>
```

- The script creates the blank store, writes the service env file, starts `relate-graph@<slug>.service` on the next free port, verifies the API answers, applies the engine schema (`relate ddl --api-base`, see the DDL section), and appends the graph to the registry. The helper then prints the new registry entry.

- The `relate-graph-bot` cron provisions graphs the same way when the Space asks. Provisioning an existing graph a second time is a guard error, not a duplicate. Provisioning is exercised routinely (throwaway probe graphs are provisioned and deprovisioned by the audit/defect/best-of lanes).

## Recover from errors

- When a command reports that the main graph API cannot be reached, run the recovery script once and then retry the command:

```text
~/workspace/relate-space/ensure-api.sh
```

- When another graph's API cannot be reached, start its service once and then retry:

```text
systemctl start relate-graph@<slug>.service
```

- A VM replacement can wipe the systemd units under /etc. The canonical unit copies and the recovery script live in `~/workspace/relate-space/`, and the recovery script restores the main unit from there.

- After any recovery, prove the fix with a read before reporting success:

```text
~/workspace/custom-connectors/custom.relate/bin/relate status
```

## Guardrails and limits

- Never point this connector at the old urbex store under `~/workspace/research_notes`. That store is not registered, it is not served, and it stays out of this system unless the user says otherwise in plain words.

- Writes happen ONLY through the typed tool-layer commands below (`write-batch`, `stamp`, `reconcile`, `supersede`, `merge`/`unmerge`, `categorize`, `communities`, `embed-missing`, `embed-edges`, `similar`, `rename`, the Decision/ReviewItem commands). Each enforces its own gates and prints a JSON receipt. `provision` remains the only command that creates a new graph. Never hand-write graph mutations through `query` when a typed command covers the operation.

- Node lookup matches on the `slug` property only. A graph whose nodes lack slug properties needs the `query` command instead.

- The neighbor list in the `node` command caps at 25 entries and says so through its `neighborsTruncated` field. The count itself is exact and counts distinct neighbor nodes.

## Related skills

- Use `muse.skill_search` to find other skills and `muse.connector_search` to find other connectors.
