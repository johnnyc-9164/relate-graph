# Defect Register — Relate Graph system, 2026-11-16

Defect hunt executed 2026-11-16 ~18:10 – 19:00 CST (00:10–01:00Z) against the live system:
CLI (`~/workspace/custom-connectors/custom.relate/bin/relate`, `bin/relate-search`),
pipeline (`~/workspace/.jarvis/workflows/relate-pipeline.js`), bot cron `relate-graph-bot`,
hook `relate-space-signals`, the Space `relate-graph`, registry + systemd units, and both
live graphs (Main :7475, TEST :7476). All write tests ran on TEST or on throwaway probe
graphs — never on Main (one Main exception, D-01: a single synthetic SpaceSignal created
to reproduce the flood, consumed by full-tuple match in the same pass).

Severity key: **blocker** = live malfunction burning resources / corrupting work now;
**major** = wrong results, false verdicts, or data-integrity risk on a normal path;
**minor** = real defect, bounded blast radius.

Status key: **FIXED** = fixed by this hunt, with the named test; **OPEN** = not fixed
here (fix named; report-only surfaces are marked and route through the parent);
**CLEARED** = investigated, evidence says not a defect.

---

## BLOCKER

### D-01 — Hook wake flood: signals are never reliably consumed; any orphan signal is an infinite 10-second wake loop
- **Severity:** blocker · **Surface:** hook `relate-space-signals` + bot/hook worker instructions (REPORT-ONLY — not the hunt's surfaces)
- **Evidence:** (1) The original flood: hook log `~/hooks/logs/relate-space-signals.jsonl` shows **76 distinct worker runs** (distinct `execute_resolve_run_id`s) between 2026-11-16T23:50:40Z and 00:03:29Z, ~10.2s apart, all woken by one synthetic signal (kind `chat`, refId `hook-test`, graphSlug `main`, at 2026-11-16T23:50:34.651Z) that no worker ever consumed; the flood stopped only when the parent consumed it manually. (2) Live reproduction by this hunt: orphan signal `refId 'defect-probe-orphan'` created on Main at 2026-11-17T00:08:16.051Z; five samples over 2.5 minutes (00:08:53–00:10:56Z) show it — and the governance lane's two matched dispatch signals for TEST request 9 (refId `9`, at 00:02:02.970Z and 00:05:40.381Z) — still `consumed:false` after ~16 wakes. The unconsumed set *grew* during the window (dispatch `10` + chat `9` on Main arrived). (3) Root cause, two parts: the detector script wakes on EVERY poll while any unconsumed signal exists (it keeps no state — its `state_path` is unused by the script), and the worker instruction's mark-consumed step (hook definition step 4, read via hooks.view) says to mark only signals "whose work you completed (or confirmed already done…)" and to "leave consumed:false any signal whose work you could not complete" — an orphan signal has no queue item, so no worker can ever satisfy that wording for it; and even for matched signals, consumption is the last step of a minutes-long sweep, so every signal floods for its worker's whole run duration. Zero worker-side consumptions are proven anywhere; the only proven consumers are the setup pass (9 stale signals) and manual consumes.
- **Status:** OPEN. **Named fix (hook side, exact):** (1) Worker instruction — consume-on-inspect: a woken worker marks EVERY signal in its wake payload consumed once it has inspected it, orphans included (orphanhood is noted in its summary); a signal is left unconsumed ONLY if the consume write itself failed. (2) Detector-side guard: persist the last-wake payload hash + timestamp (the runtime already gives the hook a state path, `~/hooks/state/relate-space-signals.json`); stay silent while the unconsumed set is unchanged within a cooldown window unless the set grew. Either fix alone terminates the loop; both together also stop the matched-signal flood window. The hunt's probe signal was consumed by full-tuple match (`kind+refId+graphSlug+at`) after reproduction; subsequent wake payloads confirm exclusion.

---

## MAJOR

### D-02 — Pipeline ran import BEFORE ontology: every write job on a fresh graph silently imported nothing
- **Severity:** major · **Surface:** workflow `relate-pipeline.js` (stage order)
- **Evidence:** `write-batch` refuses every node whose label is not stamped in the graph's ontology (CLI code + behavior). Pre-fix stage order was intake → import → ontology, and the ontology stage skipped for pure import jobs, so an import/full-pipeline job on an unstamped graph applied 0 nodes, then stamped, never re-imported, and could still write back "done". Tool-level proof on throwaway graph `defect-probe`: the same batch before stamping → `applied {nodes: 0}`, refused "label 'Person' is not stamped in the graph's ontology"; after `relate stamp defect-probe house` → `applied {nodes: 1}`, no refusals. (Request 2's import succeeded historically only because it ran on the pre-CLI pipeline.)
- **Status:** FIXED. Stage order is now intake → ontology → import (meta phases + blocks swapped, prior-context args adjusted), and the ontology stage carries a BLANK-GRAPH RULE: on an unstamped graph where any stage will write, stamp `house` first even for non-ontology categories. End-to-end test: workflow run `workflow-run-22e3071b2d054c27b0c2dc9f61e3b748` (launched BY NAME, category `import`, fresh graph `defect-probe-2`, tiny named source) — the ontology stage stamped house under an import job ("per blank-graph rule stamped 'house' first", 0/0 → 67 nodes/66 edges, decision-0001), the import stage then applied its extraction via write-batch, and the run finished at **72 nodes / 76 edges** with content Person 2 / Project 1 / SourceDocument 1 (census verified by this hunt before deprovisioning). The run's verification still returned passed=false — entirely on D-04's coverage gates (missing_category on the imported SourceDocument, normalization_consistency, community_coverage for a communities stage an import job never runs), with embedding_coverage fixed by the repair loop (embed-missing 4/4). The import defect itself is closed; the verdict-shape problem is D-04.

### D-03 — Category `query` has no stage that executes a query: false "done" writebacks
- **Severity:** major · **Surface:** workflow
- **Evidence:** The workflow's stage set is intake/import/ontology/categorizing/normalization/cleaning/summarize/embeddings/communities/candidates/verify/writeback. No stage runs a query for category `query`; every stage returns "skipped", verify runs against an unchanged graph, and writeback (when a requestId exists) marks the request `done` with a result that answers nothing.
- **Status:** FIXED (best-of lane, 2026-11-16; personally re-verified 2026-11-17). The workflow now has a dedicated `query` phase: for category `query` all write stages skip by design and the query stage runs the agentic GraphRAG loop (skill §8) with read-only tools (relate-search incl. `--rerank`/`--triplets`, node, query), puts the grounded answer (or the exact "that's not in this graph") in the stage summary/writeback, and the verifier fails a query job whose summary answers nothing. Grep-verified in the live workflow file 2026-11-17.

### D-04 — The verifier contract disagrees with itself three ways (skill §10 vs pipeline verifier prompt vs CLI gates)
- **Severity:** major · **Surface:** CLI `verify` + workflow verifier prompt + skill §10
- **Evidence:** (a) The verifier prompt's gate (1) census allowlist omits the `Decision`/`ReviewItem` labels and the `DECISION` type that the CLI allowlists and both live graphs legitimately carry — an agent following the prompt literally fails healthy graphs. (b) Prompt gate A6/(4) says missing-category should *report, not fail*, when categorizing has never run; the CLI `missing_category` gate fails unconditionally — so an import-only job on uncategorized nodes ends "failed" even when the import worked (observed live during this hunt's TEST fixture runs, and end-to-end in run `workflow-run-22e3071b2d054c27b0c2dc9f61e3b748`: a successful import closed passed=false on missing_category + normalization_consistency + community_coverage — three gates for stages the import job never included), the mirror image of D-02's false-done. (c) Gates claimed but implemented nowhere: pattern-triplet conformance (skill §10 gate 2), in-graph-ontology conformance as a CLI gate (prompt gate 9 — the CLI checks censuses against its own hardcoded allowlists, not against the stamped ontology), §10 gate 4 provenance for 100% of nodes+edges (CLI checks only SourceDocument `sourcePath` presence/uniqueness), a merge-audit/ledger gate (§10 gate 9), broken-supersession-chain and contested-missing-side checks (prompt 10b/10c, skill gate 11).
- **Status:** FIXED (best-of lane, 2026-11-16; personally re-verified 2026-11-17). The verifier prompt now enumerates exactly the CLI's 20 gates as the canonical list ("a gate this prompt expects that the CLI does not emit, or a CLI gate you ignore, is itself a discrepancy") and applies JOB-AWARE COVERAGE: missing_category / embedding_coverage / community_coverage / normalization_consistency fail a run only when the corresponding stage ran in that job; summary_gap and bitemporal_coverage stay informational. Companion fix landed 2026-11-17 (personal pass): the CLI's categorize rules gained the `document` fallback for generic SourceDocuments, so the smoke-run residue that kept tripping missing_category is gone — `relate categorize bestof-smoke` now returns residue [] and `relate verify bestof-smoke` passes=true.

