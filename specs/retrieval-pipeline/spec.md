# Phase 3 Spec — Retrieval Pipeline

> Phase 3 of `specs/task-breakdown.md` (~15 days). Inputs: `specs/specs.md`
> §2.3–§2.4 (filter extraction, embedding layer), §5 (acceptance tiers), the
> Phase 0 verdict in `benchmark/part2_retrieval/verdict.md` (fusion design and
> its known failure mode), and the Phase 2 analyzer stack now live in
> `app/app/services/opensearch.server.ts` (bare + `.morph` fields, harness in
> `app/tests/nlp/`). The typo leg is gone (descoped 2026-08-11), which
> simplifies the fusion from the benchmark's 3-leg candidate to 2 legs.

## 1. Goal

Turn the indexed catalog into a search engine: a query goes in, ranked
products come out, with semantic recall and query-derived filters. At the end
of this phase there is still **no storefront endpoint or UI** — the
deliverable is an app-side search service (callable by Phase 4's app proxy
route) plus the embedding pipeline that keeps vectors fresh, proven by the
harness on the full §5 tier battery.

**Definition of done:** the harness passes all in-scope `specs.md` §5 tiers —
Baseline, Stemming, Prefixes (no regression from Phase 2), plus the new
Semantic and Filters tiers — against the 499-product corpus with vectors
populated; overall hybrid hit@10 at or above the benchmark's 87%; and the dev
store re-embeds only stale products after a text edit.

### A note on where this code lives

Nothing in this phase touches Shopify APIs or the storefront. The work is
app-side services: an embedding worker that consumes the `embedding_stale`
flag Phase 1 has been maintaining, and a search service that queries
OpenSearch through the per-shop alias. Phase 4 wraps the search service in the
app-proxy HTTP endpoint; this phase can exercise it directly from tests.

## 2. Decisions carried in from Phases 0–2

| Decision | Choice | Why |
|---|---|---|
| Fusion design (task 3.3) | **Client-side RRF, k=60, untuned** over two legs: lexical (morph-analyzed BM25) + kNN | The benchmark's `hybrid_morph` scored **87% vs native 59%** hit@10 with exactly this fusion (`04_run_queries.py`). The 3-leg production candidate existed only to carry the typo tier — descoped, so two legs is the whole design. |
| Lexical-leg gating (task 3.3) | **Never fuse a lexical leg with no signal** — drop or down-weight it when exact-match recall is ~zero | Verdict finding 3: naive fusion scored *worse than kNN alone* (70% vs 84%), and the `body oil` case turned a native-parity result into the worst loss by fusing 41 fuzzy haircare hits against a perfect kNN ranking. The fuzzy trigger is gone with the typo descope, but the zero-signal case (cross-language queries) remains. |
| Lexical field weights (task 3.1) | `title^3, tags^2, product_type^2, variant_titles^1.5, option_values^1.5, vendor, body`, `best_fields`, OR | The exact weighting the 87% was measured on. Starting point, not sacred — but changes must re-earn their score on the harness. |
| Exact vs morph precedence | Query bare **and** `.morph` fields together, bare weighted above its `.morph` twin | Redeems the Phase 2 promise that a product literally titled `מראה` outranks stem-only matches. The two-analyzer field layout was built for this. |
| Embedding provider (task 3.2) | **Gemini `gemini-embedding-001`**, 3072-dim; `RETRIEVAL_DOCUMENT` for products, `RETRIEVAL_QUERY` for queries | Chosen in Phase 0 (task 0.1) and baked into the mapping (`EMBED_DIM = 3072`, HNSW/cosine). The asymmetric task types are part of the validated setup. Provider stays behind an interface (spec §2.4) but Gemini is the v1 default. |
| Embedding input text | `composeEmbeddingInput` in `product-doc.server.ts` — title, type, tags, body(1500 chars) | Already shipped in Phase 1 and frozen: `content_hash` is defined over it, so the embedder must use it verbatim or every product goes stale. |

## 3. Scope

### 3.1 Lexical search service (task 3.1 · 3d)

- A search module (e.g. `app/app/services/search.server.ts`) exposing the
  lexical leg: `multi_match` over bare + `.morph` fields with the carried-in
  weights, against the shop's alias.
