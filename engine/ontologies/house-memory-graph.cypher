// =====================================================================
// House Memory Graph — Cypher twin of house-memory-graph.ttl
// Connector: custom.relate · Pack: ontologies/ · Version 0.2.1
//
// SUPERSEDES 0.1.0. Changes in v0.2.0: +8 classes (Company, Project,
// Place, Event, Decision, Commitment, Bid, Account), +17 object
// properties, +10 datatype properties; ABOUT domain corrected
// (Question | SourceDocument — the standing files ARE about
// Johnny); MEMBER_OF range widened to Group | Company; category
// closed set extended with company, project, place, event,
// decision, commitment, bid, account.
//
// v0.2.1 (patch, Main request 7 completion): +1 class (ReviewItem)
// and +2 object properties (SUPERSEDED_BY, DECISION) — terms the
// CLI already writes but v0.2.0 left out of the ontology. Category
// set gains review-item.
//
// PART A is a read-only validation query set for the relate-pipeline
// verify stage: run each query against a graph's Relate HTTP API
// (POST <apiBase>/db/neo4j/query/v2) and compare against the expected
// shape noted above it. PART B is a MERGE-based seed that stamps this
// ontology into a graph as an (:Ontology) node set.
//
// *** PART B IS WRITE CYPHER. DO NOT RUN IT against any live graph
// *** unless a pipeline job explicitly calls for ontology stamping.
// *** (The 0.2.0 stamp on Main was applied by the typed CLI tool
// *** `relate stamp main house`, which parses the .ttl — Part B is
// *** the same stamp in hand-runnable form, for audit and recovery.)
// =====================================================================


// =====================================================================
// PART A — VALIDATION QUERIES (read-only)
// =====================================================================

// A1. Total shape. Expect: nodes/edges > 0 on a built graph;
//     Main after the 0.2.0 stamp (2026-11-16): 199 nodes / 304 edges
//     (before: 164 / 269; +35 ontology term nodes, +35 DEFINES edges).
MATCH (n) RETURN count(n) AS nodes;
MATCH ()-[r]->() RETURN count(r) AS edges;

// A2. Label counts. Expect only house labels on a conforming graph:
//     Person, Group, Company, Project, Place, Event, Decision,
//     Commitment, Bid, Account, SourceDocument (+ Question,
//     SpaceSignal, ReviewItem, Ontology*). Any other label is
//     ontology drift.
MATCH (n) UNWIND labels(n) AS label
RETURN label, count(*) AS nodes ORDER BY label;

// A3. Relationship type counts. Expect only house types:
//     MENTIONS, DESCRIBED_IN, IN_JOHNNYS_NETWORK, ABOUT,
//     ASSISTANT_OF, MEMBER_OF, OWNS, OPERATES, WORKS_FOR, LEADS,
//     WORKS_ON, CLIENT_OF, PART_OF, PLACED_BY, BID_FOR, LOCATED_IN,
//     INVOLVES, DECIDED_BY, CONCERNS, REQUIRES, KNOWS, FAMILY_OF,
//     HOLDS, SUPERSEDED_BY, DECISION (+ DEFINES_CLASS /
//     DEFINES_PROPERTY after Part B stamping, + SIMILAR_TO only
//     when a job explicitly asked for a similarity pass — its
//     presence otherwise is a violation).
MATCH ()-[r]->()
RETURN type(r) AS type, count(*) AS edges ORDER BY type;

// A4. Nodes missing slug. Expect: 0 rows. slug is THE identity key;
//     a node without one cannot be merged, deduped, or looked up.
MATCH (n) WHERE n.slug IS NULL
RETURN labels(n) AS labels, count(*) AS missing
ORDER BY labels;

// A5. Duplicate slugs. Expect: 0 rows. Two nodes sharing a slug are
//     an un-merged duplicate (identity collision).
MATCH (n) WHERE n.slug IS NOT NULL
WITH n.slug AS slug, count(*) AS c WHERE c > 1
RETURN slug, c ORDER BY slug;