### D-05 — write-batch is not batch-atomic: a refused edge leaves its applied nodes behind
- **Severity:** major · **Surface:** CLI `write-batch`
- **Evidence:** TEST experiment: batch with one valid Person node + one edge of undeclared type `ZZ_UNDECLARED` returned `applied {nodes: 1, edges: 0}` with the edge refused — and the node persisted (verified by `relate node`). Code confirms the shape: all applicable nodes are MERGEd before any edge is validated. CONNECTOR.md claimed only item-level atomicity ("a refused item never partially applies"); the doc now states the batch-level truth.
- **Status:** FIXED (best-of lane phase 1a, 2026-11-16; personally re-verified live 2026-11-17). write-batch now validates the WHOLE batch first and applies inside one HTTP managed transaction (POST /db/neo4j/query/v2/tx … /commit, DELETE rolls back). Personal proof on TEST 2026-11-17: the register's own fixture shape (one valid Person + one ZZ_UNDECLARED edge) returned `{atomic: true, applied: {nodes: 0, edges: 0}}` with the edge refused, and `relate node test-graph atomicity-probe-person` returned not-found (exit 3) — nothing persisted. The design call was settled by implementing the Relate usage audit's named remedy (managed transactions).

### D-06 — Decision/ReviewItem slug allocation raced: concurrent writers minted duplicate ledger ids
- **Severity:** major · **Surface:** CLI `write_decision`, `review-add`
- **Evidence:** Allocation was count-then-CREATE across two HTTP calls. Blast test on TEST: 12 parallel `log-decision` calls returned only **7 unique ids** (decision-0010 ×2, decision-0012 ×5) and verify then failed `duplicate_slugs` + `conflicts`. Re-testing after the first fix attempt (count folded into the CREATE statement) showed this engine does **not** serialize count+create across concurrent statements either — same duplicates.
- **Status:** FIXED. Allocation now happens inside the create statement AND is followed by a uniqueness check: on collision the writer renumbers its own node (matched by elementId) to `decision-NNNN-<elementId tail>`, unique by construction. Re-blast: 12 parallel writers → **12 unique stored ids** (7 clean sequential + 5 suffixed, e.g. `decision-0015-rlidn102`). Same guard in `review-add`. Blast fixtures were deleted afterward; TEST verify returned to passed=true, 20/20.

