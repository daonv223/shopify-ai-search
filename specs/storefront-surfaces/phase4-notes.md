# Phase 4 build notes — decisions made during tasks 4.1–4.3 (spec §3)

Working log for the decisions `spec.md` left to measurement. Companion to
`spec.md`; harness numbers come from `app/tests/nlp/` against the frozen
499-product corpus with the benchmark's cached vectors.

## A8 / B1 — latency measured (§3.0, 2026-08-18)

Harness: `app/tests/nlp/latency.test.ts`, run with `npm run latency` (single
file, verbose reporter, live legs enabled). The lexical and hybrid-cached legs
also run inside the routine `npm test`, where the lexical p95 < 100ms bar is
asserted; the live-Gemini legs are opt-in (`LATENCY_LIVE=1`) so the suite
never burns API calls or trips over a stale shell key (the key is read from
`benchmark/.env` first — the one the vector cache was built with).

**Method.** All 18 battery queries (every tier — latency depends on query
shape, not on whether a tier is in scope for relevance), `size` 10, hybrid
legs at `LEG_DEPTH` 50 each. Each query runs once unmeasured (warm-up:
client connection, JIT), then 5 reps (live legs: 3 reps, to stay clear of
Gemini rate limits — a 429 retry inside the provider would surface as a
multi-second outlier, so `max` is reported next to p95). Wall-clock in the
Node process (`performance.now()`), i.e. server-side as the app sees it:
includes the OpenSearch HTTP round trip on localhost, excludes the app-proxy
hop.

| mode | what it measures | n | p50 | p95 | max | mean |
|---|---|---|---|---|---|---|
| lexical | `lexicalSearch` — lexical-only floor (type-ahead fallback) | 90 | 8.1 | **11.2** | 15.9 | 7.6 |
| hybrid-cached | `hybridSearchWithVector` with a cached query vector — OpenSearch fusion cost alone (lexical ‖ kNN legs + RRF) | 90 | 36.3 | **44.9** | 143.7 | 38.6 |
| embed-live | `embedQuery` — one Gemini `batchEmbedContents` round trip | 54 | 384.1 | **409.4** | 460.6 | 385.9 |
| hybrid-live | `embedQuery` → `hybridSearchWithVector` — A8 as Phase 3 defined it, `hybridSearch()`'s exact code path, timed in two segments so one Gemini call yields both rows | 54 | 455.1 | **486.8** | 542.6 | 459.0 |

Three consecutive runs agree; run-to-run p95 ranges: lexical 11–16ms,
hybrid-cached 45–55ms, embed-live 409–450ms, hybrid-live 487–512ms. The
143.7ms hybrid-cached max is a single sample (p95 unaffected). Slowest
queries by p50 are two-token Hebrew (`שמני גוף`, `שמן לגוף`, `נצנצים לגוף`)
in both OpenSearch legs — a few ms of spread, nothing structural.

Environment: Apple M1 Pro / 16 GB, Node 24.16, OpenSearch 2.12 single node
in Docker on the same machine, 499 docs with 3072-dim vectors; measured from
the dev machine (Vietnam), TCP RTT to `generativelanguage.googleapis.com`
≈ 60ms.

