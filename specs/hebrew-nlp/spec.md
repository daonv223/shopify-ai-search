# Phase 2 Spec — Hebrew NLP Core

> Phase 2 of `specs/task-breakdown.md`. Inputs: `specs/specs.md`
> §2.1 (morphology requirements, §5 acceptance queries), the Phase 0
> analyzer validated in `benchmark/part2_retrieval/03_index_opensearch.py`, and
> the build-phase findings in `benchmark/part2_retrieval/verdict.md`. Builds on
> the Phase 1 index (`app/app/services/opensearch.server.ts`), whose
> `hebrew_search` analyzer is currently a folding-only stub that this phase
> replaces.

## 1. Goal

Ship the differentiator: index- and query-side Hebrew normalization so that
plural/singular, construct-state, and clitic-prefixed forms of a word all
retrieve the same products. At the end of this phase there is still
**no ranking, fusion, or UI** — the deliverable is the analyzer stack in the
products index and a regression harness that proves the linguistics on the
seeded catalog.

**Definition of done:** the NLP harness (§3.5) passes the Baseline, Stemming,
and Prefixes tiers of `specs.md` §5 against the 499-product Phase 0
corpus, and the new analyzer is live in a dev-store index via a `_v2`
build-and-swap with zero downtime — field names and query contracts unchanged,
exactly as the Phase 1 mapping comment promises.

### A note on where this code lives

Nothing in this phase touches Shopify APIs. All the linguistics run inside
OpenSearch as **analyzers** — the tokenize/normalize pipeline OpenSearch applies
to text once at index time and again to every query (so both sides meet on the
same normalized tokens, and the app code never normalizes strings itself). The
only app change is the analyzer definition in
`app/app/services/opensearch.server.ts` plus the reindex path. That is why the
Phase 0 Python benchmark transfers directly: analyzers are index configuration
(JSON), not benchmark code.

## 2. Decisions carried in from Phase 0

The benchmark did not just pass the gate — it already validated a specific
analyzer design. Phase 2 productionizes that design rather than starting fresh.

| Decision | Choice | Why |
|---|---|---|
| Ambiguity strategy (task 2.2) | **Non-destructive multiplexer**: emit the original token *plus* every stripped variant at the same position, never replace | Solves the `מראה`-must-not-become-`ראה` problem by construction — the original always survives. Validated at 74% lexical hit@10 (vs 35% folding-only). The task breakdown's "vocabulary check against the catalog" becomes a fallback, not the plan (§6.1). |
| Stemming baseline (task 2.3) | The Phase 0 regex suffix folding (`ימ`/`יימ`/`ות`/`י` after ≥2 Hebrew letters), **no feminine ה/ת stripping** | Scored **97% on the stemming tier** (from 28%) including construct state — `שמני גוף` ≈ `שמן גוף` works because both fold to stem `שמנ`. Feminine stripping over-stems (`בית` → `בי`), confirmed in the benchmark. A lexicon-based stemmer must beat this floor to earn its place (§3.3). |
| Field layout | Every text field indexed twice: bare (`hebrew_text`-style: folding + lowercase) and a `.morph` subfield with the full analyzer | Keeps the exact-match and morphology legs independently addressable — the substrate Phase 3.3's fusion (and its "gate the lexical leg on real signal" fix) requires. |

## 3. Scope

### 3.1 Tokenizer + final-letter normalization (task 2.1 · 1d)

Mostly shipped in Phase 1 (`he_final_letters` char filter: ך→כ ם→מ ן→נ ף→פ ץ→צ,
`standard` tokenizer, lowercase). Remaining work:

- Restructure `INDEX_BODY` to the two-analyzer layout: `hebrew_text` (bare) and
  `hebrew_morph` (bare + `he_variants` multiplexer), with every `TEXT` field
  gaining a `morph` subfield — port of the benchmark's `TEXT` mapping.