// A6. Nodes missing category. Expect: 0 among content labels
//     (Person, Group, Company, Project, Place, Event, Decision,
//     Commitment, Bid, Account, SourceDocument). Control labels
//     (Question, SpaceSignal, ReviewItem, Ontology*) are exempt
//     by design.
MATCH (n) WHERE n.category IS NULL
  AND (n:Person OR n:Group OR n:Company OR n:Project OR n:Place
       OR n:Event OR n:Decision OR n:Commitment OR n:Bid
       OR n:Account OR n:SourceDocument)
RETURN labels(n) AS labels, n.slug AS slug
ORDER BY labels, slug;

// A7. Category values in use. Expect a subset of the closed set:
//     person, group, company, project, place, event, decision,
//     commitment, bid, account, review-item, people-page,
//     groups-page, standing-file, index, profile, document,
//     question.
//     Anything else is categorizing-stage drift.
MATCH (n) WHERE n.category IS NOT NULL
RETURN n.category AS category, count(*) AS nodes
ORDER BY category;

// A8. Normalization consistency. Expect: 0 rows. normalizedSlug
//     must exist and equal slug on every node.
MATCH (n)
WHERE n.normalizedSlug IS NULL OR n.normalizedSlug <> n.slug
RETURN n.slug AS slug, n.normalizedSlug AS normalizedSlug
LIMIT 50;

// A9. Embedding coverage. Expect on a fully embedded graph:
//     without_embedding = 0, and a single (embedding_dim,
//     embedding_model) pair across all embedded nodes — mixed
//     pairs mean two vector spaces are being compared, which is
//     silently wrong retrieval.
MATCH (n)
RETURN count(n) AS total,
       sum(CASE WHEN n.embedding IS NULL THEN 1 ELSE 0 END)
         AS without_embedding;
MATCH (n) WHERE n.embedding IS NOT NULL
RETURN n.embedding_dim AS embedding_dim,
       n.embedding_model AS embedding_model,
       count(*) AS nodes
ORDER BY nodes DESC;

// A10. Bitemporal coverage. Informational, not pass/fail: how much
//      of the graph carries valid-time / transaction-time stamps.
MATCH (n)
RETURN sum(CASE WHEN n.validFrom  IS NOT NULL THEN 1 ELSE 0 END)
         AS with_validFrom,
       sum(CASE WHEN n.validTo    IS NOT NULL THEN 1 ELSE 0 END)
         AS with_validTo,
       sum(CASE WHEN n.recordedAt IS NOT NULL THEN 1 ELSE 0 END)
         AS with_recordedAt,
       sum(CASE WHEN n.retiredAt  IS NOT NULL THEN 1 ELSE 0 END)
         AS with_retiredAt;

// A11. Bitemporal sanity. Expect: 0 rows. A closed interval must
//      not end before it starts, on either axis.
MATCH (n)
WHERE (n.validFrom IS NOT NULL AND n.validTo IS NOT NULL
       AND n.validTo < n.validFrom)
   OR (n.recordedAt IS NOT NULL AND n.retiredAt IS NOT NULL
       AND n.retiredAt < n.recordedAt)
RETURN n.slug AS slug, labels(n) AS labels;

// A12. SourceDocument provenance. Expect: 0 rows missing, 0 rows
//      duplicated. Every SourceDocument must anchor to exactly
//      one file on disk via sourcePath.
MATCH (d:SourceDocument) WHERE d.sourcePath IS NULL
RETURN d.slug AS slug;
MATCH (d:SourceDocument) WHERE d.sourcePath IS NOT NULL
WITH d.sourcePath AS sourcePath, count(*) AS c WHERE c > 1
RETURN sourcePath, c;

// A13. Summary gap (known, non-blocking). Report the count; at
//      Main's first build 58 of 65 SourceDocuments had no summary.
MATCH (d:SourceDocument)
RETURN count(d) AS documents,
       sum(CASE WHEN d.summary IS NULL THEN 1 ELSE 0 END)
         AS without_summary;

