# Phase 4 Spec — Storefront Surfaces

> Phase 4 of `specs/task-breakdown.md` (~10 days). Inputs: `specs/specs.md`
> §2.5 (predictive search — the full pipeline on the type-ahead), §3
> (replacement, not augmentation; RTL for the UI we ship), §5 (acceptance
> tiers); the Phase 3 search services now live in
> `app/app/services/search.server.ts` (lexical) and
> `hybrid-search.server.ts` (`hybridSearch` / `hybridSearchWithVector`,
> RRF k=60 over depth-50 legs, zero-exact-match gate); the Phase 1 app-proxy
> stub in `app/app/routes/proxy.search.tsx` (`/apps/search` →
> `/proxy/search`, signature-verified by `authenticate.public.appProxy`);
> and `specs/retrieval-pipeline/architecture-review.md` finding 4 (choose
> the predictive-search latency contract *before* building the endpoint).
> Phase 3 left A8 (hybrid latency incl. query embedding) **unmeasured** —
> this phase measures it first, because the type-ahead contract depends on it.

## 1. Goal

Put the engine in front of shoppers. At the end of this phase a Hebrew store
with the app installed gets (a) a type-ahead dropdown that runs our pipeline
instead of Shopify's, and (b) a search results page fed by our hybrid
ranking, both RTL-correct, both wired through a theme app extension so a
merchant can turn them on from the theme editor without touching code.

**Definition of done:** on the dev store running Dawn, type `שמנים` into the
theme's search box → our dropdown shows body oils within the type-ahead
budget; press Enter → the results page shows body oils, not shampoos (the
§1 sales-demo screenshot, live). The full §5 tier battery passes **through
the HTTP endpoint** (not just the service), and the fallback path renders on
a non-OS 2.0 theme.

### A note on what "override native search" actually means

Shopify does not let an app replace the `/search` route or the
`/search/suggest` predictive endpoint. Every third-party search app does the
same thing: ship storefront JavaScript (a theme app extension) that
intercepts the theme's search input and search form, and renders results
fetched from the app's own endpoint (our app proxy). "Override" is
client-side interception plus hiding the theme's native results — this is
why `specs.md` §3 says installing the app forfeits native search entirely.
The mechanics differ by theme generation, hence "OS 2.0 + one fallback path"
in the task note.

## 2. Decisions carried in / made here