### D-07 — A mutation could land while its Decision ledger write failed silently; stamp also skipped the ledger for property-only changes
- **Severity:** major · **Surface:** CLI ledger discipline (stamp/reconcile/supersede/merge/unmerge/review-resolve)
- **Evidence:** All six commands applied their mutation first and called `write_decision` last; a ledger failure surfaced as a bare query error naming no mutation — and for `merge`, the loser's pre-merge state lives ONLY on that Decision, so a failed ledger write meant an irreversible, unlogged merge. Separately, `stamp` wrote its Decision only when total node/edge counts changed, so property-only stamp changes (a next-day `stampedAt`, a first-filled `mapsTo`) mutated the graph unlogged, contradicting CONNECTOR.md's "writes a Decision ONLY when it changes the graph" discipline in both directions.
- **Status:** FIXED. (1) New `logged_decision()` wrapper at all six call sites: a ledger failure after a landed mutation now fails the command with `UNLOGGED CHANGE: <mutation> was applied … do not retry blindly`, naming the mutation. (2) `stamp` now snapshots term properties + the Ontology node's properties (excluding `stampedAt`) before/after and logs on ANY change. Tests: `relate stamp test-graph House` (display-form name, see D-11) on an unchanged graph → `decision: null`, counts identical; first stamp on `defect-probe` → decision-0001 created. The UNLOGGED failure path itself was not force-tested (it requires breaking the API mid-command); the wrapper is code-reviewed and every call site compiles and runs.

### D-08 — `similar` wrote the wrong lead-grade property, and verify's census rejected SIMILAR_TO outright
- **Severity:** major · **Surface:** CLI `similar` + `verify`
- **Evidence:** `cmd_similar` wrote `grade: 'lead'` only, while skill §0 and the pipeline's shared context mandate `confidence: 'lead'`; and `ALLOWED_TYPES` excluded SIMILAR_TO, so any sanctioned similarity pass made `verify` fail `type_census` forever after. CONNECTOR.md framed the exclusion as deliberate stray-catching, but it caught requested writes identically.
- **Status:** FIXED. `similar` now writes both `grade` and `confidence` = 'lead'; verify allowlists SIMILAR_TO and gains gate `similar_to_lead_grade` (fails any SIMILAR_TO edge carrying neither mark — strays still get caught). Suite is now 20 gates. Test on TEST: embed 3 fixtures → `similar 0.0` wrote 3 edges, all carrying grade+confidence 'lead'; `type_census` and `similar_to_lead_grade` pass.

### D-09 — Bot cron and hook worker sweep the same queues with no atomic claim; wedged "running" requests are never reaped
- **Severity:** major · **Surface:** bot cron body + hook worker instruction (REPORT-ONLY)
- **Evidence:** Both consumers read the same "awaiting-agent" chat messages and "requested" dispatches and both can reply/launch; the only dedup is a `list_runs` check (check-then-act, racy). Consumption of the signal that woke them is a separate last step (see D-01). Nothing reaped a request stuck in "running": TEST request 6 (dream) sat at status "running", updatedAt 2026-11-16T23:53:32Z, result null, for ~38 minutes — while a separate dream re-smoke of the same category passed with zero writes, i.e. the request was wedged, not working. It was closed only by a human: marked failed on Johnny's tap at 18:31 CST and re-filed as request 11 (which completed honestly, zero writes). No automated mechanism noticed or recovered it.
- **Status:** FIXED (capability swarm lane 6, 2026-11-17). Both sweepers (bot cron body + hook worker instruction) now share one claim discipline: CLAIM + LAUNCH (claim via updateagentrequest status "running" with a worker-named claim note in `result`, re-read to confirm ownership, first claim wins, then launch) and a REAPER (a "running" request with updatedAt >30 min old and no live pipeline run carrying its requestId is reset to "requested" with a reaped note; conservative fallback when list_runs is unavailable). Chat got the matching light claim (re-read before composing; agentreply is the claim). Contracts verified against live action schemas before writing.