// A14. Isolated nodes. Expect: 0 on a built graph (the cleaning
//      stage flags these; SourceDocuments with no edges are the
//      usual suspects after a partial import).
MATCH (n) WHERE NOT (n)--()
RETURN labels(n) AS labels, n.slug AS slug
ORDER BY labels, slug;

// A15. Community coverage. Expect: every content node carries a
//      community once the communities stage has run; report the
//      distribution.
MATCH (n) WHERE n.community IS NOT NULL
RETURN n.community AS community, count(*) AS nodes
ORDER BY nodes DESC;
MATCH (n) WHERE n.community IS NULL
  AND (n:Person OR n:Group OR n:Company OR n:Project OR n:Place
       OR n:Event OR n:Decision OR n:Commitment OR n:Bid
       OR n:Account OR n:SourceDocument)
RETURN count(n) AS content_nodes_without_community;

// A16. Control-plane census. Questions and unconsumed signals:
//      signals with consumed = false (or no consumed flag) are
//      events the agent loop has not picked up yet.
MATCH (q:Question) RETURN count(q) AS questions;
MATCH (s:SpaceSignal)
WHERE s.consumed IS NULL OR s.consumed = false
RETURN s.kind AS kind, count(*) AS unconsumed
ORDER BY kind;

// A17. New-class integrity (v0.2.0). Expect: 0 rows in each.
//      Every Bid has exactly one bidder and one target; every
//      Decision has exactly one decider; every Commitment has
//      exactly one owner. Orphans mean an import wrote a node
//      without its mandatory edge.
MATCH (b:Bid)
WHERE size([(b)-[:PLACED_BY]->(:Company) | 1]) <> 1
RETURN b.slug AS bid, 'missing-or-multiple PLACED_BY' AS problem;
MATCH (b:Bid)
WHERE size([(b)-[:BID_FOR]->(t) WHERE t:Project OR t:Place | 1]) <> 1
RETURN b.slug AS bid, 'missing-or-multiple BID_FOR' AS problem;
MATCH (d:Decision)
WHERE size([(d)-[:DECIDED_BY]->(:Person) | 1]) <> 1
RETURN d.slug AS decision, 'missing-or-multiple DECIDED_BY' AS problem;
MATCH (c:Commitment)
WHERE size([(c)-[:REQUIRES]->(o) WHERE o:Person OR o:Company | 1]) <> 1
RETURN c.slug AS commitment, 'missing-or-multiple REQUIRES' AS problem;

// A18. Ontology stamp check. Expect: the House Ontology node at
//      version 0.2.1, 14 classes, 52 properties (25 object +
//      27 datatype). The FOAF stamp may add its own terms on top
//      (handle, etc.) — count the House-defined set specifically.
MATCH (o:Ontology {slug: 'house-memory-graph'})
RETURN o.version AS house_version, o.stampedAt AS stampedAt;
MATCH (o:Ontology {slug: 'house-memory-graph'})-[:DEFINES_CLASS]->(c:OntologyClass)
RETURN count(c) AS house_classes;
MATCH (o:Ontology {slug: 'house-memory-graph'})-[:DEFINES_PROPERTY]->(p:OntologyProperty)
RETURN p.kind AS kind, count(*) AS properties ORDER BY kind;


// =====================================================================
// PART B — ONTOLOGY SEED (WRITE — DO NOT RUN unless a job asks)
// ---------------------------------------------------------------------
// Stamps this ontology into a graph as an (:Ontology) node plus
// (:OntologyClass) / (:OntologyProperty) descriptor nodes, linked
// by DEFINES_CLASS / DEFINES_PROPERTY. Fully MERGE-based: safe to
// re-run, it converges the stamp to this file's version. Slugs
// follow the CLI stamper's convention (class-<kebab>,
// prop-<kebab>); MERGE is by slug here, by name in the CLI — the
// two converge on the same term set. The stamp is documentation
// inside the graph — the .ttl in this pack stays the source of
// truth.
// =====================================================================

MERGE (o:Ontology {slug: 'house-memory-graph'})
SET o.name = 'House Memory Graph Ontology',
    o.version = '0.2.1',
    o.namespace = 'https://ontology.muse.local/memory-graph#',
    o.sourceFile = 'custom-connectors/custom.relate/ontologies/house-memory-graph.ttl',
    o.stampedAt = '2026-11-16';

