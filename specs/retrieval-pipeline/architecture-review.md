# Retrieval Pipeline Architecture Review

Reviewed against `benchmark/part2_retrieval/verdict.md`,
`specs/specs.md`, `specs/retrieval-pipeline/spec.md`, and the current
OpenSearch mapping in `app/app/services/opensearch.server.ts`.

## Recommendation

Approve the architectural direction, but do not implement it unchanged. The
core two-leg retrieval system is effective for the benchmark corpus and is not
overengineered. Four decisions need to be resolved before, or at the start of,
Phase 3:

1. Add a structured facet representation for every required filter source.
2. Define and test a concrete lexical-signal gating rule for hybrid ranking.
3. Freeze a comparable v1 benchmark using the actual production query shape.
4. Decide the predictive-search semantic latency contract.

## Findings

### 1. Blocker: the filter schema cannot support every required filter source

`specs/specs.md` requires query-derived filters sourced from product options,
variant titles, metafields, and Shopify taxonomy attributes. The retrieval
spec proposes extracting all of these and applying `term` filters, but the
current index only has `option_facets` as a keyword field:

- `app/app/services/opensearch.server.ts:127` indexes metafields as analyzed
  `metafield_text`.
- `app/app/services/opensearch.server.ts:128` indexes a category name, not
  category attribute values.
- `app/app/services/opensearch.server.ts:131-134` has only `option_facets` as
  a structured filter field.

Analyzed text cannot safely support exact `term` filtering. Define one generic
keyword field such as `attribute_facets`, populated from options, taxonomy
attributes, and allowed structured metafields. Store canonical pairs such as
`color::green` and derive the per-shop vocabulary from that same field.

### 2. High: zero lexical matches is not a sufficient hybrid-ranking gate

The spec selects unweighted two-leg RRF and proposes dropping the lexical leg
only when its exact-match signal is zero. This fixes the documented `body oil`
failure, but does not prevent a lexical leg from producing many irrelevant
matches and still degrading semantic results.

The benchmark demonstrates this problem: kNN scores 95% on the semantic tier,
while `hybrid_morph` scores 90% (`specs/pre-build-validation/part2-results.md`
lines 89-94). For `ברק לעור`, kNN achieves 100% and `hybrid_morph` falls to
83%.

"Exact-match recall" is also not measurable at runtime because relevance
labels are not available. Name and define an observable signal instead, such
as bare-field hit count, title/tag match count, or lexical score
concentration.

Use the smallest solution:

1. Run morphology BM25 and kNN in parallel.
2. Use vector-only when a defined lexical-signal rule says lexical quality is
   absent or weak.
3. Use RRF only when the lexical leg passes that rule.
4. Test semantic queries with noisy, nonzero lexical matches, not only the
   zero-match `body oil` case.

Do not add a classifier, reranker, or tuned per-leg weights until this simple
policy is shown to fail.

### 3. High: the 87% target is not comparable to the planned v1 implementation

The reported 87% benchmark score averages all five tiers, including typo
queries. Typo tolerance is now outside v1. The validated `hybrid_morph` mode
also queried only `.morph` fields, whereas the planned implementation changes
the lexical query to combined bare and morphology fields and adds metafield,
category, SKU, and barcode coverage.

The 87% result proves that the approach is viable, but it does not prove that
the changed production query will achieve the same result.

Create and freeze a v1 baseline containing only baseline, stemming, prefixes,
semantic, and filters tiers. The benchmark must run the exact production
candidate depth, fields, weights, gating rule, and filter behavior. Keep
per-tier gates so a high average cannot hide a semantic or filtering
regression.

### 4. Medium: predictive-search requirements conflict with deferred latency design

The product spec requires the full pipeline in predictive search. The retrieval
spec recognizes that a remote Gemini embedding call per keystroke will likely
miss the type-ahead budget, but defers the decision to Phase 4.

Choose and document one contract before building the endpoint:

1. Lexical-only type-ahead, with hybrid retrieval on submitted search.
2. Debounced semantic type-ahead for settled queries.
3. Cached query embeddings plus a bounded semantic fallback.

The pipeline can still measure full hybrid latency in Phase 3, but the product
promise should not remain ambiguous.

### 5. Medium: the benchmark does not yet prove replacement-engine scale

The positive results come from one 499-product beauty catalog and a small,
hand-authored query battery. The spec explicitly leaves kNN candidate depth and
HNSW behavior at 10k+ products unmeasured, despite Phase 1 targeting stores of
that size.

Before the first production merchant, run a 10k-product test that measures:

- Full hybrid p95 server-side latency, including query embedding.
- Approximate kNN recall against an exact vector-search baseline.
- Filtered kNN behavior and latency.
- Memory and index-size growth from the morphology multiplexer.

This is a validation gap, not a reason to replace OpenSearch.

### 6. Medium: variant filter semantics are currently implicit

`option_facets` is flattened onto the product document. A product with a red
variant and a separate small variant can pass `color=red AND size=small`, even
if no purchasable variant is both red and small.

Choose one behavior explicitly:

- Product-level facets: show products that offer every selected attribute
  somewhere. The flat field is sufficient.
- Variant-level facets: show only products with a matching variant. This needs
  nested variant fields or a variant-oriented index representation.

Product-level semantics are a reasonable v1 simplification if documented.

### 7. Low: historical typo-enabled benchmark documentation can mislead v1 work

The verdict still says typo-leg configuration is a build-phase decision, and
the generated benchmark report labels `hybrid_full` as the evaluated
production candidate. The current Phase 3 spec correctly selects two-leg
`hybrid_morph` because typo tolerance was descoped.

Update the historical references or add an explicit v1 note so fuzzy retrieval
is not accidentally reintroduced.

## Effectiveness

The core design is effective for the tested corpus:

- Morphology normalization is the largest direct improvement and fixes the
  flagship plural-to-singular failure (`שמנים`).
- Vector retrieval supplies semantic and English-to-Hebrew recall, scoring 95%
  on the benchmark semantic tier where lexical retrieval is weak.
- A single OpenSearch index can serve BM25, vectors, and facets, which is the
  right substrate for a replacement engine that needs metafields and
  query-derived filters.
- Client-side RRF is transparent and easy to test, provided it is gated by
  measured lexical quality.

The evidence supports "effective for this corpus and query battery," not yet
"ready to replace Shopify search for arbitrary Hebrew catalogs." The missing
filter implementation, unresolved type-ahead contract, small corpus, and lack
of scale validation are the main limits.

## Overengineering Assessment

The core is not overengineered:

- One search engine avoids operating separate lexical and vector systems.
- BM25 plus kNN is the minimum design that meets morphology and semantic
  requirements.
- A narrow embedding-provider interface is justified by the stated Gemini and
  OpenAI provider requirement.
- Per-shop aliases and stale-only embedding are proportionate to Shopify
  catalog synchronization. The app maintains its own catalog index because it
  replaces Shopify native search and must index data Shopify does not search,
  including metafields.

Avoid adding these before validating the current path:

- A fuzzy or third retrieval leg. Typo tolerance is out of v1.
- An LLM filter extractor. The closed catalog-derived vocabulary is simpler and
  auditable.
- A separate vector database, learning-to-rank model, or semantic reranker.
- Per-query hand-tuned RRF weights.
- Variant-level nested filtering unless product-level filtering proves
  insufficient.
