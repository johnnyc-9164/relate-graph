# Ontology Pack — custom.relate

The vocabularies the Relate graph system builds against: seven published
standards fetched from their publishers, plus our own house ontology in
Turtle and Cypher form. All files live in `ontologies/` next to this index.

Retrieval date for every fetched file: **2026-11-16**. Every fetched file
was parse-verified after download (RDF/Turtle files parse as valid RDF;
the schema.org file parses as valid JSON-LD).

## How the pipeline uses this pack

- The **ontology stage** of the `relate-pipeline` workflow loads the house
  files (`house-memory-graph.ttl` / `.cypher`) from this directory as the
  governing schema for the graph it is building: expected labels, types,
  property keys, and the mapping rules live there, not in stage prompts.
- The **verify stage** runs the `relate verify` CLI tool, whose 20
  deterministic gates are hand-coded equivalents of the read-only
  validation set in `house-memory-graph.cypher` (Part A) — the .cypher
  file is the spec, not something the stage executes — and treats
  unexpected labels/types, missing slugs, duplicate slugs, and missing
  categories as failures.
- The **standards files are reference + mapping targets only** — they are
  never imported into a live graph. The house ontology's `subClassOf` /
  `seeAlso` alignments point at terms in these files, so an agent (or a
  future export step) can resolve exactly what a house term claims to
  align with.
- The Cypher Part B seed stamps the house ontology into a graph as an
  `(:Ontology)` node set. It is **write Cypher and is never run
  automatically** — only when a pipeline job explicitly asks for stamping.
  It was not run when this pack was authored.

## Published standards (fetched)

| File | Vocabulary | Publisher / source URL (as fetched) | Format | Size |
|---|---|---|---|---|
| `ontologies/schema-org.jsonld` | schema.org | schema.org — `https://schema.org/version/latest/schemaorg-current-https.jsonld` | JSON-LD | 1,521,575 B |
| `ontologies/foaf.rdf` | FOAF 0.1 | xmlns.com — `http://xmlns.com/foaf/0.1/` (Accept: application/rdf+xml) | RDF/XML | 44,209 B |
| `ontologies/prov-o.ttl` | PROV-O | W3C — `https://www.w3.org/ns/prov-o` (Accept: text/turtle) | Turtle | 68,795 B |
| `ontologies/owl-time.ttl` | OWL-Time | W3C — `https://www.w3.org/2006/time` (Accept: text/turtle) — see note | Turtle | 101,486 B |
| `ontologies/skos.rdf` | SKOS | W3C — `https://www.w3.org/2009/08/skos-reference/skos.rdf` | RDF/XML | 28,966 B |
| `ontologies/dcterms.rdf` | Dublin Core Terms | DCMI — `https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.rdf` | RDF/XML | 128,199 B |
| `ontologies/org.ttl` | W3C ORG | W3C — `https://www.w3.org/ns/org` (Accept: text/turtle) | Turtle | 84,162 B |

Fetch notes (deviations from the first-guess URLs, for the record):

- **schema.org**: `https://schema.org/version/latest/schema.jsonld`
  returns 404. The publisher's current full-vocabulary JSON-LD under
  `/version/latest/` is `schemaorg-current-https.jsonld`; that is what is
  saved here — the **full file** (3,256 `@graph` entries), not an extract.
- **OWL-Time**: `https://www.w3.org/ns/time/` returns 403 (Access Denied)
  to this client, and the working group's old GitHub path
  (`w3c/sdw/gh-pages/time/rdf/time.ttl`) has been reorganized away (404).
  The file saved here is the same Turtle served by content negotiation
  from the ontology's own namespace document, `https://www.w3.org/2006/time`
  — its header declares `baseURI: http://www.w3.org/2006/time`, i.e. it is
  the OWL-Time ontology itself from W3C, not a mirror or an extract.

### What each standard governs in our stack

- **schema.org** (`schema-org.jsonld`) — the broad public-web alignment
  layer: `schema:Person`, `schema:legalName`, `schema:mentions`,
  `schema:about`. Used when house data ever needs to face the public web
  (exports, JSON-LD) and as the seeAlso target for common nouns.
- **FOAF** (`foaf.rdf`) — people and groups: house `Person` subclasses
  `foaf:Person`, house `Group` subclasses `foaf:Group`; `foaf:name`,
  `foaf:knows`, `foaf:member` are the alignment points for names,
  network edges, and membership.
- **PROV-O** (`prov-o.ttl`) — provenance: house `SourceDocument`
  subclasses `prov:Entity` (the graph is built *from* documents, by
  pipeline activities); `recordedAt`/`retiredAt` align to
  `prov:generatedAtTime`/`prov:invalidatedAtTime` (seeAlso — PROV-O
  speaks of entities, not graph assertions).
- **OWL-Time** (`owl-time.ttl`) — the temporal reference for the
  bitemporal convention: `validFrom`/`validTo` values are `time:Instant`s
  and the pair plays the role of a `time:ProperInterval`'s beginning/end,
  stored flat rather than reified (the house TTL says so explicitly).