// --- Classes -------------------------------------------------------
MERGE (c:OntologyClass {slug: 'class-person'})
SET c.name = 'Person', c.graphLabel = 'Person',
    c.mapsTo = 'foaf:Person (subClassOf), schema:Person (subClassOf)';
MERGE (c:OntologyClass {slug: 'class-group'})
SET c.name = 'Group', c.graphLabel = 'Group',
    c.mapsTo = 'foaf:Group (subClassOf); org:Organization, schema:Organization (seeAlso — house Group is broader; formal orgs are now Company)';
MERGE (c:OntologyClass {slug: 'class-company'})
SET c.name = 'Company', c.graphLabel = 'Company',
    c.mapsTo = 'org:Organization, schema:Organization, foaf:Organization (subClassOf all three)';
MERGE (c:OntologyClass {slug: 'class-project'})
SET c.name = 'Project', c.graphLabel = 'Project',
    c.mapsTo = 'schema:Project (subClassOf)';
MERGE (c:OntologyClass {slug: 'class-place'})
SET c.name = 'Place', c.graphLabel = 'Place',
    c.mapsTo = 'schema:Place (subClassOf)';
MERGE (c:OntologyClass {slug: 'class-event'})
SET c.name = 'Event', c.graphLabel = 'Event',
    c.mapsTo = 'schema:Event (subClassOf); time:TemporalEntity (seeAlso)';
MERGE (c:OntologyClass {slug: 'class-decision'})
SET c.name = 'Decision', c.graphLabel = 'Decision',
    c.mapsTo = 'none — house-only; prov:Activity is seeAlso with a different meaning';
MERGE (c:OntologyClass {slug: 'class-commitment'})
SET c.name = 'Commitment', c.graphLabel = 'Commitment',
    c.mapsTo = 'none — house-only; schema:Action is seeAlso with a different meaning';
MERGE (c:OntologyClass {slug: 'class-bid'})
SET c.name = 'Bid', c.graphLabel = 'Bid',
    c.mapsTo = 'schema:Offer (seeAlso only — a bid is an offer of services, not goods)';
MERGE (c:OntologyClass {slug: 'class-account'})
SET c.name = 'Account', c.graphLabel = 'Account',
    c.mapsTo = 'none — house-only; credential values are never in the graph';
MERGE (c:OntologyClass {slug: 'class-source-document'})
SET c.name = 'SourceDocument', c.graphLabel = 'SourceDocument',
    c.mapsTo = 'prov:Entity (subClassOf); dcterms:BibliographicResource (seeAlso)';
MERGE (c:OntologyClass {slug: 'class-question'})
SET c.name = 'Question', c.graphLabel = 'Question',
    c.mapsTo = 'none — house-only; schema:Question is seeAlso with a different meaning';
MERGE (c:OntologyClass {slug: 'class-space-signal'})
SET c.name = 'SpaceSignal', c.graphLabel = 'SpaceSignal',
    c.mapsTo = 'none — operational control-plane node, no standard equivalent';
MERGE (c:OntologyClass {slug: 'class-review-item'})
SET c.name = 'ReviewItem', c.graphLabel = 'ReviewItem',
    c.mapsTo = 'none — house-only control-plane node, like SpaceSignal';

MATCH (o:Ontology {slug: 'house-memory-graph'})
MATCH (c:OntologyClass)
WHERE c.slug STARTS WITH 'class-'
MERGE (o)-[:DEFINES_CLASS]->(c);

// --- Object properties (relationship types) ------------------------
MERGE (p:OntologyProperty {slug: 'prop-mentions'})
SET p.name = 'MENTIONS', p.kind = 'object', p.graphType = 'MENTIONS',
    p.fromLabel = 'SourceDocument', p.toLabel = 'Person|Group|Company|Project|Place|Event|Decision|Commitment|Bid|Account|SourceDocument',
    p.mapsTo = 'schema:mentions (seeAlso)';