- Verify tokenizer behavior on real catalog artifacts: geresh/gershayim in
  acronyms, `&` in titles (the anchor product has one), mixed Hebrew/Latin
  tokens (`ESSENTIAL OILS` stays intact for exact match), numbers with units.
  Fix with char filters only if the harness shows a real miss.

### 3.2 Clitic/prefix stripping (task 2.2 · 3d)

- Port the benchmark's prefix filter: strip one leading clitic from the set
  ה ו ב ל מ כ ש when what remains is ≥3 Hebrew letters
  (`^[ובלמכהש](?=[א-ת]{3,}$)`), applied inside the multiplexer in single and
  double chains (covers `ולמראה`-style stacked clitics), each chain with and
  without the suffix filter.
- Because the multiplexer preserves the original, ambiguous forms are safe:
  `מראה` emits both `מראה` and `ראה`; a product titled `מראה` still matches
  exactly and outranks stem-only matches once Phase 3 weights exact > morph.
- Budget the estimate's remaining time for harness-driven tuning: the 3-letter
  guard, whether double-stripping needs its own guard, and precision spot-checks
  on the catalog's most frequent tokens (a script dumping top terms from
  `_analyze` output — cheap, catches over-stripping early).

### 3.3 Plural↔singular + construct-state stemming (task 2.3 · 5d)

- **Day 1 — timeboxed evaluation** of existing Hebrew stemmers/lexicons before
  writing any rules, per the task note: HebMorph (hspell-derived,
  `elasticsearch-analysis-hebrew`) and raw hspell wordlists as a
  `stemmer_override`/synonym-graph source. Evaluation criteria: runs on
  OpenSearch ≥2.12 (HebMorph's plugin targets Elasticsearch — compatibility is
  the likely killer), and beats the regex baseline on the harness without
  regressing Baseline/Prefixes tiers.
- **Default path** (if the evaluation fails, which is the expected outcome):
  ship the regex suffix folding as-is at 97%, then spend the remaining days on
  its known gaps, harness-first:
  - irregular/broken plurals the suffix rule can't reach (e.g. masculine nouns
    taking `ות`, feminine taking `ימ`) — handle the ones that actually occur in
    the corpus via a small curated `stemmer_override` list, not a general rule;
  - construct-state edge cases beyond the `י` fold;
  - collision audit: suffix folding maps distinct words onto one stem
    (`שמן`/`שמנים` but also potentially unrelated `ות`-strips) — dump and
    review the highest-frequency stem collisions from the catalog.
- Whatever the path, the output is still a token filter inside `he_variants` —
  the mapping contract does not change.

### 3.4 Typo tolerance — REMOVED (descoped 2026-08-11)

Typo tolerance (task 2.4: the fuzzy query leg and keyboard-adjacency
weighting) was descoped after review and will not be implemented in v1.
Misspelled queries (`שדקים`) will not match. The validated design, should it
be revived, is preserved in the Phase 0 benchmark (`hybrid_3leg`,
`fuzziness: 1` + transpositions, `prefix_length: 0`, bare fields only — never
`.morph`) and in `phase2-notes.md`.

### 3.5 NLP regression harness (task 2.5 · 1d — build FIRST)

The task breakdown says build early; concretely, this is step one of the phase,
before touching the analyzer, so 2.2–2.4 develop red-to-green against it.

- Vitest (the app has no test runner yet — add `vitest` + a `test` script to
  `app/package.json`), tests hitting local dockerized OpenSearch.
- Seed from the frozen Phase 0 corpus: `benchmark/dataset/products.jsonl` +
  `benchmark/dataset/query_relevance.jsonl` (499 L'Occitane IL products with
  reviewed ground truth) — same data, so results are directly comparable to the
  benchmark's numbers.
