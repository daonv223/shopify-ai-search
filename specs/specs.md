# Product Specification — AI Search for Hebrew Shopify Stores

> Derived from `ideal.md` and validated against Shopify's native search engine
> (research + live testing on il.loccitane.com, a native-search Hebrew store, July 2026).
> See `Verify Shopify AI search app against native search capabilities.md` for full evidence.

## 1. Positioning

**Headline: Hebrew morphology normalization — not "semantic search."**

Live testing proved that Shopify's native semantic search is already active and working
in Hebrew (cross-language `shimmer` → `שימר` product at #1; `נצנצים לגוף` → shimmer oil
at #1; `קרמים` matching lotions with zero lexical overlap). "Semantic search for Hebrew"
is therefore a commodity claim and must not be the headline.

What Shopify demonstrably does **not** do for Hebrew — all reproduced on a live store:

| # | Gap | Evidence |
|---|-----|----------|
| 1 | **Plural→singular stemming** | `שמנים` (oils) → 61 results, none a body oil; top hits are shampoos matched on a lexical accident in a description. Meanwhile `שמן` matches 142 products. Stemming is documented as English/Japanese only. |
| 2 | **Typo tolerance** | Transposition `שדקים` → 0 results; Hebrew is absent from Shopify's supported-languages table. |
| 3 | **Ktiv male/haser variance** | `זהר` (haser spelling of `זוהר`) → 0 results. |
| 4 | **Deterministic results** | Same query, consecutive uncached requests: `שמני גוף` → 8, 1, 23, 1, 23, 8, 1, 1 results. `מראה` → 0, 78, 78, 0. A coin-flip empty-results page. |
| 5 | **Query→filter extraction** | Shopify has filter infrastructure (Search & Discovery) but never derives filters from query text ("green sunglasses" does not apply a color facet). |
| 6 | **Semantic layer on predictive search** | Shopify's semantic search explicitly does not run on the type-ahead dropdown, where most searches happen. |
| 7 | **Plan coverage** | Basic/Starter plans get no semantic search at all (<200k products + Grow/Advanced/Plus required). |

Sales demo priority (most commercially valuable first):
1. **Plural→singular failure** — screenshot-ready on a flagship brand's store (`שמנים` → shampoos).

Gaps 2, 3 and 4 (typo tolerance, ktiv variance, non-deterministic results) are
documented above as research evidence but deferred — see Non-Goals.

## 2. Core Features

### 2.1 Hebrew morphology normalization (must-have)

Normalize both the indexed catalog text and incoming queries:

- **Number**: plural ↔ singular in both directions (`תחתונים` ↔ `תחתון`, `שמנים` ↔ `שמן`).
  Plural→singular is the critical direction — suffixal Hebrew plurals mean singular→plural
  sometimes works natively via prefix matching, but plural→singular fails, and that is
  what shoppers type.
- **Prefix stripping**: definite article and clitics ה, ו, ב, ל, מ, כ, ש
  (`בתחתונים`, `למראה` → `מראה`, `שמן לגוף` ≈ `שמן גוף`).
- **Final-letter normalization**: ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ.
- **Construct state**: `שמני גוף` (construct plural) must match `שמן גוף`.

### 2.2 Hebrew typo tolerance — REMOVED (descoped 2026-08-11)

Dropped from v1 after review; misspelled queries will not match. The native
gap remains documented in §1 as research evidence. The validated design
(edit distance 1 with transpositions, no first-N-chars restriction,
keyboard-adjacency weighting) is preserved in the Phase 0 benchmark and
`specs/hebrew-nlp/phase2-notes.md` should it be revived.

### 2.3 Query → filter extraction — REMOVED (descoped 2026-08-16)

Dropped from v1 after review; the app will not derive structured filters from
free-text query text in the first release. The native gap remains documented
in §1 (gap #5) as research evidence. The validated design (attribute
vocabulary from options/variants/metafields/taxonomy, inflection-tolerant
matching reusing Phase 2 morphology, AND-semantics narrowing) is preserved
in `specs/retrieval-pipeline/spec.md` §3.4 and Phase 3 task 3.4 should it be
revived in a later phase.

### 2.4 Semantic/embedding recall layer (supporting, not headline)

- Each searchable product is converted to an embedding via a pluggable external
  provider (Gemini, OpenAI). Provider choice is a config concern; the interface must
  allow swapping.
- Used for synonym/intent recall (`נצנצים לגוף` → shimmer products) and
  cross-language queries (`body oil` on a Hebrew catalog).
- **Precondition (open validation task)**: verify empirically that the chosen embedding
  model clusters Hebrew morphological variants tightly — embed ~50 Hebrew word pairs
  and measure cosine similarity before committing to a provider.

### 2.5 Predictive search / type-ahead (high value)

- The full pipeline (morphology, semantic, filters) applies to the type-ahead
  dropdown, not only the results page — precisely where Shopify's semantic layer is
  absent.

## 3. Architecture Constraints

- **Replacement, not augmentation.** Third-party search apps override Shopify native
  search entirely: installing this app forfeits native semantic search, Search &
  Discovery synonyms, and product boosts. The engine must therefore beat the native
  stack outright in Hebrew — including on the conceptual/semantic queries where
  native currently does well. A hybrid design (keep Shopify lexical recall, rerank +
  augment with our normalization/embeddings) is the fallback if full replacement
  can't match native semantic quality.
- **Indexing scope**: title, product_type, body, tags, vendor, variant titles, SKU,
  barcode, **plus metafields** (a native gap).
- **RTL rendering** is a theme concern, out of scope for the search engine, but search
  UI components we ship (dropdown, results grid) must render RTL correctly.
- Sync pipeline: initial catalog ingest + webhook-driven incremental updates
  (products/create, update, delete); re-embed only changed text.

## 4. Explicit Non-Goals (v1)

- **Typo tolerance** (`שדקים` → `שקדים`, keyboard-adjacency errors) — descoped
  2026-08-11 after review (see §2.2); the native gap stays in §1 as research
  evidence only.
- **Query→filter extraction** (deriving structured facets from free-text query
  text, e.g. "green sunglasses" → color=green) — descoped 2026-08-16 after
  review (see §2.3); the native gap stays in §1 (gap #5) as research evidence
  only.
- **Ktiv male/haser & spelling-variance normalization** (`זהר` ↔ `זוהר`, geresh
  variants, Hebrew↔Latin transliteration) — verified as a native gap, deferred to a
  later version.
- **Deterministic-results guarantee as a marketed feature** — the native instability
  finding stays in the research doc as sales evidence, but we make no determinism
  commitment in v1.
- Conversational/agentic shopping ("something to make my skin glow" is handled only
  as far as embedding recall naturally covers it).
- Non-Hebrew-first stores (multilingual support beyond Hebrew+English queries).
- Merchandising suites (boosts, banners, A/B testing) beyond a basic synonym/boost
  admin — native Search & Discovery caps at 1,000 synonyms store-wide, so our synonym
  handling should be automatic (morphology) rather than a bigger manual list.

## 5. Acceptance Tests

The live test battery from the verification doc is the regression suite. Reference
store data: L'Occitane IL product `שמן גוף & שימר שקדים למראה עור זוהר`.

| Tier | Query examples | Required outcome |
|------|----------------|------------------|
| Baseline | `שמן גוף`, `שימר`, `שקדים` | Exact matches returned, target in top results |
| Stemming | `שקד`, `שמנים`, `שמני גוף` | Plural↔singular resolved; `שמנים` returns body oils, not shampoos |
| Prefixes | `מראה`, `שמן לגוף`, `בשמן`, `השמן`, `ושקדים` | Prefixed/bare forms match |
| Semantic | `נצנצים לגוף`, `ברק לעור`, `body oil` | At least parity with native (target product top-5) |

## 6. Open Questions / Pre-Build Validation

1. Embedding quality for Hebrew morphology (see 2.4) — Gemini vs OpenAI benchmark.
2. Whether to build the prospect-audit script (point at any store, produce a one-page
   Hebrew-search failure report) as a lead-generation tool.
3. Hybrid-fallback feasibility: does the Storefront API `search` query apply native
   semantic search on eligible plans? Search & Discovery is documented as "compatible
   with the Storefront API," but semantic applicability to API responses is not
   explicitly documented — needs an empirical test (run Tier-5 semantic queries
   through the API on a Grow+ store) before the hybrid design can count on it.
