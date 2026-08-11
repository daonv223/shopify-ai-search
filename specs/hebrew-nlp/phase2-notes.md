# Phase 2 build notes — decisions made during tasks 2.2/2.3 (spec §3.2/§3.3)

Working log for decisions the spec left open. Companion to `spec.md`; harness
numbers referenced here come from `app/tests/nlp/` against the frozen
499-product corpus.

## Stemmer/lexicon evaluation (§3.3 day 1) — verdict: not viable, regex stays

Evaluated per the timebox before touching rules:

- **HebMorph / `elasticsearch-analysis-hebrew`**: last published builds target
  Elasticsearch **5.3** (2017); no OpenSearch build exists, and OpenSearch 2.x
  loads only plugins compiled per exact OpenSearch version. Dead on the
  compatibility criterion, as the spec predicted. Additionally the plugin and
  its bundled hspell dictionaries are **AGPL3** — a licensing problem for a
  commercial app regardless of compatibility. (A commercial OpenSearch-capable
  analyzer exists — code972 / eyfo — noted as a paid fallback only.)
- **Raw hspell wordlists as `stemmer_override` source**: technically feasible
  (no plugin needed), but hspell data is also AGPL, and the corpus audit below
  showed the regex baseline's gaps are narrow and enumerable. Deferred per
  spec open question 1 — revisit only if real-merchant catalogs surface misses.

**Outcome:** the default path — the Phase 0 regex suffix folding ships as-is
(stemming tier 0.967 on the harness, matching the benchmark's 97%).

## Corpus audit (`app/scripts/nlp-audit.ts`, run with `npm run nlp:audit`)

Seeds the harness index and dumps three review sections:

- **A. Top-token variant spot-check (§3.2 over-stripping)** — clean. The
  multiplexer never destroys an original; wrong-strip variants (שיאה→יאה,
  מתנה→תנה) are additive noise on low-IDF terms. **The 3-letter prefix guard
  stays as-is and double-stripping needs no extra guard** — evidence: tier
  precision at calibrated levels, no destructive loss in the dump. Guard
  behavior is pinned in `analyzer.test.ts`.
- **B. Stem collisions** — 2,555 colliding stems, overwhelmingly inflections
  of one lexeme meeting on a shared stem (the desired effect). Cross-lexeme
  conflations involve stopword-like tokens (של←להשלימ, על←העלות) that BM25
  IDF devalues. One real conflation: לח (moisture) ← לחיימ (cheeks) — not
  fixable without a lexicon, low harm in this domain, accepted.
- **C. Singular↔plural gap pairs** — the systematic finding: **feminine ־ה
  singulars never met their ־ות/־ימ plurals** (165 pairs), because the plural
  suffix strips (אריזות→אריז) while the singular keeps its ה (general
  ה-stripping remains a non-goal — over-stems). Fixed for retrieval-relevant
  **nouns** only via the curated `he_fem_singular` stemmer_override
  (15 rules in `opensearch.server.ts`), each mapping the singular onto the
  stem its plural already produces (אריזה→אריז, מסכה→מסכ, לילה→ליל…).
  Runs inside the multiplexer's suffix chains, so prefixed forms (באריזה) are
  covered and originals are always preserved. Remaining 143 pairs are body-copy
  adjectives/participles (מכילה, מעניקה, רכה…) and false pairs
  (מקלות/מקלה, כמות/כמה) — deliberately not bridged.

## Typo tolerance (§3.4) — descoped 2026-08-11

Decision after review: the typo-tolerance leg is **not** being implemented.
Task 2.4, the harness's Typos tier (acceptance A4), and the stacking guard
(A5) are dropped; misspelled queries (שדקים) will simply not match in v1.
The analyzer stack is unaffected — this was always a query-side leg, never a
mapping change. If revived later, the validated design is preserved in the
benchmark (`hybrid_3leg`, fuzziness 1 + transpositions, prefix_length 0, bare
fields only — never `.morph`, which degraded the lexical tier 90%→66%) and in
this repo's history (commit c9e7920 carries the harness fuzzy leg and guard
tests).

## Effect on the harness

Tier hit@10 unchanged after the override (baseline 0.833, stemming 0.967,
prefixes 1.0) — recall added, no precision cost.

## Reindex rollout (§3.6) — executed on the dev store 2026-08-11

`migrateIndex(alias)` in `opensearch.server.ts` (runner:
`npm run migrate-index -- <alias>`): creates the next `_vN` from the current
`INDEX_BODY`, `_reindex`es (analyzers re-run; stored fields and vectors carry
over — no Shopify re-fetch, no re-embedding), verifies the doc count, swaps
the alias in one atomic `updateAliases` call, deletes the old index. A failed
count check discards the new index and leaves the alias untouched. Known
window: writes landing between the reindex snapshot and the alias flip are
dropped with the old index — run in a quiet window; the webhook pipeline
re-syncs any product on its next update.

- **A6** verified live: `products_hebrew_ai_search_dev` `_v1` (Phase 1
  folding-only mapping, 200 docs) → `_v2` with the morph analyzer; count
  unchanged, `_v1` deleted, `title.morph` queries answering. Zero-downtime is
  structural — the alias never has zero backing indices.
- **A8** measured on the 499-product harness corpus: morph-leg match query
  p50=1ms / p95=2ms / max=3ms server-side — far inside the <100ms type-ahead
  budget; no pathological multiplexer expansion.
- **A7** verified live: an admin title edit appeared in `_v2` ~19s later via
  the Phase 1 webhook pipeline (writes go through the alias, unaffected by the
  swap), and the fresh doc answered a stacked-clitic morph query (והשוליים →
  שוליים) — normalized by the new analyzer on the way in.

Sources for the evaluation: [elasticsearch-analysis-hebrew](https://github.com/synhershko/elasticsearch-analysis-hebrew),
[HebMorph](https://github.com/synhershko/HebMorph).