MERGE (p:OntologyProperty {slug: 'prop-described-in'})
SET p.name = 'DESCRIBED_IN', p.kind = 'object', p.graphType = 'DESCRIBED_IN',
    p.fromLabel = 'Person|Group|Company|Project|Place|Event|Decision|Commitment|Bid|Account', p.toLabel = 'SourceDocument',
    p.mapsTo = 'none — deliberately NOT owl:inverseOf MENTIONS (asserted independently, different semantics)';
MERGE (p:OntologyProperty {slug: 'prop-in-johnnys-network'})
SET p.name = 'IN_JOHNNYS_NETWORK', p.kind = 'object', p.graphType = 'IN_JOHNNYS_NETWORK',
    p.fromLabel = 'Person|Group|Company', p.toLabel = 'Person',
    p.mapsTo = 'foaf:knows (seeAlso only — hub assertion, not acquaintance)';
MERGE (p:OntologyProperty {slug: 'prop-about'})
SET p.name = 'ABOUT', p.kind = 'object', p.graphType = 'ABOUT',
    p.fromLabel = 'Question|SourceDocument', p.toLabel = 'Person|Group|Company|Project|Place|Event|Decision|Commitment|Bid|Account|SourceDocument',
    p.mapsTo = 'dcterms:subject, schema:about (seeAlso); Question-ABOUT is lead-grade retrieval evidence, SourceDocument-ABOUT is a document-subject assertion (v0.2.0 correction)';
MERGE (p:OntologyProperty {slug: 'prop-assistant-of'})
SET p.name = 'ASSISTANT_OF', p.kind = 'object', p.graphType = 'ASSISTANT_OF',
    p.fromLabel = 'Person', p.toLabel = 'Person',
    p.mapsTo = 'none — house-only';
MERGE (p:OntologyProperty {slug: 'prop-member-of'})
SET p.name = 'MEMBER_OF', p.kind = 'object', p.graphType = 'MEMBER_OF',
    p.fromLabel = 'Person', p.toLabel = 'Group|Company',
    p.mapsTo = 'org:memberOf, foaf:member (seeAlso); defined, not yet asserted in Main';
MERGE (p:OntologyProperty {slug: 'prop-owns'})
SET p.name = 'OWNS', p.kind = 'object', p.graphType = 'OWNS',
    p.fromLabel = 'Person', p.toLabel = 'Company',
    p.mapsTo = 'schema:owns (seeAlso); ownership is a legal fact — evidence only';
MERGE (p:OntologyProperty {slug: 'prop-operates'})
SET p.name = 'OPERATES', p.kind = 'object', p.graphType = 'OPERATES',
    p.fromLabel = 'Person', p.toLabel = 'Company',
    p.mapsTo = 'none — house-only; owning and operating are different facts';
MERGE (p:OntologyProperty {slug: 'prop-works-for'})
SET p.name = 'WORKS_FOR', p.kind = 'object', p.graphType = 'WORKS_FOR',
    p.fromLabel = 'Person', p.toLabel = 'Company',
    p.mapsTo = 'schema:worksFor (seeAlso); org:memberOf (seeAlso); title goes on the edge as a role qualifier';
MERGE (p:OntologyProperty {slug: 'prop-leads'})
SET p.name = 'LEADS', p.kind = 'object', p.graphType = 'LEADS',
    p.fromLabel = 'Person', p.toLabel = 'Project',
    p.mapsTo = 'none — house-only';
MERGE (p:OntologyProperty {slug: 'prop-works-on'})
SET p.name = 'WORKS_ON', p.kind = 'object', p.graphType = 'WORKS_ON',
    p.fromLabel = 'Person', p.toLabel = 'Project',
    p.mapsTo = 'none — house-only; about the project, not the employer';
MERGE (p:OntologyProperty {slug: 'prop-client-of'})
SET p.name = 'CLIENT_OF', p.kind = 'object', p.graphType = 'CLIENT_OF',
    p.fromLabel = 'Person|Company', p.toLabel = 'Company',
    p.mapsTo = 'schema:provider (seeAlso, reverse direction)';
