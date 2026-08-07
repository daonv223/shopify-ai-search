# Pre-Build Validation Plan — Hebrew Embedding & Hybrid Search Benchmark

> Task spec: `spec.md`. Parent spec: `../specs.md` (§2.4 precondition, §3 architecture gate, §5 acceptance tests).

## Objective

Before building the app, prove empirically that our proposed stack —
**Gemini `gemini-embedding-001` (3072-dim) + OpenSearch hybrid retrieval (BM25 keyword + kNN semantic)** —
1. handles Hebrew morphology in embedding space (spec §2.4 precondition), and
2. beats Shopify native search on the Hebrew failure tiers (stemming, typos) while reaching
   at least parity on the semantic tier where native is already good (spec §3: replacement
   must beat native outright).

Reference store: **il.loccitane.com** (native Shopify search, Hebrew catalog).
Anchor product: `שמן גוף & שימר שקדים למראה עור זוהר`.

## Verified environment facts

- `https://il.loccitane.com/products.json?limit=250&page=N` — public, returns full catalog JSON
  (title, body_html, tags, product_type, vendor, variants). Verified 2026-07-28.
- Native search results pages are server-rendered; product handles parseable from HTML
  (`/search?q=…&type=product`). Rapid consecutive requests get rate-limited → scripts use 4–5 s
  delays and retries.
- Local OpenSearch **2.12.0** on `localhost:9200` with `opensearch-knn` plugin — supports
  3072-dim vectors (≥ 2.11 required). Security disabled, plain HTTP.
- `GEMINI_API_KEY` provided via shell environment (never committed).

---

## Part 1 — Embedding sanity check (word pairs)

**Question:** does `gemini-embedding-001` cluster Hebrew morphological variants tightly enough
to power recall, and where must we rely on lexical techniques (BM25 fuzziness, char filters) instead?

### Method

~66 word/phrase pairs in `benchmark/part1_wordpairs/word_pairs.json`, across categories:

| Category | n | Role | Examples |
|---|---|---|---|
| plural_singular | 10 | **GATE** (spec §2.1) | `שמנים`/`שמן`, `בשמים`/`בושם` (irregular) |
| prefix | 8 | **GATE** (spec §2.1) | `בשמן`/`שמן`, `מהטבע`/`טבע` |
| construct_state | 5 | **GATE** (spec §2.1) | `שמני גוף`/`שמן גוף` |
| final_letter | 5 | informational¹ | `שקדימ`/`שקדים` |
| typo (edit-dist 1) | 10 | informational² | `שדקים`/`שקדים`, `עןר`/`עור` |
| ktiv_variance | 3 | informational (deferred non-goal) | `זהר`/`זוהר` |
| synonym | 5 | semantic layer | `נצנצים`/`שימר` |
| cross_language | 5 | semantic layer | `body oil`/`שמן גוף` |
| hard_negative | 5 | control (expect LOW) | `חלב`/`כלב`, `עור`/`אור` — edit-dist-1 / homophone but unrelated |
| unrelated | 10 | control (expect LOW) | `שמן`/`מגבת` |

¹ final letters are trivially handled by an OpenSearch char_filter (ם→מ …) regardless of embeddings.
² typos can be handled lexically via BM25 `fuzziness` (incl. transpositions); embeddings are a bonus here.

Each pair is embedded and scored with cosine similarity in **two task modes**:
- **symmetric**: both sides `SEMANTIC_SIMILARITY` (the model's designed mode for this test);
- **retrieval**: shopper form as `RETRIEVAL_QUERY` vs catalog form as `RETRIEVAL_DOCUMENT`
  (the asymmetric mode production will actually use).

Embeddings cached to disk; re-runs are free.

### Pass criteria

- **Gate**: plural_singular, prefix, construct_state pairs separate cleanly from the
  `unrelated` controls (high medians, minimal overlap with the control range).
- **Hard negatives** must score LOW — if edit-distance-1 *distinct words* (`חלב`/`כלב`) score as
  high as edit-distance-1 *typos* (`שדקים`/`שקדים`), then typo handling must be lexical
  (fuzzy matching), not embedding-based. This informs Part 2 design, it does not fail the gate.
- If the gate fails → stop; benchmark OpenAI (`text-embedding-3-large`) before proceeding.

### Deliverables

- `benchmark/part1_wordpairs/run_benchmark.py` (stdlib-only, reads `GEMINI_API_KEY` from env or `benchmark/.env`)
- `benchmark/part1_wordpairs/results.json` (raw numbers)
- `specs/pre-build-validation/part1-results.md` (tables + verdict)

---

## Part 2 — End-to-end retrieval benchmark vs native

**Question:** on the identical corpus, does our hybrid engine beat what shoppers actually see
on il.loccitane.com?

### Steps

1. **Ingest catalog** — page through `/products.json?limit=250&page=N`, save raw JSON to
   `benchmark/data/catalog/`.
2. **Native baseline** — for each query, fetch `https://il.loccitane.com/search?q=…&type=product`
   (server-rendered HTML; `type=product` only so both engines rank the same corpus) and parse ranked
   product handles. **Each query 5×** with delays: native non-determinism is documented
   (spec §1 gap 4) — variance is recorded and reported as evidence.
3. **Index in OpenSearch** — one index:
   - BM25 text fields: title, body (HTML-stripped), tags, product_type, vendor, variant titles;
     Hebrew-aware analyzer (final-letter char_filter at minimum).
   - `knn_vector` field: 3072 dims, cosine, HNSW (faiss).
   - One embedding per product from composed text (title + type + tags + cleaned body),
     `task_type=RETRIEVAL_DOCUMENT`. Cached to disk.
4. **Three retrieval modes** (wins must be attributable):
   - **BM25-only** (with `fuzziness=AUTO` variant for typo tier),
   - **kNN-only** (query embedded with `RETRIEVAL_QUERY`),
   - **Hybrid = Reciprocal Rank Fusion** (k=60, fused client-side; transparent, no tuning).
5. **Query battery** — acceptance tiers from specs §5: Baseline, Stemming, Prefixes, Typos,
   Semantic. **Filters tier skipped** (query→filter extraction is a separate feature, not testable
   by retrieval alone — noted in report).
6. **Scoring & report** — per query × engine: top-10 lists, target-in-top-5/top-10, result counts;
   per tier pass/fail vs §5 required outcomes; native variance across the 5 runs.
   Output: `specs/pre-build-validation/part2-results.md`.

### Pass criteria (the build/no-build gate)

- Hybrid **wins Stemming + Typos tiers outright** (relevant results where native returns
  shampoos or zero results), and
- Hybrid reaches **parity on Baseline + Semantic tiers** (anchor product in top-5 where native
  has it).

## Caveats recorded up front

- The live page may include merchant-configured synonyms/boosts (Search & Discovery) — we measure
  "what shoppers see", the right bar for sales demos, not a sterile engine-vs-engine comparison.
- `products.json` exposes only online-store-published products and no metafields — fine for this
  validation; metafield indexing is a later differentiator (spec §3).
- Scrape politely: 4–5 s delays, desktop User-Agent, retries on 429.
- Costs are negligible: a few hundred document embeddings + ~70 word embeddings + ~30 query embeddings.