- Two test layers:
  1. **Analyzer unit tests** via `_analyze`: exact token expectations for the
     §5 forms (`שמנים`→ contains `שמנ`; `למראה` → contains `מראה` *and*
     `ראה` *and* original; `בשמן`/`השמן`/`ושקדים` strip; `מראה` keeps original).
  2. **Retrieval tests** per §5 tier: Baseline, Stemming, Prefixes (morph-leg
     match query) — asserting the ground-truth product appears in top-10, tier
     hit-rates at or above the benchmark's (lexical-morph 74% overall,
     stemming 97%).
- The Filters and Semantic tiers are **out** — they need Phase 3 (fusion,
  embeddings, filter extraction). The Typos tier is out permanently (§3.4
  descope). The harness structure should let Phase 5.2 add tiers.

### 3.6 Reindex rollout

- Bump the physical index to `products_{shop}_v2` with the new settings and
  flip the alias — `ensureIndex` in `opensearch.server.ts` currently only
  creates `_v1`; add a `migrateIndex(alias)` path: create `_v2`, `_reindex`
  from `_v1` (analyzers re-run automatically on reindex — vectors and stored
  fields carry over, so **no** re-fetch from Shopify and no re-embedding),
  atomically swap the alias, delete `_v1`.
- Verify on the dev store: search keeps answering during the swap (A7 below).

## 4. Non-goals (Phase 2)

- Ranking, RRF fusion, leg weighting/gating — Phase 3.3 (this phase only
  guarantees the legs exist and each finds its tier's targets).
- Query→filter extraction and attribute-inflection matching — Phase 3.4 (it
  reuses `hebrew_morph` via `_analyze`, another reason the analyzer, not app
  code, owns morphology).
- Embeddings — untouched; `embedding_stale` semantics from Phase 1 stand.
- Ktiv male/haser normalization (`זהר` ↔ `זוהר`) — explicit v1 non-goal
  (`specs.md` §4).
- Feminine ה/ת suffix stripping — deliberately excluded (over-stemming).
- Synonym lists — Phase 5.1; morphology is the "automatic synonyms" layer.

## 5. Acceptance tests

Run the harness against the seeded corpus; A6–A8 manually on the dev store.

| # | Test | Required outcome |
|---|---|---|
| A1 | `_analyze` battery (§3.5 layer 1) | All token expectations pass; `מראה` emits its original form; `ESSENTIAL OILS` tokens unmangled |
| A2 | Stemming tier: `שקד`, `שמנים`, `שמני גוף` | Ground-truth products in top-10 on the morph leg; `שמנים` returns body oils, not shampoos; tier hit@10 ≥ 90% (benchmark: 97%) |
| A3 | Prefixes tier: `מראה`, `שמן לגוף`, `בשמן`, `השמן`, `ושקדים` | Bare/prefixed forms match the same products; no regression on Baseline tier (`שמן גוף`, `שימר`, `שקדים` still hit) |
| A6 | Reindex migration on the dev store | `_v2` built and alias flipped; doc count unchanged; a query issued mid-reindex still answers (zero downtime); `_v1` gone after |
| A7 | Incremental sync post-migration | Edit a product title in admin → appears normalized in `_v2` < 30s (Phase 1 pipeline unaffected by the swap) |
| A8 | Latency guard | Morph-leg match query p95 stays comfortably inside the Phase 4 type-ahead budget (<100ms server-side) on the 499-product corpus — the multiplexer multiplies tokens; catch pathological expansion now |

## 6. Open questions (carry forward, non-blocking)

1. **Lexicon upgrade path** — if the timeboxed HebMorph/hspell evaluation
   (§3.3) fails on OpenSearch compatibility, a later option is offline
   catalog-vocabulary expansion (generate inflection→stem pairs for indexed
   terms app-side, load as `stemmer_override`). Only pursue if real-merchant
   catalogs surface stemming misses the regex can't cover.
2. **Multiplexer index bloat** — 5 variant chains per token grows the inverted
   index; fine at 499 products, unmeasured at 10k+. Check index size during
   Phase 5.3 hardening.