MERGE (p:OntologyProperty {slug: 'prop-part-of'})
SET p.name = 'PART_OF', p.kind = 'object', p.graphType = 'PART_OF',
    p.fromLabel = 'Project|Group|Company', p.toLabel = 'Company|Project',
    p.mapsTo = 'schema:isPartOf, org:subOrganizationOf (seeAlso)';
MERGE (p:OntologyProperty {slug: 'prop-placed-by'})
SET p.name = 'PLACED_BY', p.kind = 'object', p.graphType = 'PLACED_BY',
    p.fromLabel = 'Bid', p.toLabel = 'Company',
    p.mapsTo = 'house — every Bid needs exactly one PLACED_BY (gate A17)';
MERGE (p:OntologyProperty {slug: 'prop-bid-for'})
SET p.name = 'BID_FOR', p.kind = 'object', p.graphType = 'BID_FOR',
    p.fromLabel = 'Bid', p.toLabel = 'Project|Place',
    p.mapsTo = 'house — every Bid needs exactly one BID_FOR (gate A17)';
MERGE (p:OntologyProperty {slug: 'prop-located-in'})
SET p.name = 'LOCATED_IN', p.kind = 'object', p.graphType = 'LOCATED_IN',
    p.fromLabel = 'Company|Project|Event|Bid', p.toLabel = 'Place',
    p.mapsTo = 'schema:location (seeAlso)';
MERGE (p:OntologyProperty {slug: 'prop-involves'})
SET p.name = 'INVOLVES', p.kind = 'object', p.graphType = 'INVOLVES',
    p.fromLabel = 'Event', p.toLabel = 'Person|Company|Project',
    p.mapsTo = 'schema:about (seeAlso)';
MERGE (p:OntologyProperty {slug: 'prop-decided-by'})
SET p.name = 'DECIDED_BY', p.kind = 'object', p.graphType = 'DECIDED_BY',
    p.fromLabel = 'Decision', p.toLabel = 'Person',
    p.mapsTo = 'house — every Decision needs exactly one DECIDED_BY (gate A17)';
MERGE (p:OntologyProperty {slug: 'prop-concerns'})
SET p.name = 'CONCERNS', p.kind = 'object', p.graphType = 'CONCERNS',
    p.fromLabel = 'Decision', p.toLabel = 'Person|Company|Project|Place|Bid|Commitment',
    p.mapsTo = 'dcterms:subject (seeAlso)';
MERGE (p:OntologyProperty {slug: 'prop-requires'})
SET p.name = 'REQUIRES', p.kind = 'object', p.graphType = 'REQUIRES',
    p.fromLabel = 'Commitment', p.toLabel = 'Person|Company',
    p.mapsTo = 'house — every Commitment needs exactly one REQUIRES (gate A17)';
MERGE (p:OntologyProperty {slug: 'prop-knows'})
SET p.name = 'KNOWS', p.kind = 'object', p.graphType = 'KNOWS',
    p.fromLabel = 'Person', p.toLabel = 'Person',
    p.mapsTo = 'foaf:knows (subPropertyOf)';
MERGE (p:OntologyProperty {slug: 'prop-family-of'})
SET p.name = 'FAMILY_OF', p.kind = 'object', p.graphType = 'FAMILY_OF',
    p.fromLabel = 'Person', p.toLabel = 'Person',
    p.mapsTo = 'schema:relatedTo (seeAlso); family is stated by sources, never inferred from a surname';
MERGE (p:OntologyProperty {slug: 'prop-holds'})
SET p.name = 'HOLDS', p.kind = 'object', p.graphType = 'HOLDS',
    p.fromLabel = 'Person|Company', p.toLabel = 'Account',
    p.mapsTo = 'house — existence + holder only; credential values are never in the graph';
MERGE (p:OntologyProperty {slug: 'prop-superseded-by'})
SET p.name = 'SUPERSEDED_BY', p.kind = 'object', p.graphType = 'SUPERSEDED_BY',
    p.fromLabel = 'Person|Group|Company|Project|Place|Event|Decision|Commitment|Bid|Account|SourceDocument', p.toLabel = 'Person|Group|Company|Project|Place|Event|Decision|Commitment|Bid|Account|SourceDocument',
    p.mapsTo = 'prov:wasRevisionOf (seeAlso — stated from the old version side; new wasRevisionOf old)';