**Where the ~400ms embedding round trip goes** (curl timing against the same
endpoint): fresh connection — connect 60ms, TLS done at ~145ms; a keyed
single-text embed request on a *reused* connection — time-to-first-byte
345–375ms, plus ~40ms to stream the 3072-float JSON body ≈ 390–410ms, which
is exactly what the harness sees (Node's fetch keeps the connection alive).
So ≈ 300ms+ of the round trip is API-side processing, not network: hosting
the app next to Google would shave the 60ms RTT and no more. **The
practical floor for a live Gemini query embedding is ~340ms.**

Observation, not decision-relevant: fusion after a live embed costs ~70ms
(hybrid-live − embed-live) versus ~37ms back-to-back with cached vectors —
the 400ms idle gaps between OpenSearch calls cool something (JIT/GC/OS
caches); still well inside any budget.

### B1 verdict

- **Lexical p95 11–16ms < 100ms — PASS.** No Phase 3 bug to fix; the
  type-ahead's lexical fallback has ~85ms of headroom.
- **Hybrid-live p95 487–512ms** — the spec's "500ms+" branch, not the
  "under ~250ms" one.

### Type-ahead contract decided: option 3, with the timeout set by the budget

The bounded-semantic mechanism ships as designed (hybrid pipeline + query
embedding LRU + hard timeout on the embedding call, lexical-only on timeout),
but the numbers force the honest reading the spec asked for:

- **The suggest budget is 100ms server-side (task 4.1); fusion after the
  vector is in hand costs ~45ms p95; so the embedding must land within ~50ms
  to be fused inside budget → embedding timeout = 50ms.** Any timeout that
  respects the budget is far below the ~340ms floor of a live Gemini call, so
  **on a cold cache every keystroke is lexical-only, by construction**. There
  is no timeout value between "always lexical" and "always ~500ms" that buys
  a partial win — the embed-live distribution is tight (p50 384 / p95 409 /
  max 461ms), not long-tailed. We are not going to spend ~500ms per keystroke
  (plus the app-proxy hop and the 150ms debounce, ≈ 0.8–1s to first
  suggestion) on a type-ahead when native answers in a few hundred.
- **What the type-ahead's semantic leg therefore rests on is the cache**, so
  open question 2 moves up as the spec predicted. Two mechanisms make the
  cache do real work, both cheap and both inside 4.1/4.2's scope:
  1. **Fire-and-cache.** On timeout the endpoint answers lexical-only but
     does *not* abort the in-flight embedding; when it lands (~400ms later)
     it is written to the LRU. Consequences: (a) the shopper's *settled*
     query — the one they press Enter on — is warm by the time the results
     page asks for it, so `/results` runs the full hybrid in ~45ms instead
     of ~490ms; (b) any repeat of a query (same shopper backspacing, other
     shoppers, popular queries) is hybrid within budget (warm p95 45–55ms —
     B4's "warm p95 < 100ms" holds with room).
  2. **One-shot upgrade re-fetch (task 4.2).** The suggest response says
     whether the semantic leg ran (`semantic: "cached" | "live" | "timeout"
     | "skipped" | "off"`, alongside `gated`); when it reports `timeout` and the input
     is unchanged ~500ms later, the dropdown re-requests once and swaps in
     the hybrid ranking from the now-warm cache. Net effect: lexical
     suggestions at ~50ms after the debounce, upgraded to hybrid ~half a
     second later for a query the shopper is still looking at — the §2.5
     promise kept for settled queries, never at the cost of first paint.
- The results page (`/results`) has no such budget: it waits for the
  embedding (bounded only by a generous resilience timeout, e.g. 2s, falling
  back to lexical with a log line) — the §1 demo (`שמנים` → Enter → body
  oils) runs the full pipeline regardless of cache state.
- What this does to the B4 numbers: cold suggest p95 ≈ timeout (50ms) +
  lexical tail ≈ 55–65ms; warm ≈ 45–55ms; both under 100ms. Cost: each
  keystroke whose trailing token is ≥ 3 chars fires one embed call
  (`שמן לגוף` typed straight through ≈ 3 calls, the <3-char prefix rule and
  the debounce absorb the rest); cost/rate guards stay Phase 5.3.
- **Ways out that are *not* v1** (recorded for open question 2 / Phase 5):
  a shared Redis LRU once there is more than one app instance (the in-process
  cache is what makes fire-and-cache work across a shopper's own keystrokes
  and the results-page hand-off — that survives multi-instance only with
  sticky routing or a shared tier); a smaller/faster embedding path (Gemini's
  latency is API-bound, so only a local or lighter model, or a precomputed
  table of popular-query vectors, gets a *cold* semantic keystroke under
  100ms). Not pursued in Phase 4.

Carried into 4.1: `EMBED_TIMEOUT_MS = 50` for `/suggest`, fire-and-cache on
the LRU, `semantic` field in the response and in the timing log line; into
4.2: the one-shot upgrade re-fetch. B4 re-measures both cold and warm through
the HTTP endpoint once 4.1 lands.

## 3.1 — Search API endpoints (task 4.1, 2026-08-18)

Shipped: `app/app/services/storefront-search.server.ts` (one service, two
surfaces), `query-embedding.server.ts` (LRU + bounded wait + fire-and-cache),
`proxy-context.server.ts` (signature → shop → alias), `results-page.server.ts`
(Liquid fallback markup), routes `proxy.search_.suggest.tsx`,
`proxy.search_.results.tsx`, `proxy.search.tsx` (the Phase 1 echo stub is
gone). Type-ahead support in the lexical leg (`search.server.ts`,
`typeahead: true`) and per-surface depth / lexical-only path in the fusion
(`hybrid-search.server.ts`). Tests: `tests/nlp/surface.test.ts` (B2, B3,
hygiene, pagination, empty state, Liquid page — 29 tests through the route
loaders with app-proxy-signed requests), B4 in `latency.test.ts`.

### Transport facts that differ from the spec text

- Unsigned / tampered → **400**, not 401: that is what
  `authenticate.public.appProxy` throws (`InvalidHmacError` → 400 Bad
  Request). Left as-is; the spec row is corrected. Unknown or uninstalled
  shop → 404 JSON. The shop is taken from the signed `shop` param, not from
  an offline session (which may legitimately be absent).
- The proxy Liquid helper rewrites relative hrefs to a trailing-slash form
  (`/search?q=` → `/search/?q=`); harmless on Shopify, noted for the tests.

### Type-ahead lexical query — what "prefix on the last token" turned into

The spec's `bool_prefix` clause was the starting point; four measured
problems (all on the frozen corpus, `surface.test.ts` B3) shaped what
shipped:

1. **`שמ` returned eight perfumes.** Not via the prefix at all — via the
   *morph* clause: the multiplexer over-strips the tag `בשמים` (ב- prefix,
   -ים suffix) to the 2-letter stem `שמ`, a rare stem with high IDF, so
   EDTs BM25-outscored every oil and shampoo. **Guard: a trailing token
   shorter than 3 chars is dropped from the morph clause** (exact and prefix
   still apply). Two-letter stems are noise; every second keystroke is a
   two-letter token.
2. **`bool_prefix` scores the prefix as a constant**, so the 58 titles with
   a `שמן`/`שמפו`/`שמנים` word tied and index order picked the top 8.
   Replaced by a raw `prefix` per field on the app-side normalized last
   token (lowercase + final-letter folding, mirroring `hebrew_text`) with
   `rewrite: top_terms_blended_freqs_100`: expansions are BM25-scored with
   one blended document frequency — ties break on tf/title length, but three
   rare `ג…` words in a gel title cannot outvote an exact `שמן` in an oil's
   title (which `scoring_boolean`'s per-term IDF sum did on `שמן ג`), and N
   bounds the clause count for one-letter prefixes at any catalog size.
3. **How the prefix combines with the other clauses.** A plain additive
   should-clause double-counts a fully typed last token — conditioners tagged
   `שמנים` fired exact_high + prefix and pushed morph-matched `שמן` oils to
   rank 8 on `שמנים` (the demo query); a dis_max sibling loses cross-token
   evidence (a `ג'ל…` title tied an oil matching both `שמני` and `ג`); a
   tie_breaker brings same-token stacking back. What works: a **strict**
   prefix (`must: prefix`, `must_not: term` on the same field) as an
   additive should-clause next to the untouched Phase 3 dis_max — it only
   carries evidence the core cannot (a longer word than the typed token),
   never restates an exact match. Every full in-scope battery query has its
   ground truth at rank ≤ 2 through `/suggest`.
4. **Hebrew clitic on a partial token.** The analyzer strips ל/ב/… only from
   complete words (≥3 letters after the clitic), so `שמן לגו` had no
   evidence toward `גוף` and literal-`לגוף` balms filled the top 8. A
   **half-weight second prefix variant with the clitic stripped** (`לגו` →
   `גו`, `לג` → `ג`, permissive: any letter after it) fixed `שמן לגו`
   (0/8 → 3/5) and `שמן לג` (0/8 → 2/5) without moving anything else; the
   false-clitic noise (`שמנ` → `מנ…`) stays at tie-break level under blended
   frequencies.

Also: prefix fields are the bare high-signal set (title/tags/product_type/
vendor at exact_high weights) plus **body at weight 1 once the token has
≥ 3 chars** — `מראה` (A5d) lives only in body copy and must still type-ahead
(`מרא` 0/8 → 3/8). A prefix hit counts as high-signal exact for the gate,
otherwise `שמנ` (zero literal matches) would drop the only leg that can
answer a half-typed word.

**B3 measured (cold path — no vector for a truncated form, embedder off —
i.e. exactly what a keystroke gets), hit count in top 5 / top 8, first
rank of a positive:**

| tier | query → form | @5 | @8 | first | note |
|---|---|---|---|---|---|
| baseline | שמן גוף → שמן גו / שמן ג | 5 / 3 | 6 / 4 | 1 / 1 | |
| baseline | שימר → שימ / שי | 1 / 0 | 1 / 0 | 2 / — | `שי` = shea (שיאה) as much as shimmer; 2 positives |
| baseline | שקדים → שקדי / שקד | 5 / 5 | 8 / 8 | 1 / 1 | |
| stemming | שקד → שק / ש | 5 / 5 | 8 / 6 | 1 / 1 | |
| stemming | שמנים → שמני / שמנ | 2 / 4 | 2 / 7 | 1 / 1 | |
| stemming | שמני גוף → שמני גו / שמני ג | 5 / 3 | 6 / 4 | 1 / 1 | |
| prefixes | מראה → מרא / מר | 0 / 0 | 3 / 0 | 6 / — | body-only concept; 2-letter fragment |
| prefixes | שמן לגוף → שמן לגו / שמן לג | 3 / 2 | 4 / 3 | 2 / 3 | clitic variant |
| prefixes | בשמן → בשמ / בש | 0 / 0 | 0 / 0 | — / — | `בשמ…` = בשמים (perfumes) — a legitimate completion |
| prefixes | השמן → השמ / הש | 1 / 0 | 4 / 1 | 3 / 7 | |
| prefixes | ושקדים → ושקדי / ושקד | 5 / 5 | 8 / 8 | 1 / 1 | |
| semantic | נצנצים לגוף → …לגו / …לג | 1 / 1 | 1 / 1 | 1 / 1 | 2 positives |
| semantic | ברק לעור → ברק לעו / ברק לע | 2 / 1 | 3 / 1 | 2 / 4 | |
| semantic | body oil → body oi / body o | 0 / 0 | 0 / 0 | — / — | cold lexical-only: `oil` prefix meets `oils` in haircare titles; the upgrade re-fetch (4.2) brings the gated kNN ranking |

**Bar set from this** (pinned in `surface.test.ts`): ground truth in the
top 5 for every truncated form of a Baseline/Stemming query except a form
that is a single token of < 3 letters (`שי`) — such a fragment is too short
to reason about, and the spec's own partial-token rule already treats it
that way; no truncated form of any in-scope query returns zero hits; the
prefixes/semantic forms that hit (`שמן לגו`, `שמן לג`, `השמ`, `מרא`, `ברק
לעו`, `ברק לע`, `נצנצים לגו/לג`) are pinned at top-8 as regression guards;
`שמ` and `שמני ג` surface body oils; `שמ` never surfaces an EDT.

### Empty state: the semantic-anchor floor

kNN always returns k neighbours, so a gated query (zero lexical exact
matches) could never be empty — `זזזז` would show 50 products, and B6
requires an empty state. Probed on the frozen corpus with live
gemini-embedding-001 vectors (faiss innerproduct score = 1 + cosine, top-1
of the kNN leg):

| query | lexical hits / exact | kNN top-1 | top-5 | #50 |
|---|---|---|---|---|
| זזזז | 0 / 0 | 1.682 | 1.680 | 1.668 |
| asdfgh | 0 / 0 | 1.636 | 1.632 | 1.619 |
| מקדחה חשמלית (drill) | 0 / 0 | 1.625 | 1.614 | 1.594 |
| טלפון סלולרי | 9 / 0 | 1.645 | 1.631 | 1.620 |
| אבגד | 0 / 0 | 1.660 | 1.655 | 1.639 |
| body oil | 0 / 0 | **1.706** | 1.700 | 1.656 |
| moisturizer | 0 / 0 | 1.703 | 1.691 | 1.668 |
| shampoo | 0 / 0 | 1.708 | 1.698 | 1.651 |
| נצנצים לגוף | 50 / 12 | 1.743 | 1.705 | 1.676 |
| ברק לעור | 50 / 34 | 1.732 | 1.712 | 1.681 |
| שמנים | 50 / 28 | 1.737 | 1.724 | 1.701 |
| מראה | 50 / 41 | 1.675 | — | — |

Junk / out-of-catalog tops out at 1.682; real semantic queries start at
1.703. **`KNN_ANCHOR_MIN_SCORE = 1.69`, applied to the kNN top-1 only, and
only when the lexical leg is gated**: a per-hit floor would cut real recall
(`body oil`'s own top-10 dips to 1.683, its #50 is junk-level — that is
what depth-50 legs look like), and an un-gated query has lexical proof it
belongs to the catalog (`מראה` tops at 1.675 and must not be touched). The
gap is 0.02 — narrow — so `knn_top` is in every timing log line for
re-calibration on real traffic, and the constant is documented as such. On
the battery the only casualty is `עןר` (typo tier, descoped): gated, top-1
1.687 → empty rather than 50 random products, which is the right answer for
a typo we don't correct. `שדקים` (also a typo) is gated but anchored at
1.709 — the kNN leg quietly rescues it.

### Results pagination and the lexical tail

`/results` fuses at depth 50/50 and returns the whole fused list (≤ 100);
page N is a slice. Beyond it, lexical ranks > 50 are appended, always
fetched from the same offset (`from: 50`) with 50 of dedup slack so paging
is stable and duplicate-free (asserted across all pages of `שמנים`, > 100
distinct handles, never a blank page until `has_more` is false). No tail
when the lexical leg is gated (its hits are the noise the gate exists for)
or the query has no semantic anchor. `total` is an upper bound (fused +
lexical total beyond depth, overlap not subtracted) — exact once `has_more`
is false; the grid should say "N+" or "results" rather than a hard count
until then. Known consequence (open question 4): the fused list's tail is
kNN's depth-50 neighbourhood, so a lexical query like `שקדים` shows its 46
almond products and then semantically-nearby non-almond ones before the
lexical tail — "related products" behaviour, acceptable for v1, revisit
with the 10k scale test.

### B4 measured — suggest budget through the surface

Through `suggest()` (partial-token rule, bounded wait, depth-20 fusion, one
timing line), minus the app-proxy hop, 18 queries × 5 reps (cold: 3 reps,
LRU cleared before every call, live Gemini):

| mode | p50 | p95 | max |
|---|---|---|---|
| suggest, warm LRU | 16.8 | **22.6** | 23.7 |
| suggest, cold LRU (live) | 51.7 | **52.8** | 54.9 |

Cold is bounded by the timeout as designed: **54/54 cold keystrokes were
lexical-only, 0 embedded in time**, and the vectors were in the LRU after
settling (fire-and-cache verified). A first cut had cold at p95 89.6ms
because the surface waited out the timeout and *then* ran the lexical leg;
the leg now starts before the embedding wait (`HybridOptions.lexical`), so
cold costs max(50ms, lexical) — the number is the timeout. Warm is under
half the budget; depth-20 fusion (22.6) is cheaper than the results page's
depth-50 (44).

### Response contract as shipped

`GET /apps/search/suggest?q=&limit=` → `{ query, hits[], total, gated,
semantic, took_ms }` (limit ≤ 8, default 6). `GET /apps/search/results?q=&
page=&limit=` → the same plus `page, limit, has_more` (limit ≤ 48, default
24). `GET /apps/search?q=&page=` → `application/liquid` inside the theme
layout: grid with `{{ N | money }}` prices, availability badge, prev/next
links that work without JS, `data-ai-search-*` hooks for 4.3, empty state
and error state both linking to native `/search`; every interpolated string
is HTML-escaped and `{`/`}`-neutralized so a product title can never open a
Liquid tag. `Cache-Control: private, max-age=0` on all three. Timing line
per request: `{evt:"search", surface, shop, q_len, gated, semantic, knn_top,
anchored, hits, total, ms}`.

### Follow-ups recorded

- `body oil` in the dropdown is haircare on a cold cache (lexical `oil` →
  `oils`) until the 4.2 upgrade re-fetch swaps in the gated kNN ranking —
  B5 must verify the upgrade, not just first paint.
- The B4 numbers exclude the Shopify app-proxy hop; re-measure from the
  dev store once 4.2 wires the dropdown (browser timing).
- Anchor floor and the prefix rewrite's N are constants calibrated on 499
  products; both are logged/observable and revisit with the scale test.
- Redis for the LRU stays open question 2; the in-process cache is what
  makes fire-and-cache reach the results page — multi-instance needs a
  shared tier or sticky routing.
