# Relate Graph — Correctness Audit

- **Date:** 2026-11-16, ~17:50 CST (audit executed live, read-only)
- **Method:** direct Cypher against both Relate HTTP Query APIs (Main `:7475`, TEST `:7476`), the `custom.relate` CLI's read-only commands, the graph registry file, and `systemctl`. No writes of any kind were made.
- **Verdicts:** MATCH = observed equals the claim · DRIFT = system state has moved from / not yet reached the claimed state · FAIL = claim is wrong · UNRUNNABLE = no read-only path available to the auditor.

**Tally: 8 checks — 5 MATCH, 2 DRIFT, 0 FAIL, 1 UNRUNNABLE.**

---

## 1. MAIN census (content)

| Claim | Observed | Verdict |
|---|---|---|
| Person 50 | Person 50 | MATCH |
| SourceDocument 65 | SourceDocument 65 | MATCH |
| Group 7 | Group 7 | MATCH |
| MENTIONS 116 | MENTIONS 116 | MATCH |
| DESCRIBED_IN 56 | DESCRIBED_IN 56 | MATCH |
| IN_JOHNNYS_NETWORK 55 | IN_JOHNNYS_NETWORK 55 | MATCH |
| ABOUT 7 | ABOUT 7 | MATCH |
| ASSISTANT_OF 1 | ASSISTANT_OF 1 | MATCH |

Full label census (raw): SourceDocument 65, Person 50, OntologyProperty 26, SpaceSignal 9, OntologyClass 8, Group 7, Ontology 2 → **167 nodes**.
Full type census (raw): MENTIONS 116, DESCRIBED_IN 56, IN_JOHNNYS_NETWORK 55, DEFINES_PROPERTY 26, DEFINES_CLASS 8, ABOUT 7, ASSISTANT_OF 1 → **269 edges**.

Note: the last reported Main total was 165 nodes / 269 edges. Nodes are +2 with edges unchanged — the two extra nodes are SpaceSignals filed at 23:43:32Z and 23:45:31Z (requests 7 and 8). Content is untouched; the drift is bookkeeping only and fully explained.

## 2. Embeddings (Main)

| Claim | Observed | Verdict |
|---|---|---|
| All 122 content nodes embedded | 122 with `embedding`, 0 without | MATCH |
| Model embeddinggemma | distinct (model, dim) pairs = exactly one: (`embeddinggemma`, 768) | MATCH |
| 768-dim vectors | sampled vector length = 768 | MATCH |

## 3. Ontology stamps

### Main

| Claim | Observed | Verdict |
|---|---|---|
| Two ontologies stamped (FOAF + House) | Ontology nodes: "Friend of a Friend (FOAF) vocabulary", "House Memory Graph Ontology" | MATCH |
| Duplicates known: Person/Group/SourceDocument ×2 | OntologyClass = 8 nodes / 5 unique names: Person ×2, Group ×2, SourceDocument ×2, Question ×1, SpaceSignal ×1 | MATCH (presence confirmed) |
| Properties = 26 | OntologyProperty = 26 nodes / 24 unique names: **IN_JOHNNYS_NETWORK ×2, name ×2** | DRIFT — duplicate property names exist; earlier reports gave the count (26) without the duplication detail |
| DEFINES edges | DEFINES_CLASS 8, DEFINES_PROPERTY 26 | MATCH |

Independently cross-checked with `relate scan-conflicts main` (read-only), which returns the identical lists: duplicateClasses [Group, Person, SourceDocument], duplicateProperties [IN_JOHNNYS_NETWORK, name], duplicateSlugs [], contested [], singleValueViolations [].

**State verdict: DRIFT.** The name-keyed end state (one node per class/property name) is not yet in effect on Main. The `reconcile` tool now exists in the CLI, but Main still carries 3 duplicated class names and 2 duplicated property names at audit time.

### TEST

| Claim | Observed | Verdict |
|---|---|---|
| One clean House stamp, 29 nodes / 28 edges | Ontology 1 ("House Memory Graph Ontology"), OntologyClass 5 (Group, Person, Question, SourceDocument, SpaceSignal — each ×1), OntologyProperty 23 (no duplicates), DEFINES_CLASS 5, DEFINES_PROPERTY 23; totals 29 / 28; content nodes 0 | MATCH |

`relate verify test-graph` was also executed (read-only gate suite): **passed = true**, all 19 gates green.

## 4. SpaceSignals (Main)

| Claim | Observed | Verdict |
|---|---|---|
| 4 unconsumed builder-era signals remain | Present: chat refId 4 (23:29:20Z), dispatch refId 3 (23:29:31Z), dispatch refId 3 (23:30:07Z), chat refId 5 (23:30:59Z) — all consumed = false | MATCH |
| Signals are being consumed | **9 signals total (chat 2, dispatch 7); consumed = false on all 9** | DRIFT |

All unconsumed signals in Main at audit time:

| kind | refId | graphSlug | at (UTC) |
|---|---|---|---|
| chat | 4 | main | 2026-11-16T23:29:20.284Z |
| dispatch | 3 | main | 2026-11-16T23:29:31.821Z |
| dispatch | 3 | main | 2026-11-16T23:30:07.261Z |
| chat | 5 | main | 2026-11-16T23:30:59.929Z |
| dispatch | 5 | test-graph | 2026-11-16T23:33:41.994Z |
| dispatch | 6 | main | 2026-11-16T23:37:37.189Z |
| dispatch | 6 | test-graph | 2026-11-16T23:38:32.442Z |
| dispatch | 7 | main | 2026-11-16T23:43:32.837Z |
| dispatch | 8 | main | 2026-11-16T23:45:31.027Z |

Hazard confirmed live, not theoretical: refId "3" appears twice and refId "6" appears twice (once per graph). Any consumer keyed on refId alone will double-process; keying must be on node identity or (kind, refId, graphSlug, at). No signal has ever been consumed yet — the hook that consumes them is not live at audit time.

## 5. Bitemporal coverage (Main)

| Claim | Observed | Verdict |
|---|---|---|
| ~0 temporal data | validFrom: 0 nodes / 0 edges · validTo: 0 / 0 · recordedAt: 0 / 0 · retiredAt: 0 / 0 | MATCH |

No fact in Main carries any bitemporal property. The as-of views are therefore showing everything as unbounded, and retire-and-link has never been exercised against real data in this graph.

## 6. CLI inventory vs pipeline expectations

CLI under test: `~/workspace/custom-connectors/custom.relate/bin/relate`. Pipeline under test: `~/workspace/.jarvis/workflows/relate-pipeline.js` (grep for `relate <cmd>` references).

Commands the pipeline references, and their CLI status:

| Pipeline reference | Count in workflow | In CLI usage | Executed in this audit |
|---|---|---|---|
| write-batch | 5 | yes | no (write path — read-only audit) |
| verify | 4 | yes | **yes — test-graph, passed = true** |
| types | 2 | yes | via API equivalent |
| scan-conflicts | 2 | yes | **yes — main, results in §3** |
| reconcile | 2 | yes | no (write path) |
| labels | 2 | yes | via API equivalent |
| embed-missing | 2 | yes | no (write path) |
| categorize | 2 | yes | no (write path) |
| stamp | 1 | yes | no (write path) |
| query | 1 | yes | via direct API |
| normalize-scan | 1 | yes | no (not executed) |
| counts | 1 | yes | **yes — main 167/269, test-graph 29/28** |
| communities | 1 | yes | no (write path) |
| clean-scan | 1 | yes | no (not executed) |

(The one grep hit "relate ontology" is prose in the workflow's meta description — "custom.relate ontology pack" — not a command reference.)

| Claim | Observed | Verdict |
|---|---|---|
| Pipeline fails on missing CLI tools (`verify`, `embed-missing`, `communities` return "unknown command") | All 14 pipeline-referenced commands are present in the CLI usage; the three read-only ones spot-executed here (counts, scan-conflicts, verify) run and return correct JSON | MATCH — **the previously reported tool gap is closed as of this audit** |

Reverse gap (noted, not a failure): the CLI also ships `supersede`, `similar`, and `rename`, which the workflow never references (grep count 0 each). Retire-and-link inside the pipeline is still a scripted sequence rather than the typed `supersede` command.

Existence of the write-path commands is verified from the CLI's own usage listing only; this audit did not execute them, by design.

## 7. Registry vs reality

| Claim | Observed | Verdict |
|---|---|---|
| Registry: main → :7475, live | API answers on 7475; CLI counts 167/269 match direct API counts | MATCH |
| Registry: test-graph → :7476, live | API answers on 7476; CLI counts 29/28 match direct API counts | MATCH |
| nextPort 7477 | Registry field present, value 7477 | MATCH |
| relate-api.service active | `systemctl is-active` = active; is-enabled = enabled | MATCH |
| relate-graph@test-graph.service active | `systemctl is-active` = active; is-enabled = enabled | MATCH |

## 8. Space request table

| Claim | Observed | Verdict |
|---|---|---|
| Request states (ids 1–8) | Not read | **UNRUNNABLE** — the Space's request table is reachable only through the Space's artifact actions, which are not in this auditor's tool set; reading the artifact's database directly is prohibited. No states are asserted here. (Request existence is indirectly corroborated by the dispatch SpaceSignals in §4, which is all this audit claims.) |

---

## Summary

- **Most important discrepancy:** Main's ontology layer is still duplicated — 3 class names (Person, Group, SourceDocument) and 2 property names (IN_JOHNNYS_NETWORK, name) each held by two nodes — even though the deterministic `reconcile` tool now exists and runs. Until a reconcile actually executes against Main, the graph's governing schema is double-stamped and any duplicate-name verifier gate on Main will flag it.
- **Runner-up:** all 9 SpaceSignals in Main sit unconsumed, with live refId collisions (3 ×2, 6 ×2 across graphs). The signal bus is write-only until the hook goes live, and refId-only keying would double-process when it does.
- **Biggest positive correction:** the CLI tool gap that failed the pipeline's final dream smoke is closed — every command the pipeline references now exists, and the read-only ones provably execute with correct output.
- Content integrity is exact: census, embeddings (122/122, single 768-dim embeddinggemma space), and both services/registry all match their claims.