MERGE (p:OntologyProperty {slug: 'prop-decision'})
SET p.name = 'DECISION', p.kind = 'object', p.graphType = 'DECISION',
    p.fromLabel = 'Decision', p.toLabel = 'Person|Group|Company|Project|Place|Event|Decision|Commitment|Bid|Account|SourceDocument|Question|SpaceSignal|ReviewItem',
    p.mapsTo = 'house — Decision ledger node to its subject';

MATCH (o:Ontology {slug: 'house-memory-graph'})
MATCH (p:OntologyProperty) WHERE p.kind = 'object'
MERGE (o)-[:DEFINES_PROPERTY]->(p);

// --- Datatype properties (keys) ------------------------------------
MERGE (p:OntologyProperty {slug: 'prop-slug'})
SET p.name = 'slug', p.kind = 'datatype', p.graphKey = 'slug',
    p.mapsTo = 'identity key — required on every node';
MERGE (p:OntologyProperty {slug: 'prop-name'})
SET p.name = 'name', p.kind = 'datatype', p.graphKey = 'name',
    p.mapsTo = 'foaf:name, schema:name, dcterms:title (seeAlso)';
MERGE (p:OntologyProperty {slug: 'prop-legal-name'})
SET p.name = 'legalName', p.kind = 'datatype', p.graphKey = 'legalName',
    p.mapsTo = 'schema:legalName (seeAlso); evidence-only';
MERGE (p:OntologyProperty {slug: 'prop-alias'})
SET p.name = 'alias', p.kind = 'datatype', p.graphKey = 'alias',
    p.mapsTo = 'house — explicit alternate name from sources';
MERGE (p:OntologyProperty {slug: 'prop-normalized-name'})
SET p.name = 'normalizedName', p.kind = 'datatype', p.graphKey = 'normalizedName',
    p.mapsTo = 'house — normalization audit trail';
MERGE (p:OntologyProperty {slug: 'prop-normalized-slug'})
SET p.name = 'normalizedSlug', p.kind = 'datatype', p.graphKey = 'normalizedSlug',
    p.mapsTo = 'house — must equal slug (validation A8)';
MERGE (p:OntologyProperty {slug: 'prop-category'})
SET p.name = 'category', p.kind = 'datatype', p.graphKey = 'category',
    p.mapsTo = 'skos:Concept (seeAlso); closed set v0.2.1: person, group, company, project, place, event, decision, commitment, bid, account, review-item, people-page, groups-page, standing-file, index, profile, document, question';
MERGE (p:OntologyProperty {slug: 'prop-community'})
SET p.name = 'community', p.kind = 'datatype', p.graphKey = 'community',
    p.mapsTo = 'house — structural community id, never an identity claim';
MERGE (p:OntologyProperty {slug: 'prop-source-path'})
SET p.name = 'sourcePath', p.kind = 'datatype', p.graphKey = 'sourcePath',
    p.mapsTo = 'prov:wasDerivedFrom (seeAlso, as data); SourceDocument only, unique per label';
MERGE (p:OntologyProperty {slug: 'prop-summary'})
SET p.name = 'summary', p.kind = 'datatype', p.graphKey = 'summary',
    p.mapsTo = 'house — SourceDocument only; known-gappy, non-blocking';
MERGE (p:OntologyProperty {slug: 'prop-status'})
SET p.name = 'status', p.kind = 'datatype', p.graphKey = 'status',
    p.mapsTo = 'house — Bid/Commitment/Project/Event lifecycle; never inferred from silence';
MERGE (p:OntologyProperty {slug: 'prop-amount'})
SET p.name = 'amount', p.kind = 'datatype', p.graphKey = 'amount',
    p.mapsTo = 'house — Bid money value (number) in hmg:currency';