| Decision | Choice | Why |
|---|---|---|
| Transport | **App proxy** under `/apps/search/*`, JSON responses, signature verified by `authenticate.public.appProxy` (already wired, Phase 1 A7). Shop → alias via the shop row's `indexAlias`. | Same-origin from the storefront (no CORS, no exposed app URL, no token in the browser). Sub-paths are forwarded, so `/apps/search/suggest` → `/proxy/search/suggest`. |
| Type-ahead contract (arch review #4) | **Option 3 — bounded semantic**: the suggest endpoint runs the hybrid pipeline with a query-embedding LRU cache and a **hard timeout on the embedding call**; on timeout it answers lexical-only for that keystroke. Decided provisionally; **A8 numbers confirm or overturn it in the first two days** (see §3.0). **Decided 2026-08-18** (`phase4-notes.md`): lexical p95 11–16ms, hybrid-live p95 487–512ms with a ~340ms floor on the Gemini round trip → option 3 ships with a **50ms** embedding timeout (budget-derived), so cold keystrokes are lexical-only by construction; the semantic leg on the type-ahead rests on the LRU (fire-and-cache + a one-shot client upgrade re-fetch), the results page waits for the embedding. | Keeps the §2.5 promise (full pipeline on the type-ahead) where native has no semantic layer, without letting a slow Gemini round trip blow the budget. Option 1 (lexical-only type-ahead) breaks the spec promise; option 2 (debounce only) has no bound. |
| Partial-token handling | The **trailing token of a type-ahead query is a prefix**: the suggest lexical query adds a prefix clause on the bare high-signal fields (`title`, `tags`, `product_type`, `vendor`) for the last token. Results-page query is unchanged. The kNN leg is skipped when the last token is <3 chars or the query is a single partial token (embedding half a word is noise). *As built (2026-08-18, `phase4-notes.md` §3.1): a strict raw `prefix` per field (`must_not` the literal term) with `top_terms_blended_freqs` scoring, additive to the Phase 3 dis_max; a half-weight clitic-stripped variant; body joins at weight 1 from 3 chars; the morph clause drops a trailing token under 3 chars. `bool_prefix` was measured and replaced — see the notes for the four failure cases.* | Phase 3's `lexicalQuery` is `multi_match` bare+morph — no prefix matching, so `שמ` never meets `שמן`. Native predictive search does prefix-match; we can't ship a type-ahead that doesn't. Morphology on a partial token is unreliable, so the prefix clause is bare-field only. |
| Surfaces | Two endpoints, one service: `suggest` (≤8 products + "show all" link, small payload) and `results` (paginated grid). Fusion depth is a **per-surface parameter** (suggest: depth 20/20; results: 50/50 = `LEG_DEPTH` today, tunable). | Different latency budgets and result counts; one `hybridSearch` behind both. |
| Theme integration | **Theme app extension** with an *app embed block* (JS + CSS, loaded on every page, intercepts search inputs/forms) and an *app block* ("AI Search results") the merchant adds to the search template. **Fallback for vintage themes**: proxy-rendered `application/liquid` page at `/apps/search?q=` inside the theme layout, with the embed rewriting the theme's search form action to point at it. | OS 2.0 JSON templates accept app blocks in the search template — the merchant-managed, no-code path. Vintage themes have no app-block slot; the app-proxy Liquid page is the standard fallback. Assets are served from Shopify's CDN. |
| UI isolation | Dropdown and grid render inside **Shadow DOM**, `dir="rtl"`, logical CSS properties only (`inline-start`, `margin-inline`), theme font inherited via CSS custom properties. | Theme CSS is hostile; RTL correctness must not depend on the theme having `dir` set. |
| Applied-filter UI (task 4.3 wording) | **Dropped** — there is nothing to apply since query→filter extraction was descoped (`specs.md` §2.3). Facets in general: see open question 1. | Task breakdown wording predates the 2026-08-16 descope. |

## 3. Scope

### 3.0 A8 first (day 1–2, inside 4.1's budget)

- Add a latency harness (`app/tests/nlp/latency.test.ts` or a script) that
  runs the §5 battery through `lexicalSearch`, `hybridSearchWithVector`
  (cached vectors → measures OpenSearch fusion cost alone) and `hybridSearch`
  (live Gemini → measures embedding round trip), reporting p50/p95.
- Record the numbers in `specs/storefront-surfaces/phase4-notes.md` and
  **decide the type-ahead contract on them**:
  - lexical p95 must be <100ms server-side (task 4.1 budget) — if not, that
    is a Phase 3 bug to fix before anything else;
  - if live-embedding hybrid p95 lands under ~250ms, the bounded-semantic
    contract ships with a generous timeout (~200ms); if it is 500ms+, the
    timeout tightens and most keystrokes will be lexical-only in practice —
    still option 3, but the notes must say so honestly, and open question 2
    (embedding cache tier) moves up.

### 3.1 Search API endpoint (task 4.1 · 2d)

- Routes (React Router 7 resource routes, no UI):
  - `GET /proxy/search/suggest?q=&limit=` → `{ query, hits: [{handle, title, url, image_url, image_alt, price_min, price_max, available}], total, gated, took_ms }` — `limit` capped at 8.
  - `GET /proxy/search/results?q=&page=&limit=` → same hit shape, paginated (`limit` ≤ 48, `page` 1-based, `has_more`). Page N slices the fused list; beyond fusion depth the endpoint appends the lexical tail rather than returning nothing.
  - `GET /proxy/search?q=` → the vintage-theme fallback page (`Content-Type: application/liquid`), server-renders the results grid markup and hands off to the same JS for pagination. Replaces the Phase 1 echo stub.
- Input hygiene: trim, cap `q` at 200 chars, reject empty with `200 { hits: [] }` (not 4xx — the dropdown polls constantly). Unsigned/invalid signature → **400** (what `authenticate.public.appProxy` actually throws — the Phase 1 "401" wording was imprecise); unknown/uninstalled shop → 404.
- Query-embedding **LRU cache** in-process, keyed by the normalized query
  string (embeddings are shop-independent), with the embedding timeout from
  §3.0 — **decided 2026-08-18 (`phase4-notes.md`): `suggest` waits at most
  50ms for the embedding** (budget-derived; a live Gemini call never lands
  in time, so cold keystrokes are lexical-only), **`results` waits up to
  2s** (resilience bound only, lexical fallback + log line on expiry). The
  embedding call is **never aborted on timeout — fire-and-cache**: it lands
  in the LRU so the settled query's results page and every repeat are
  hybrid within budget. Every response carries `semantic: "cached" | "live"
  | "timeout" | "skipped" | "off"` (LRU hit / embedded in time / fired but
  timed out — client may re-fetch once to upgrade / kNN skipped by the
  partial-token rule / no provider or embedding error). Redis-backed cache
  is Phase 5.3 if A8 says it's needed.
- Response headers: `Cache-Control: private, max-age=0` for now (per-shop
  data through a shared proxy path; revisit public caching in 5.3).
- Latency: `took_ms` in every response and a server-side timing log line
  per request (`surface`, `shop`, `gated`, embed cache hit/miss, ms) — the
  observability Phase 5.3 builds on.

### 3.2 Predictive type-ahead dropdown (task 4.2 · 4d)

- Theme app extension scaffold (`shopify app generate extension --type
  theme_app_extension`, lands in `app/extensions/`), with the **app embed
  block** loading `ai-search.js` + `ai-search.css`.
- Interception: find the theme's search inputs (`form[action*="/search"]
  input[name="q"]`, plus Dawn's `<predictive-search>` element), suppress the
  theme's native predictive dropdown, and mount ours anchored to the input.
  Selector overrides exposed as embed settings for stubborn themes.
- Behaviour: debounce ~150ms, `AbortController` on every keystroke, min 1
  Hebrew char, results as image + title + price (formatted with
  `Shopify.currency` / `Intl.NumberFormat`), a "show all results for *q*"
  row that submits to the results page, Escape closes, ArrowUp/Down + Enter
  navigate, `role="combobox"`/`listbox` ARIA, click-outside closes.
- RTL-correct in Shadow DOM (see §2), works on mobile (drawer/overlay
  search patterns in Dawn), no layout shift on the host page.
- Settings surfaced in the theme editor: enable/disable, max suggestions,
  show prices, selector overrides.

### 3.3 Results page + theme wiring (task 4.3 · 4d)

- **App block** "AI Search results" (`blocks/results.liquid`) for the search
  template: reads `q` from the URL, fetches `/apps/search/results`, renders
  an RTL product grid (image, title, price, availability badge, link),
  "load more" pagination, empty state, and an error state that falls back to
  a plain link to native `/search` (never a blank page).
- Native-results suppression: the embed hides the theme's main search
  section on `/search` when our block is present (default selector covers
  Dawn's `main-search`; overridable). Document the merchant steps: add the
  app block to the search template, enable the app embed.
- **Fallback path** (vintage themes): the embed rewrites
  `form[action*="/search"]` to `/apps/search`; the proxy Liquid page from
  §3.1 renders inside the theme layout. Verified on one non-OS 2.0 theme.
- Merchant-facing setup notes go into the embedded admin in Phase 5.1; this
  phase writes them as a README section in the extension.

**Suggested build order**: 3.0 → 3.1 (endpoints, incl. the prefix clause and
its harness tests) → 3.2 and 3.3 in parallel (both consume the endpoints).
Extend the harness before each piece, red-to-green, per the Phase 2/3
pattern.

## 4. Non-goals (Phase 4)

- Facets / filter sidebar on the results page — open question 1; not built
  here unless that question is answered "yes" and pulled in.
- Sorting other than relevance (price/newest) — Phase 5.1 if at all.
- Search analytics (queries, zero-result log, click-through) — Phase 5.
- Synonym & boost admin, embedded-admin setup UI — Phase 5.1.
- Rate limiting, Redis cache, cost guards, structured error reporting —
  Phase 5.3 (this phase logs timings only).
- Collection/article/page search — products only.
- Multi-currency / Markets pricing — `price_min/max` are shop-currency;
  displayed as such.
- Typo tolerance, query→filter extraction — descoped from v1.

## 5. Acceptance tests

Harness/vitest against local OpenSearch with the frozen 499-product corpus
and cached vectors, plus manual verification on the dev store (Dawn) and one
vintage theme. B1–B4 automated; B5–B8 manual with screenshots in
`phase4-notes.md`.

| # | Test | Required outcome |
|---|---|---|
| B1 | A8 measured (§3.0): lexical / hybrid-cached / hybrid-live p50/p95 over the §5 battery | Numbers recorded in `phase4-notes.md`; lexical p95 <100ms; type-ahead timeout chosen from the hybrid-live number |
| B2 | Endpoint parity: full §5 tier battery through `GET /proxy/search/results` (signed request, test-signed with the app secret) | Same hit@10 as the Phase 3 service tests (A3/A4/A5 bars hold through the transport); unsigned → 401; empty `q` → `200 { hits: [] }` |
| B3 | Prefix type-ahead: for each §5 query, the query truncated by its final 1–2 characters through `/suggest` | Ground-truth product in the top 5 for the truncated forms of Baseline/Stemming queries; **no** truncated form returns zero hits when the full query has hits. `שמ` and `שמני ג` surface body oils. Measured hit@5 recorded; bar tightened after first measurement. **Measured 2026-08-18** (`phase4-notes.md` §3.1 table): bar = top-5 for every Baseline/Stemming form except a single-token fragment of < 3 letters (`שי`); prefixes/semantic forms pinned at their measured top-8; full queries at rank ≤ 2 through `/suggest`. Automated in `surface.test.ts` |
| B4 | Suggest budget: `/suggest` p95 over the battery, embedding cache cold and warm | Cold p95 ≤ chosen timeout + lexical p95 (i.e. the timeout actually bounds it); warm p95 <100ms server-side. **Measured 2026-08-18** (`latency.test.ts`, minus the app-proxy hop): cold p95 52.8ms (54/54 keystrokes lexical-only, vectors landed in the LRU behind them), warm p95 22.6ms |
| B5 | Dropdown on Dawn (desktop + mobile drawer): `שמנים`, `שמן לגוף`, `body oil` | Native dropdown suppressed; ours renders RTL-correct with images/prices; keyboard nav works; `שמנים` shows body oils, not shampoos. *Status 2026-08-18: mechanics automated under jsdom (`tests/storefront/ai-search-client.test.ts`); live Dawn check pending — needs `shopify app dev --store-password` (see notes §3.2/3.3)* |
| B6 | Results page on Dawn via app block: `/search?q=שמנים`, `נצנצים לגוף`, `זזזז` (no results) | Native section hidden; grid shows the same top hits as B2; empty state renders; error state (endpoint down) shows the native-search link, never blank |
| B7 | Fallback path on a vintage theme | Search form submits to `/apps/search?q=`; Liquid page renders inside the theme layout, RTL, paginates |
| B8 | Sales demo: `שמנים` on the dev store, dropdown + results page | Screenshot-ready — the §1 headline gap, live |

## 6. Open questions (carry forward, non-blocking)

1. **Facets on the results page.** Replacing native results also removes
   Shopify's Search & Discovery storefront filters (availability, price,
   vendor, options), which many Hebrew stores rely on. The mapping already
   has the keyword facet fields (`option_facets`, `vendor`, `product_type`,
   `price_min/max`, `available`), so an aggregation-driven sidebar is
   feasible — but it's ~3–4d and not in the 4.3 budget. Recommendation:
   ship v1 without, but confirm with the first pilot merchant before launch;
   if it's a blocker it becomes 4.4 or the first Phase 5.1 item.
2. **Embedding cache tier.** In-process LRU is fine for one app instance;
   under multiple instances / a real merchant's query volume the hit rate
   collapses. Decide Redis vs. nothing with A8 + first traffic in 5.3.
3. **Publication visibility.** Ingest pulls `status:active` products
   (`ingest.server.ts`) but does not check Online Store publication —
   active-but-unpublished products (or products published only to POS)
   would appear in results the moment this phase ships. Needs
   `read_publications` + a `published_online_store` flag on the doc and a
   filter on both legs — small, but a Phase 1 change; do it before the pilot
   merchant, ideally inside this phase's 4.1 if time allows.
4. **Fusion depth vs. results-page pagination.** Depth-50 legs mean at most
   ~100 fused hits; the lexical-tail append (§3.1) covers deeper pages but
   those results are un-fused. Fine for v1; revisit with the 10k-product
   scale test the architecture review asks for (finding 5).
