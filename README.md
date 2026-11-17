# Relate Graph

**Your files go in. A knowledge graph comes out. Ask it questions, and every answer cites your own sources — or it tells you the answer is not in there.**

---

## The problem

Your knowledge is scattered across notes, docs, and records. AI chatbots will happily answer questions about them anyway — from memory, from vibes, from hallucination. You cannot ask your own files a question and trust what comes back.

## What this is

A personal knowledge-graph system in three parts:

1. **The graph** — [Relate by Neo4j](https://github.com/relatedb/relate), one local database per graph, holding people, companies, projects, documents, and the facts that connect them.
2. **The pipeline** — an agent workflow that reads your files and builds the graph. Agents do the judging; deterministic tools do the mechanics; an independent verifier grades every run before it counts as done.
3. **The app** — a web UI to explore the graph visually, chat with it, upload files, and dispatch work to the pipeline.

```
 your files ──> pipeline (agents + typed tools) ──> knowledge graph
                                                          │
              app: explore / chat / dispatch <────────────┘
                                                          │
              answers grounded in the graph, sources named
```

## The rules that make it trustworthy

- **Every fact carries its source.** Each connection in the graph stores a one-sentence fact, in plain words, naming the things it connects and where it came from.
- **No vibes.** Mechanical work — chunking, writing, categorizing, embedding, verifying — is fixed code with JSON in and JSON out. AI reasoning is spent only where judgment is real: extraction, summaries, and genuinely ambiguous calls. Anything uncertain goes to a review queue for a human instead of being guessed.
- **A verifier grades every run.** 20 fixed checks (duplicate identities, missing sources, broken embeddings, contradictions, and more) run after every job. A run that fails is reported as failed.
- **Answers are grounded or honest.** The chat answers only from what is in the graph and names its sources. If the graph does not contain the answer, it says exactly that: "that's not in this graph."
- **It grades itself.** An eval harness runs the same questions through two different retrieval strategies and scores them with executed checks. No AI judging AI.

## Proof, not promises

Live results from the running system (Nov 16–17, 2026):

- One pipeline run turned **65 source documents** (profile, notes, people and group pages) into a graph of **122 nodes / 235 edges**, fully embedded and verified. The main graph now stands at **217 nodes / 307 edges**.
- Answer eval: **13 of 14 questions passed (92.9%)** under both retrieval strategies — and the one failure is written down, not hidden (see `engine/bin/relate-eval`).
- A two-day adversarial defect hunt logged **32 defects; 27 are fixed with evidence**, the other 5 are documented as open (`docs/defect-register-2026-11-16.md`).
- **Self-healing infrastructure:** the host machine's system config is wiped whenever the machine is replaced, which used to kill every graph service. Now a watchdog checks every graph every 15 seconds and rebuilds the services from the copies in `ops/`. In a live test we deleted every service on purpose — **the whole stack was back in about 10 seconds, no human and no agent involved.**

## How the pipeline works

15 stages, in order:

**intake → ontology → induction → extraction → import → categorizing → normalization → cleaning → summarize → embeddings → communities → candidates → query → verify → writeback**

Plain version: figure out what the job is, agree on the vocabulary, pull the facts out of the sources, write them in atomically, tidy identities, summarize, embed, find communities, then prove the result is correct and write the outcome back to the app. The full method is in `playbook/SKILL.md`.

## Repo map

| Folder | What is in it |
|---|---|
| `engine/` | The typed command-line tools (`relate`, `relate-search`, `relate-eval`), the ontology pack, and the connector doc. This is the deterministic layer everything else stands on. |
| `pipeline/` | The 15-stage agent workflow that builds and verifies graphs. |
| `app/` | The web app: graph explorer, chat, uploads, dispatch queue, governance panel (TypeScript / React). |
| `ops/` | The stuff that keeps it alive: provisioning script, service units, the self-heal script, the watchdog hooks, and the queue bot's instructions. |
| `playbook/` | The operating manual the agents follow — the method, the gates, and what is proven vs. planned. |
| `docs/` | The research: teardowns of Utopia, Graphiti, Cognee, and NVIDIA's GraphRAG work, plus the audits and the defect register. |

## Try the tools

```bash
engine/bin/relate status            # every graph, live counts
engine/bin/relate counts main       # nodes and edges
engine/bin/relate verify main       # the 20-gate check, pass or fail
engine/bin/relate-search main "who runs the painting company?"
engine/bin/relate-eval main         # grade the answering path
```

## Built with

- **Relate by Neo4j** — graph store, Cypher, native vector + fulltext indexes, managed transactions
- **Ollama + EmbeddingGemma 2** — local embeddings (768-dim), nothing leaves the machine
- **Muse agents** — the pipeline, a queue bot that works the app every 2 minutes, and watchdog hooks
- **TypeScript / React** — the app
- Designs studied and adapted from **Utopia, Graphiti, Cognee, and NVIDIA** — the teardowns in `docs/` show exactly what was taken from each and why

## What is NOT in this repo

- **The graph data.** The databases hold personal files; they stay on the machine. Only the code, the method, and the research are published.
- **Credentials.** There are none by design — every service binds to loopback only.
- A few absolute paths from the live install remain in the scripts. This is a snapshot of a working system, not a polished installer.

## Status

Built in two days (Nov 16–17, 2026) and running live right now: 5 graphs served, a bot working the queues, and infrastructure that heals itself. This repo is that system.