MERGE (p:OntologyProperty {slug: 'prop-currency'})
SET p.name = 'currency', p.kind = 'datatype', p.graphKey = 'currency',
    p.mapsTo = 'schema:currency (seeAlso); ISO 4217 code, conventionally USD';
MERGE (p:OntologyProperty {slug: 'prop-due-date'})
SET p.name = 'dueDate', p.kind = 'datatype', p.graphKey = 'dueDate',
    p.mapsTo = 'time:Instant (seeAlso); Commitment/Bid/Event deadline — never invented';
MERGE (p:OntologyProperty {slug: 'prop-start-date'})
SET p.name = 'startDate', p.kind = 'datatype', p.graphKey = 'startDate',
    p.mapsTo = 'time:Instant / time:hasBeginning (seeAlso); Event/Project start';
MERGE (p:OntologyProperty {slug: 'prop-end-date'})
SET p.name = 'endDate', p.kind = 'datatype', p.graphKey = 'endDate',
    p.mapsTo = 'time:Instant / time:hasEnd (seeAlso); Event/Project end, absent = ongoing';
MERGE (p:OntologyProperty {slug: 'prop-email'})
SET p.name = 'email', p.kind = 'datatype', p.graphKey = 'email',
    p.mapsTo = 'schema:email, foaf:mbox (seeAlso); contact fact, not identity';
MERGE (p:OntologyProperty {slug: 'prop-address'})
SET p.name = 'address', p.kind = 'datatype', p.graphKey = 'address',
    p.mapsTo = 'schema:address (seeAlso); Place/Company';
MERGE (p:OntologyProperty {slug: 'prop-service'})
SET p.name = 'service', p.kind = 'datatype', p.graphKey = 'service',
    p.mapsTo = 'house — provider name for an Account node';
MERGE (p:OntologyProperty {slug: 'prop-outcome'})
SET p.name = 'outcome', p.kind = 'datatype', p.graphKey = 'outcome',
    p.mapsTo = 'house — what a Decision decided, in plain words';
MERGE (p:OntologyProperty {slug: 'prop-valid-from'})
SET p.name = 'validFrom', p.kind = 'datatype', p.graphKey = 'validFrom',
    p.mapsTo = 'time:Instant / time:hasBeginning (seeAlso); valid-time start, missing = unbounded';
MERGE (p:OntologyProperty {slug: 'prop-valid-to'})
SET p.name = 'validTo', p.kind = 'datatype', p.graphKey = 'validTo',
    p.mapsTo = 'time:Instant / time:hasEnd (seeAlso); valid-time end, missing = open-ended';
MERGE (p:OntologyProperty {slug: 'prop-recorded-at'})
SET p.name = 'recordedAt', p.kind = 'datatype', p.graphKey = 'recordedAt',
    p.mapsTo = 'prov:generatedAtTime (seeAlso); transaction-time start';
MERGE (p:OntologyProperty {slug: 'prop-retired-at'})
SET p.name = 'retiredAt', p.kind = 'datatype', p.graphKey = 'retiredAt',
    p.mapsTo = 'prov:invalidatedAtTime (seeAlso); transaction-time end — retire, never delete';
MERGE (p:OntologyProperty {slug: 'prop-embedding'})
SET p.name = 'embedding', p.kind = 'datatype', p.graphKey = 'embedding',
    p.mapsTo = 'house — float list (768-dim embeddinggemma); no RDF range asserted (no float-list datatype)';
MERGE (p:OntologyProperty {slug: 'prop-embedding-dim'})
SET p.name = 'embeddingDim', p.kind = 'datatype', p.graphKey = 'embedding_dim',
    p.mapsTo = 'house — comparability guard with embedding_model';
MERGE (p:OntologyProperty {slug: 'prop-embedding-model'})
SET p.name = 'embeddingModel', p.kind = 'datatype', p.graphKey = 'embedding_model',
    p.mapsTo = 'house — comparability guard with embedding_dim';

MATCH (o:Ontology {slug: 'house-memory-graph'})
MATCH (p:OntologyProperty) WHERE p.kind = 'datatype'
MERGE (o)-[:DEFINES_PROPERTY]->(p);