- **Extend field coverage beyond the benchmark set** per the task note ("all
  fields incl. metafields"): add `metafield_text`, `category_name`, and
  `sku`/`barcode` (exact-ish fields — bare only, no `.morph`, low weight for
  the first two; SKU/barcode are lookup fields, not prose). The benchmark
  corpus had no metafields, so these weights are untested — pick conservative
  values and let the harness veto regressions.
- Returns ranked `{product_id, handle, score, …display fields}` plus the
  leg-level diagnostics 3.3 needs (per-leg ranks, exact-match count).

### 3.2 Embedding layer (task 3.2 · 3d)

- **Provider interface**: `embed(texts, taskType) → vectors`, with the Gemini
  implementation first (port of the benchmark client's role; API key via env,
  cf. `benchmark/.env`). OpenAI can implement the same interface later — no
  other code knows the provider.
- **Backfill worker**: query `product_sync_state` for `embedding_stale = true`,
  batch-compose inputs with `composeEmbeddingInput`, embed as
  `RETRIEVAL_DOCUMENT`, write vectors into the index (`embedding` field),
  clear `embedding_stale`. Batched and resumable: a crash mid-run loses
  nothing (flags clear per-product only after the vector is written).
- **Triggering**: run after bulk ingest completes and after webhook upserts
  mark products stale — a simple debounced sweep is fine for v1 (poll or
  post-sync kick; a real queue is a Phase 5.3 concern). Freshness target:
  text edit → new vector within a few minutes, not seconds (webhook doc
  freshness stays <30s via the Phase 1 path; only the vector lags).
- **Cost discipline** (the reason `content_hash` exists): the worker embeds
  only stale products, ever. Basic retry with backoff on 429/5xx; hard rate
  limits and cost guards are Phase 5.3.
- Query-side embedding (`RETRIEVAL_QUERY`) exposed for 3.3 — with an eye on
  latency (see A8/open question 2).

### 3.3 Hybrid ranking (task 3.3 · 4d)

- kNN leg: embed the query, `knn` search over `embedding` (top ~50
  candidates), skipping docs with `embedding_stale = true` vectors absent.
- Fuse with the lexical leg via RRF(k=60), client-side, per the benchmark
  implementation (`score = Σ 1/(60 + rank)`).
- **Implement the gating fix** from the verdict: when the lexical leg has no
  real signal (zero/near-zero exact-field matches — the `body oil` case),
  drop it from the fusion instead of fusing noise. Simplest sufficient rule
  first (drop at zero exact-match recall); graduate to count-weighted legs
  only if the harness shows the cliff-edge rule failing.
- **Tuning budget** (most of the 4d): extend the Phase 2 harness with the
  Semantic tier (`נצנצים לגוף`, `ברק לעור`, `body oil` — ground truth already
  in `benchmark/dataset/query_relevance.jsonl`) and iterate until Tier-5
  targets sit in the top 5 ("at least parity with native") without regressing
  Baseline/Stemming/Prefixes. The benchmark says this is reachable: kNN alone
  scored 95% on the semantic tier and ranked all six body oils at 1–6.

### 3.4 Query→filter extraction (task 3.4 · 5d)

The second-hardest piece; reuses Phase 2 morphology rather than reimplementing it.

- **Attribute vocabulary**, built per shop from the index: `option_facets`
  (`name::value` pairs from options + variant selectedOptions), taxonomy
  category attributes, and structured metafield values (`shopify` namespace
  first). Each vocabulary value is normalized to its stem set via the
  `hebrew_morph` analyzer (`_analyze` endpoint) — the analyzer stays the
  single owner of morphology.
- **Matching in any inflection** (`ירוק/ירוקה/ירוקים/ירוקות`): analyze the
  query the same way and match token stems against vocabulary stems. One gap
  the retrieval analyzer leaves open: feminine `ה` is deliberately never
  stripped (over-stems in open text), so `ירוקה` won't meet `ירוק` through
  the analyzer alone. For vocabulary matching this is safe to fix with a
  **more aggressive variant set** (try feminine ה/ת stripping as an extra
  candidate): a stripped form must still hit a known attribute value to
  count, so the closed vocabulary bounds the false-positive risk that made
  ה-stripping a non-goal for retrieval.
- **Application**: matched attributes become `term` filters on the keyword
  facet fields with **AND semantics** (spec §2.3 — narrow, don't boost).
  Matched tokens stay in the retrieval query text (they often also appear in
  titles/body; removing them risks emptying short queries). Availability and
  price fields exist in the mapping but price-range parsing ("מתחת ל100") is
  **not** in scope — attribute values only.
- **Multi-value semantics**: same attribute matched twice → OR within the
  attribute, AND across attributes (standard faceting).
- Output feeds both legs: filters apply to the lexical query and as a kNN
  filter, so semantic recall respects them too.

**Suggested build order**: 3.1 and 3.2 in parallel (independent), then 3.3 on
top of both, then 3.4 (needs 3.1's query path and Phase 2's analyzer, benefits
from 3.3 being stable when measuring). Extend the harness tier-by-tier
*before* tuning each piece, red-to-green, per the Phase 2 pattern.

## 4. Non-goals (Phase 3)

- HTTP endpoint, app-proxy wiring, type-ahead latency engineering — Phase 4
  (this phase measures latency, A8, but doesn't optimize the transport).
- Any UI: dropdown, results grid, applied-filter chips — Phase 4.
- Synonym & boost admin, metafield-allowlist UI — Phase 5.1.
- Rate-limit hardening, cost guards, reconciliation — Phase 5.3 (3.2 ships
  basic retry only).
- Typo tolerance — descoped from v1 (`specs.md` §2.2); no fuzzy leg returns.
- Ktiv male/haser normalization, price-range query parsing, negation
  ("בלי כחול") — out.

## 5. Acceptance tests

Harness tests run against the seeded 499-product corpus (now with vectors);
A7–A8 measured, A2 also verified on the dev store.

| # | Test | Required outcome |
|---|---|---|
| A1 | Lexical field coverage: doc whose attribute exists **only** in `metafield_text` | Found by the lexical leg — proves the native metafield gap is actually closed |
| A2 | Embedding lifecycle: full sweep, then title edit, then price-only edit | All docs embedded + `embedding_stale` cleared; title edit re-embeds **that product only**; price edit re-embeds **nothing** (hash unchanged) |
| A3 | Hybrid regression: full harness, Baseline/Stemming/Prefixes tiers | No regression from Phase 2 (0.833 / 0.967 / 1.0 hit@10); overall hybrid hit@10 ≥ 85% (benchmark `hybrid_morph`: 87%) |
| A4 | Semantic tier: `נצנצים לגוף`, `ברק לעור`, `body oil` | Ground-truth product in **top 5** — the spec's "at least parity with native" bar |
| A5 | Lexical-leg gating: `body oil` (cross-language, zero lexical signal) | Top 5 are body oils, no haircare injection — the verdict's self-inflicted loss stays fixed; kNN-alone and hybrid results near-identical on this query |
| A6 | Filters tier: attribute queries phrased against corpus attributes, each attribute word in ≥2 inflections | Same filter extracted for every inflection; result set narrowed (AND), strictly a subset of the unfiltered query; residual terms still retrieved. Ground truth authored in this phase — the Phase 0 benchmark never tested this tier (spec §5's sunglasses examples don't exist in the corpus) |
| A7 | Filter false-positive guard | Queries with no attribute words (`שמן גוף`, `שימר`) extract **zero** filters — extraction must not eat ordinary queries |
| A8 | Latency: hybrid query end-to-end server-side, p95, incl. query embedding | Measured and recorded. Lexical-only p95 must stay <100ms (Phase 4 type-ahead budget); if the Gemini query-embedding round trip pushes the full hybrid past budget, that finding + mitigation options go to Phase 4 (see open question 2) — measuring it now is the acceptance, fixing it is not |

## 6. Open questions (carry forward, non-blocking)

1. **Filters-tier ground truth** — the frozen corpus is cosmetics; which
   attributes (e.g. scent family, skin type, size from `option_facets`) give
   an honest tier battery? Authored during 3.4; keep the queries in the
   dataset repo so Phase 5.2 inherits them.
2. **Query-embedding latency vs the type-ahead budget** — a live Gemini call
   per keystroke likely blows <100ms. Phase 4 options, informed by A8's
   numbers: lexical-only type-ahead with hybrid on the results page,
   debounce + embed only "settled" queries, or a query-embedding cache.
   Decide in Phase 4, with data.
3. **kNN candidate depth & recall** — top-50 with default HNSW `ef_search`
   matches the benchmark at 499 products; unmeasured at 10k+. Revisit in
   Phase 5.3 alongside the multiplexer index-bloat question.
4. **Vocabulary-match ambiguity** — an attribute value that is also a common
   product word could over-filter (the closed vocabulary bounds but doesn't
   eliminate this). If A7-style guards prove insufficient on real catalogs,
   fall back to requiring residual query terms before applying any filter.