### D-10 — Provisioning races: nextPort read-modify-write without locking, no idempotency, orphan services on partial failure
- **Severity:** major · **Surface:** `~/workspace/relate-space/provision-graph.sh` + registry (REPORT-ONLY)
- **Evidence:** The script reads `nextPort` from `registry.json`, starts the service, then writes the registry back — no lock, so two concurrent provisions can take the same port and one registry write clobbers the other. The script itself does not check for an existing slug (the CLI wrapper does; a direct or raced invocation doesn't). A failure after `systemctl start` leaves a running service with no registry entry. Sequential provisions during this hunt (defect-probe → 7477, defect-probe-2 → 7478) worked — and then the race happened live anyway: while this hunt ran, another lane provisioned `johnny-muse` on port 7479 from the same registry; this hunt's deprovision restore, written against its own earlier backup, briefly reset `nextPort` to 7477 (which would have collided at 7479 two provisions later). Caught on read-back and corrected to 7480; `johnny-muse` itself was never touched and stands live at 0 nodes. The defect is concurrency-shaped and now has an in-the-wild instance involving this hunt as one of the racers.
- **Status:** FIXED (capability swarm lane 6, 2026-11-17). provision-graph.sh rewritten: the whole run holds flock on registry.json.lock; slug checked inside the lock; new entries written as "provisioning" with nextPort advanced BEFORE the service starts, ERR-trap rollback removes the entry on failure (nextPort never rolled back — a burned port is harmless); status flips to "live" only after the API count check and `relate ddl` succeed; re-running an existing slug is a verified no-op (service healed if down, same port). Live proof: swarm-probe provisioned on 7482 (0 nodes, full DDL), second run "already provisioned (no changes)" with registry unchanged, then deprovisioned cleanly (service disabled, store+env to recoverable trash expiring 2026-12-17, registry byte-identical except nextPort 7482→7483).

---

## MINOR

### D-11 — `stamp` refused every display-form ontology name (FOAF, Dublin Core, schema.org, House)
- **Severity:** minor · **Surface:** CLI `stamp` · **Status:** FIXED
- **Evidence:** The vocab argument had to match the exact lowercase key; presets and pipeline prompts name ontologies in display forms, and the ontology stage prompt says "preset = the one the task names". `relate stamp test-graph FOAF` exited 2 pre-fix.
- **Fix/test:** `normalize_vocab()` — case/whitespace normalization plus an alias map (schema.org→schema-org, Dublin Core→dcterms, W3C ORG→org, PROV→prov-o, house-memory-graph→house, …). Test: `relate stamp test-graph House` → resolved to house-memory-graph; unknown name still exits 2 with the valid list.

### D-12 — write-batch property supersessions wrote no SUPERSEDED_BY link (cmd_supersede does)
- **Severity:** minor · **Surface:** CLI `write-batch` · **Status:** FIXED
- **Evidence:** Two write paths produced two graph shapes for one operation: the batch path appended to `supersededValues` only; the typed `supersede` command also MERGEs `(node)-[:SUPERSEDED_BY {factKey, oldValue, newValue}]->(correcting SourceDocument)`.
- **Fix/test:** The batch path now resolves the correcting document from the item's provenance and writes the same link when one resolves. TEST A/B: batch supersession of `zz-defect-a.legalName` returned `supersededByLinkTo: zz-defect-doc`, and a query confirmed the edge with factKey/oldValue/newValue matching `cmd_supersede`'s shape.

### D-13 — `merge` had no label guards: bookkeeping nodes and cross-label pairs were mergeable
- **Severity:** minor · **Surface:** CLI `merge` · **Status:** FIXED
- **Evidence:** No label checks existed before mutation; `normalize-scan` generates cross-label candidate pairs (Person vs SourceDocument sharing an identity key), one adjudication slip away from a corrupting merge; a Decision/ReviewItem/Ontology node could be merged away entirely.
- **Fix/test:** Refuse (pre-mutation, exit 1 with `refused` JSON) when either side carries a bookkeeping label (Ontology/OntologyClass/OntologyProperty/Decision/ReviewItem/SpaceSignal) or the two first labels differ. TEST: both refusal shapes returned, counts unchanged (79/70 before and after).

### D-14 — Merge/unmerge did not round-trip the winner's alias form (string became a list forever)
- **Severity:** minor · **Surface:** CLI `merge`/`unmerge` · **Status:** FIXED
- **Evidence:** Behavioral on TEST (pre-fix): winner alias `"zz-a-alias"` (string) → after merge `["zz-a-alias", "zz-defect-b"]` → after unmerge `["zz-a-alias"]` — the scalar form was lost even though the merge was "reverted".
- **Fix/test:** `merge` records `winnerAliasForm` (string/list/absent) on its Decision; `unmerge` restores the scalar when the form was string and exactly the original entry remains. Post-fix cycle on TEST returns the scalar `"zz-a-alias"` (confirmed by value and by a subscript query erroring "requires a list or map"). Merges recorded before the fix lack the prop; their unmerges keep the old list behavior.

### D-15 — Merge leaves the winner's embedding stale
- **Severity:** minor · **Surface:** CLI `merge` · **Status:** FIXED (capability swarm lane 1, 2026-11-17 — stronger than the named fix: merge now RE-EMBEDS the winner post-commit via embed-missing's machinery, document format eg2-doc-v1 + resolved stamp, and reports `embeddingReembedded`/`reembed`; embed failure reported in-band, never silent. Proven on bestof-probe fixture pair lane1-merge-winner/loser: winner vector changed on every component, stamps updated, loser gone (exit 3), slug kept as alias, decision-0006 logged.)
- **Evidence:** Merge copies loser properties into the winner but keeps the winner's old `embedding`; `embed-missing` only embeds nodes whose embedding IS NULL, so the merged node's vector never reflects the merged content (skill §8 expects re-embedding after merges).
- **Named fix:** null the winner's `embedding`/`embedding_dim`/`embedding_model` inside `merge` (after property absorption) and report `embeddingInvalidated: true` in the output, letting the normal embed-missing stage re-embed.

### D-16 — Verify's isolated-nodes gate failed legitimate Question nodes
- **Severity:** minor · **Surface:** CLI `verify` · **Status:** FIXED
- **Evidence:** The gate excluded SpaceSignal/Decision/ReviewItem but not Question; the hook's answering loop stores Question nodes whose ABOUT edges are lead-grade matches — zero matches is a legitimate outcome, and such a node failed the gate.
- **Fix/test:** Question added to the exclusion. TEST: with a lone Question fixture present, the gate's count stayed 1 (the genuinely isolated fixture Person) instead of 2.

### D-17 — clean-scan flagged the ledger's own DECISION edges as undeclared
- **Severity:** minor · **Surface:** CLI `clean-scan` · **Status:** FIXED
- **Evidence:** clean-scan's declared set was stamped object properties ∪ CONVENTION_TYPES, and CONVENTION_TYPES lacked DECISION (verify's allowlist has it) — TEST carries 2 DECISION edges from review-resolve links.
- **Fix/test:** DECISION added to CONVENTION_TYPES. Post-fix `clean-scan test-graph` → `undeclaredTypes: []` with those edges present.

### D-18 — `node` neighborsTruncated off-by-one
- **Severity:** minor · **Surface:** CLI `node` · **Status:** FIXED
- **Evidence:** The neighbor query used `LIMIT 25` and reported `neighborsTruncated: len >= 25` — a node with exactly 25 neighbors was reported truncated when nothing was cut.
- **Fix:** Fetch 26, slice to 25, truncate flag = more than 25 existed. (Arithmetic fix; no live node with exactly 25 neighbors was available to demo against — Main's hubs exceed the limit on both versions.)

### D-19 — scan-conflicts implements roughly one of the three contradiction kinds the skill claims
- **Severity:** minor · **Surface:** CLI `scan-conflicts`/`build_scan` · **Status:** FIXED (capability swarm lane 1, 2026-11-17: build_scan now also returns `edgeConflicts` (§6.5 kind 2 — parallel live edges by (from,type,to) with ≥2 distinct qualifier values) and `identityConflicts` (kind 3 — shared normalizedName with divergent legalName, candidates only); additive keys, verify gate behavior unchanged. Proven on bestof-probe with planted fixtures — exactly the planted pair reported in each new key; Main scan clean across every key including both new ones. Lane 1 also landed `relate vocab` (vocabulary discovery) in the same pass.)
- **Evidence:** `singleValueViolations` groups values per node record, so it detects only duplicate-slug nodes and list-valued properties; §6.5 kind 2 (conflicting edges between the same pair) has no implementation, and kind 3 (cross-node identity conflicts) surfaces only via duplicate slugs. CONNECTOR.md's scan bullet now states the true scope.
- **Named fix:** extend `build_scan` with same-pair/same-type edge-conflict detection and shared-identity-key cross-node checks (normalize-scan's fixed rules are the seed), and rename the gate claims to match until then.

### D-20 — The Decision ledger is not a complete change history (mutators that never log)
- **Severity:** minor · **Surface:** CLI ledger contract · **Status:** OPEN
- **Evidence:** `write-batch`, `categorize`, `communities`, `embed-missing`, `embed-edges`, `similar`, `rename`, and `review-add` all mutate the graph and write no Decision. The new `changes` feed (A-02) inherits the gap: it is a feed of adjudicated decisions, not of all changes. CONNECTOR.md previously implied broader discipline; it now scopes the claim explicitly and lists the non-logging mutators.
- **Named fix:** decide the contract — either rename the ledger's claim everywhere to "adjudicated decisions" (docs already updated to this effect) or add ledger writes to the mutating commands.

### D-21 — relate-search could not find merged nodes by their absorbed aliases
- **Severity:** minor · **Surface:** CLI `relate-search` · **Status:** FIXED
- **Evidence:** The keyword leg and the `--rerank` identity features skipped any field whose value was not a string; a merged node's `alias` is a LIST, so absorbed names/slugs never keyword-matched.
- **Fix/test:** `_field_text()` joins list values in both legs. TEST: fixture Person with `alias: ["zzqxw-token"]` → `relate-search test-graph "zzqxw"` returns it with `matchedFields: ["alias"]` (pre-fix the leg skipped the field entirely).

### D-22 — Dream summarize stage wrote summaries through the raw API, violating the write-batch-only rule
- **Severity:** minor · **Surface:** workflow dream stage · **Status:** FIXED
- **Evidence:** Skill §0.5 + the pipeline's own determinism context: reasoning-stage writes go through write-batch. The summarize prompt said "SET the 'summary' property on the node through the Relate API".
- **Fix:** Prompt now mandates one write-batch carrying every summary as a property update on its existing node, and forbids raw-API/Cypher property writes. (Dream communities already used write-batch; candidates was the other exception — D-23.)

### D-23 — Dream candidates stage hand-computed cosines over every embedding pulled into agent context
- **Severity:** minor · **Surface:** workflow dream stage + CLI · **Status:** FIXED
- **Evidence:** The prompt instructed the agent to pull all content embeddings via `relate query` and compute raw cosine itself — token blowup and a determinism violation — because no read-only similarity tool existed.
- **Fix/test:** New CLI command `similar-scan <graph> <threshold>` (the `similar` computation, `written: 0`); the candidates prompt now runs it. TEST: `similar-scan test-graph 0.0` returned 3 pairs with counts unchanged (79/67 before and after).

### D-24 — Writeback silently corrupted stored result text (apostrophes → curly quotes)
- **Severity:** minor · **Surface:** workflow writeback · **Status:** FIXED
- **Evidence:** `resultText.replace(/'/g, "’")` rewrote every apostrophe in the result stored on the Space request. Action args travel as tool JSON; the escaping protected nothing.
- **Fix:** Replacement removed; result text is stored verbatim.

### D-25 — Pipeline prompts lag the typed tool layer (merge/supersede/rename tools exist; no stage calls them)
- **Severity:** minor · **Surface:** workflow stage prompts · **Status:** FIXED (best-of lane phase 5c, 2026-11-16; grep re-verified 2026-11-17: the workflow's determinism block names supersede/merge/unmerge/rename as the ONLY sanctioned correction paths — "CORRECTIONS ARE TOOLS, NEVER HAND-EXECUTED SEQUENCES" — with exact command shapes, and retire-and-link is no longer a hand-executed Cypher sequence in stage prompts.)
- **Evidence:** Grep of the workflow file: zero calls to `relate merge`, `relate supersede`, or `relate rename` (the known reverse gap — verified still true, not re-reported as new). Prompt-level specifics: the normalization stage routes merges "through write-batch" (write-batch cannot merge — every real merge becomes a blocker), and the ontology stage says standardization renames have "NO typed tool yet" although `rename` shipped in phase 4. (The embeddings stage's stale "no typed similarity tool" claim was fixed in this pass, D-23.)
- **Named fix:** normalization merges → `relate merge <winner> <loser> <basis-json>`; decided corrections → `relate supersede`; renames → `relate rename`; retire-and-link stops being a hand-executed Cypher sequence in stage prompts.

### D-26 — Space getgraph ships every node's full embedding vector (payload bloat)
- **Severity:** minor · **Surface:** Space `relate-graph` (REPORT-ONLY)
- **Evidence:** `getgraph` on Main (202 nodes at the time) returned a 1,423,692-byte payload — each node carries its 768-float embedding as text. The canvas never renders vectors; cost grows linearly with content.
- **Named fix:** strip `embedding` from getgraph node payloads (relate-search and the CLI read the API directly and are unaffected).
- **Status:** FIXED (capability swarm lane 5, 2026-11-17). `fetchLiveGraph` in the Space's server actions now deletes `embedding` and `fact_embedding` from getgraph node props (the shared cleanProps helper untouched, so getnode keeps full detail). Live proof on Main: payload 1,441,284 → 186,922 bytes (~87% drop), counts identical 194/307, 0 nodes carrying either vector key, embedding_dim/model/format retained so the detail panel's summary line still renders; getnode on `johnny` still returns the complete vector; active graph still Main; all 22 action contracts intact.

### D-27 — Ontology filter chips: color collisions in the 16-color palette
- **Severity:** minor · **Surface:** Space `relate-graph` (REPORT-ONLY)
- **Evidence:** getgraph `filterTypes` on Main: `Bid` and `Person` both carry `#f5b04c`. Colors are FNV-1a hash → 16-color palette, so collisions are guaranteed as the class count grows (Main now stamps 13+ classes) — contradicting the filters lane's "every type distinct color" claim.
- **Named fix:** collision-aware assignment — hash to a starting slot, linear-probe to an unused palette color per graph census.

### D-28 — Bot cron body still carries the stale active-graph fallback and a stale category list
- **Severity:** minor · **Surface:** bot cron body (REPORT-ONLY)
- **Evidence:** The body still instructs a fallback that switches the SHARED active graph (and restores it after) when listing another graph's requests — written before the `listAgentRequests` graphId fix. A bot run dying mid-switch strands Johnny's Space on the wrong graph, and the switch races Johnny's own use. The body's category list also omits `dream`/`full-pipeline`, and its action names use the wrong case (`getStatus` vs the real `getstatus`) — self-corrected only because the body also says to list actions first.
- **Named fix:** delete the fallback (graphId covers every graph), refresh the category list and action names.
- **Status:** FIXED (capability swarm lane 6, 2026-11-17). Bot body + hook prompt refreshed: category list now exactly "import, ontology, categorizing, normalization, embeddings, communities, processing, cleaning, query, full-pipeline, dream"; the active-graph fallback is deleted and replaced with a VERIFIED ACTION CONTRACTS block (listagentrequests graphId INTEGER, listchatmessages graphId STRING slug, never setactivegraph to read queues); all 22 action names in verified lowercase. Grounding rule, agentic loop, guardrails, and the eval block preserved verbatim (grep-verified on the saved file). Also fixed at parent level the same pass: the hook prompt's Question-node storage paragraph still named the retired v1 "embeddinggemma" — now specifies EmbeddingGemma 2, the eg2-doc-v1 document format, and the resolved stamp embeddinggemma-2:740m-q8_0@f4981a15b998. Correction to the record: there is no live ~/workspace/cron.d/minutely/ copy of the bot (only an archived one); the single live definition is the goal-owned copy, updated via cron.update.

### D-29 — embed-edges double-counts parallel same-fact edges
- **Severity:** minor · **Surface:** CLI `embed-edges` · **Status:** OPEN
- **Evidence:** The write matches on (from, type, to, fact) and SETs every parallel edge, while `embedded` increments per returned row — with parallel identical edges the count overstates distinct edges changed. The SET itself is idempotent, so impact is reporting-only.
- **Named fix:** count distinct (from, type, to, fact) tuples actually updated.

### D-30 — categorize silently overwrites reasoning-assigned categories
- **Severity:** minor · **Surface:** CLI `categorize` · **Status:** OPEN
- **Evidence:** `if props.get("category") != category: SET` — whenever the fixed rules fire (Person always → "person"), an existing category assigned by a reasoning stage (e.g. a categorizing residue decision applied via write-batch) is overwritten without appearing anywhere in the output beyond the aggregate `updated` count.
- **Named fix:** fill only NULL categories, or list every overwrite (slug, old, new) in the output.

### D-31 — rename applies to all duplicate term nodes and misses slug-keyed references
- **Severity:** minor · **Surface:** CLI `rename` · **Status:** OPEN
- **Evidence:** The term update matches by name with no count check on the OLD name (the new-name side does check) — with unreconciled duplicates, every duplicate is renamed. Node-property references stored as strings (e.g. category/community values equal to a renamed term) are outside its surgery set.
- **Named fix:** refuse when the old name matches more than one term node (mirror the new-name guard); document string-reference scope.

### D-32 — Docs-vs-reality batch (statements the live system contradicted)
- **Severity:** minor · **Surface:** CONNECTOR.md / ONTOLOGIES.md / workflow CTX · **Status:** FIXED in this pass
- **Evidence & fixes:** CONNECTOR.md claimed verify runs "the Part A gate suite from house-memory-graph.cypher" (the gates are hand-coded equivalents; the .cypher is never executed — doc corrected, 20 gates, Question exclusion and SIMILAR_TO gate documented); the scan-conflicts bullet overstated singleValueViolations scope (corrected, see D-19); the SIMILAR_TO allowlist story (rewritten, see D-08); write-batch "contradiction scan before apply" (corrected to per-item live checks + non-atomicity disclosed, see D-05); ONTOLOGIES.md said "the verify stage runs the read-only validation set in house-memory-graph.cypher (Part A)" (corrected to the CLI gate suite); the workflow's CTX and import prompt repeated the write-batch scan claim (corrected). The CONNECTOR.md counts parenthetical is refreshed at the end of this register.

---

## ADDENDUM — decisions-API sharpening (requested work, landed and tested)

### A-01 — `decisions` gains --since / --limit / --newest-first
- **Status:** DONE-WHEN-TESTED. Flags parse in any order alongside `--kind`; `--since` filters on the entry timestamp (ISO strings compare lexicographically), `--limit` applies after sort; output adds `count`/`total`/`filters`. Tests on TEST: `--kind defect-probe` returns exactly the probe entry; `--since 2999-01-01` returns empty; `--newest-first --limit 1` returns the latest merge decision (used live in the D-14 test).

### A-02 — New `changes` feed command
- **Status:** DONE-WHEN-TESTED. `relate changes <graph> [--since ISO] [--limit N]` — Decision entries newest-first, each with a deterministic one-line `summary` built from kind+subject templates only (`merged …`, `unmerged …`, `superseded fact on …`, `resolved review item …`, `stamped ontology …`, `reconciled duplicate ontology terms in …`, fallback `<kind>: <subject>`). Test: after `log-decision test-graph defect-probe …` created decision-0009, the feed's top entry was that mutation with summary `defect-probe: defect-hunt`, followed by `resolved review item review-0003` (decision-0008).

### A-03 — Ledger-discipline verification of the CONNECTOR.md claim
- **Status:** DONE — the claim FAILED verification in three places, recorded as D-06 (duplicate ids under concurrency), D-07 (silent unlogged mutations; stamp's property-only blind spot), and D-20 (mutators outside the ledger contract). Fixes landed for D-06/D-07; D-20 is documented honestly in CONNECTOR.md pending the parent's contract call.

### A-04 — Observation: ontology stage improvisation during the induction proof run (2026-11-17)
- During capability-swarm lane 3's induction proof run on bestof-smoke, the pre-existing ONTOLOGY stage agent (not the new induction stage) independently filed review-0001 (subject shape different from the induction contract's review-0002; choices keep-house-only / add-collaborates-property / defer) and wrote a scratch `draft-ontology-bestof-smoke.md` in the run's work dir. No graph harm (ReviewItem only; the canonical induction outputs are review-0002 + the .ttl draft), but the ontology stage reaching for induction-shaped work unprompted is worth watching: if it recurs, the ontology stage prompt should explicitly leave drafting to the induction stage.

---

## PRIOR AUDIT RE-VERIFICATION (correctness-audit-2026-11-16.md, 17:50 CST)

| Audit item | Then | Now (this hunt) |
|---|---|---|
| DRIFT 1 — Main double-stamped | Ontology ×2, duplicate class/property nodes | **FIXED upstream.** `scan-conflicts main` all-empty; Main OntologyClass 13 unique / OntologyProperty 51 (post request-7 expansion) at 00:07Z. |
| DRIFT 2 — 9 signals unconsumed | hook not yet live | **Superseded by D-01** — hook is live; consumption protocol is the defect. |
| Reverse gap — pipeline never calls supersede/similar/rename | open follow-up | Still true (grep-verified); prompt specifics in D-25. Not re-reported as new. |
| §8 UNRUNNABLE — Space request table | not readable outside artifact actions | Closed: Space reads via artifact actions this hunt (counts cross-checked against CLI/API). |
| MATCH items (census, embeddings, registry/systemd, CLI counts = API counts) | verified | Re-verified at 00:07Z: Main content census exact (SourceDocument 65 / Person 50 / Group 7; MENTIONS 116 / DESCRIBED_IN 56 / IN_JOHNNYS_NETWORK 55 / ABOUT 7 / ASSISTANT_OF 1); verify main passed=true. |

### D-33 — Closed category set rejects "question", the value the answering-loop storage contract mandates
- **Severity:** minor · **Surface:** CLI `CATEGORY_VALUES` + house ontology closed set · **Status:** FIXED (parent, centrally, 2026-11-17 — found by capability-swarm cross-lane traffic: lane 3's funnel run on bestof-probe failed verify's `category_values` gate with unexpected ["question"] because lane 2's fixture Question node carries category "question", exactly as the bot/hook storage contract specifies, while the closed set never admitted the value.)
- **Fix:** "question" added to CATEGORY_VALUES, a `_category_for` rule (Question → "question"), and the closed set in house-memory-graph.ttl + house-memory-graph.cypher (A7 comment + stamped mapsTo text). Proof: `relate categorize bestof-probe` residue [] and verify's category_values gate PASSED (inUse [document, group, person, question], unexpected []); Main verify still passed=true in full. Probe's remaining gate failures (embedding_uniformity / isolated_nodes / community_coverage) are cross-lane fixture debt on a scratch graph, not this defect.

## CLEARED — investigated, evidence says not a defect

- **C-01 — TEST decision-0001 `revertedAt: null`.** Known scar: its unmerge predates the tools lane's bookkeeping fix; deliberately not backdated. Not a new defect.
- **C-02 — Space count semantics.** Header counts exclude SpaceSignal exactly (getstatus 190 = 202 raw − 12 signals at 00:07Z); filterTypes chips include bookkeeping types by documented design; census-fallback chips behave as documented. Consistent — but see D-26/D-27 for the two real Space findings nearby.
- **C-03 — apply_props "silent key filtering".** Its SET semantics never remove unlisted properties; every call site passes controlled keys. No data-loss path found.
- **C-04 — Ollama double-serve race (embed-missing / relate-search).** A second `ollama serve` fails to bind and the poll loop succeeds via the first instance. Benign.
- **C-05 — Skill §12 staleness.** §12 is a dated snapshot by design; §13's bucket rule governs what is current. Not a defect. (Skill §9's communities spec — Leiden, hierarchy, pinned seed, run record — vs the CLI's flat label propagation IS a spec/tool divergence; it is recorded under D-04's alignment fix rather than as a separate defect.)
- **C-06 — TEST "29 nodes / 28 edges, zero content" expectations.** Every written instance is historical (pre-governance-lane). Live TEST at register close: see the counts note below — the graph is a working fixture graph with an append-only ledger, verify passed=true 20/20. No live document states 29/28 as current after the D-32 refresh.

## COUNTS NOTE (live, at register close — 2026-11-17T01:01Z)
- Main: **213 nodes / 307 edges** — verify passed=true, 20/20 gates (Main is being actively worked by the bot/hook lanes; counts move between reads).
- TEST: **80 nodes / 66 edges** — verify passed=true, 20/20 gates. TEST carries this hunt's ledger test entries (decision-0009 defect-probe; decisions 0010–0013, the merge/unmerge cycles) — append-only by design; all zz-* content fixtures were deleted.
- Probe graphs `defect-probe` (7477) and `defect-probe-2` (7478) were provisioned for this hunt's tests and are deprovisioned at close: services disabled, registry entries removed, store files in recoverable trash (ids `20261117-010153-0ee4c579ddae455cb10212a8b2c89874` and `20261117-010153-3d253a8d612e433185437b3113622a54`, expiring 2026-12-17). A third graph, `johnny-muse` (7479, 0 nodes, live), was provisioned concurrently by another lane during the hunt and is untouched; registry `nextPort` stands at 7480 (see D-10).

## TOTALS
- Blocker: 1 (D-01, OPEN)
- Major: 9 (D-02…D-10) — FIXED 9 (all: D-02, D-03, D-04, D-05, D-06, D-07, D-08, D-09, D-10), OPEN 0 [D-09/D-10 closed by capability swarm lane 6, 2026-11-17]
- Minor: 23 (D-11…D-33) — FIXED 18 (D-11, D-12, D-13, D-14, D-15, D-16, D-17, D-18, D-19, D-21, D-22, D-23, D-24, D-25, D-26, D-28, D-32, D-33), OPEN 5 (D-20, D-27, D-29, D-30, D-31)
- Addendum: A-01, A-02, A-03 all landed/tested. Cleared: C-01…C-06 (+ prior-audit table above).