- **SKOS** (`skos.rdf`) — the category system reference: house
  `category` values (person, group, people-page, groups-page,
  standing-file, index, profile) behave like a small SKOS concept
  scheme but are stored as plain strings today; SKOS is the documented
  upgrade path if categories ever become nodes.
- **Dublin Core Terms** (`dcterms.rdf`) — document metadata:
  `dcterms:title` for document names, `dcterms:subject` as the standard
  analogue of the `ABOUT` edge, `dcterms:BibliographicResource` as the
  near-miss seeAlso for `SourceDocument`.
- **W3C ORG** (`org.ttl`) — formal organization structure:
  `org:Organization` (seeAlso for the formal subset of house `Group`)
  and `org:memberOf` (the alignment target for the house `MEMBER_OF`
  type, defined but not yet asserted).

## House ontology (authored here)

| File | Format | Size | What it is |
|---|---|---|---|
| `ontologies/house-memory-graph.ttl` | Turtle (OWL/RDFS) | 39,755 B | The governing ontology for the memory graphs, namespace `https://ontology.muse.local/memory-graph#` (local, non-dereferenceable by design). Version 0.2.1: 14 classes, 25 object properties, 27 datatype properties. |
| `ontologies/house-memory-graph.cypher` | Cypher | 26,317 B | Practical twin: Part A = read-only validation query set for the verify stage (A1–A18); Part B = MERGE-based `(:Ontology)` stamp (write — never run automatically). |

House ontology contents (version 0.2.1; v0.2.0 was Main request 7,
Johnny: "It should be a bigger ontology then groups people places
it should be shit that matters" — +8 classes, +17 object
properties, +10 datatype properties, stamped to Main 2026-11-16;
v0.2.1 patch adds the `ReviewItem` class and the `SUPERSEDED_BY` /
`DECISION` properties the CLI already writes):

- **Classes** (graph labels): `Person`, `Group`, `Company`, `Project`,
  `Place`, `Event`, `Decision`, `Commitment`, `Bid`, `Account`,
  `SourceDocument`, `Question`, `SpaceSignal`, `ReviewItem`.
- **Object properties** (graph types): `MENTIONS`, `DESCRIBED_IN`,
  `IN_JOHNNYS_NETWORK`, `ABOUT`, `ASSISTANT_OF`, `MEMBER_OF`, `OWNS`,
  `OPERATES`, `WORKS_FOR`, `LEADS`, `WORKS_ON`, `CLIENT_OF`, `PART_OF`,
  `PLACED_BY`, `BID_FOR`, `LOCATED_IN`, `INVOLVES`, `DECIDED_BY`,
  `CONCERNS`, `REQUIRES`, `KNOWS`, `FAMILY_OF`, `HOLDS`,
  `SUPERSEDED_BY`, `DECISION`.
- **Datatype properties** (graph keys): `slug`, `name`, `legalName`,
  `alias`, `normalizedName`, `normalizedSlug`, `category`, `community`,
  `sourcePath`, `summary`, `status`, `amount`, `currency`, `dueDate`,
  `startDate`, `endDate`, `email`, `address`, `service`, `outcome`,
  `validFrom`, `validTo`, `recordedAt`, `retiredAt`, `embedding`,
  `embedding_dim`, `embedding_model`.
- **Honesty rules baked into the TTL comments**: `DESCRIBED_IN` is
  deliberately *not* declared `owl:inverseOf` `MENTIONS` (the pipeline
  asserts them independently — 116 vs 56 edges at first build);
  `Question` and `SpaceSignal` have **no** standard equivalent and say
  so; `embedding` asserts no `rdfs:range` because RDF has no float-list
  datatype; bitemporal values are OWL-Time instants stored flat, not
  reified interval nodes.

## Adding a new house ontology

1. **Author the Turtle first** in `ontologies/<name>.ttl`: pick a local
   namespace under `https://ontology.muse.local/`, give every class and
   property an `rdfs:label` + `rdfs:comment`, and align to the standards
   in this pack with `rdfs:subClassOf` / `rdfs:seeAlso` **only where the
   alignment genuinely holds** — where it doesn't, write that in the
   comment instead of forcing a mapping.
2. **Write the Cypher twin** `ontologies/<name>.cypher`: a read-only
   validation set the verify stage can run (label/type census, identity
   key presence + uniqueness, required-property coverage), and a
   MERGE-based `(:Ontology)` seed that converges on re-run. Header must
   state plainly that the seed is write Cypher, not to be run
   automatically.
3. **Parse-verify both files** before committing them (Turtle must parse
   as RDF; Cypher validation queries must run read-only against a
   scratch graph, never a live one).
4. **Register it here**: add rows to both tables in this index with the
   file name, namespace, and what it governs.
5. **Point the pipeline at it**: the ontology stage loads house files
   from this directory by file name — a new ontology takes effect when a
   job names it (or when the pipeline's default is deliberately
   changed); adding the file alone changes nothing in any live graph.
