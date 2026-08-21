# AI Search for Hebrew Shopify Stores

A Shopify app that replaces the storefront search on a Hebrew store. It fixes
the one thing Shopify's own engine does not do in Hebrew: it matches a plural
query to a singular product.

> **Status: pre-release.** The app runs end to end on a development store. No
> merchant uses it. Two acceptance runs are still open — see [Status](#status).

## The problem

Shopify's native semantic search already works in Hebrew. That part is a
commodity, and this app does not claim it.

Hebrew **morphology** is the real gap. Live testing on a Hebrew store measured
it:

| Query | Native result |
|---|---|
| `שמנים` (oils, plural) | 61 products, and not one body oil. The top hits are shampoos. |
| `שמן` (oil, singular) | 142 products, correct |

Shopify documents its stemming as English and Japanese only. A shopper who
types the plural gets the wrong page.

Three further gaps are documented and deliberately out of v1: typo tolerance,
_ktiv male_ and _ktiv haser_ spelling variance, and non-deterministic result
counts. `specs/specs.md` §1 holds the evidence for all of them.

## How it works

```
Shopify catalog
      │  Bulk Operations ingest, then products/* webhooks
      ▼
  Postgres  ──────────────  OpenSearch 2.12
  sessions,                 one doc per product
  shop config               ├── hebrew_text   analyzer  (lexical leg)
                            ├── hebrew_morph  analyzer  (morphology leg)
                            └── 3072-dim vector          (kNN leg)
                                      ▲
                                      │ Gemini gemini-embedding-001
                                      │
  Storefront ── /apps/search/* ── app proxy ── hybrid search ── RRF fusion
      │                                                          k = 60
      ├── search modal      theme app extension, Shadow DOM
      └── results page      app block on the search template
```

### Hebrew normalization

The OpenSearch analyzer stack runs on both the catalog text and the query.

1. Fold the five final letters: `ך→כ`, `ם→מ`, `ן→נ`, `ף→פ`, `ץ→צ`.
2. Lowercase, for the Latin words that appear in a Hebrew catalog.
3. Emit morphological variants on a second field, `<field>.morph`.

The plain field serves the exact leg. The `.morph` field serves the
morphology leg. A match on the plain field outranks a match on variants.

### Hybrid retrieval

Two legs run in parallel. Each returns 50 candidates.

| Leg | Method |
|---|---|
| Lexical | BM25 over the analyzed fields, with field weights |
| Vector | kNN over the Gemini embedding |

Reciprocal Rank Fusion merges them, with `k = 60`. A lexical gate suppresses
the vector leg when the query has no lexical match at all, so a nonsense query
returns nothing rather than the nearest neighbour.

### The type-ahead budget

A live embedding call takes about 340 ms. That is too slow for a keystroke.

So the suggest endpoint waits **50 ms** for the query vector, then answers
lexical-only. It never cancels the embedding call: the vector lands in an LRU
cache behind the response. Every repeat of that query is then hybrid. The
response carries a `semantic` field, and the client re-fetches once when it
reads `timeout`.

The results page has a looser bound and waits up to 2 seconds.

## Storefront surfaces

The app owns the whole search surface. The theme's own search never opens.

**The search modal.** Document-level capture listeners take over every search
trigger before the theme handles it. The modal is a native `<dialog>` in a
Shadow DOM host. It copies the Horizon theme's search modal.

**The results page.** An app block on the search template, also in Shadow DOM.
It copies the Horizon search results page.

Both read the host theme's font and colours, so they look native on a theme
that is not Horizon. A boot-time probe samples the theme's own background,
text colour, radius and button colour into `--ais-*` tokens.

The design of both comes from a measured capture of a clean Horizon store.
`specs/native-dropdown-parity/reference/` and
`specs/search-results-parity/reference/` hold the numbers and the screenshots.

## Repository layout

| Path | What it holds |
|---|---|
| `app/` | The Shopify app. React Router 7, Prisma, Polaris. |
| `app/app/services/` | Ingest, index, search, embeddings, sync, cron. |
| `app/app/routes/proxy.search*` | The app-proxy endpoints. |
| `app/extensions/ai-search/` | The theme app extension: the modal and the results block. |
| `app/tests/` | Vitest. NLP harness, storefront client, ops. |
| `specs/` | One spec per phase, plus the measured design references. |
| `DEPLOYMENT.md` | The hosting plan. |

## Run it locally

You need Docker, a Shopify Partner account, and Node `>=20.19 <22` or
`>=22.12`. Node 22.0 to 22.11 is excluded — `package.json` states the range.

```bash
cd app
npm install
docker compose up -d          # Postgres and OpenSearch 2.12
cp .env.example .env          # then fill DATABASE_URL and OPENSEARCH_URL
npm run setup                 # prisma generate && prisma migrate deploy
npm run dev                   # shopify app dev
```

Install the app on a development store. Then open the app's Settings page and
paste a Gemini API key. The key is stored per shop.

**Bring-your-own-key is strict.** No shop request falls back to a key in the
environment, because every Gemini call must bill the shop that caused it. The
`GEMINI_API_KEY` in `.env.example` serves the benchmark and latency harnesses
only. A shop with no stored key still gets a working search: the semantic leg
reports `off` and the search stays lexical-only.

Then add the storefront pieces in the theme editor:

1. Turn on the **AI Search** app embed.
2. Add the **AI Search results** app block to the search template.

`app/extensions/ai-search/README.md` covers the merchant steps in full.

## Tests

```bash
cd app
npm test                      # the whole suite
npx vitest run tests/storefront   # the storefront client, under jsdom
npm run lint
npm run typecheck
```

The NLP tests need a local OpenSearch. `tests/nlp/global-setup.ts` starts one
and seeds a frozen corpus, so a run is deterministic and offline.

The corpus itself is **not** in this repository. It is a scraped third-party
catalog, and it also sat beside a live API key. `specs/pre-build-validation/`
carries the measured conclusions it produced.

## Status

| Phase | State |
|---|---|
| 0 — Pre-build validation | Done |
| 1 — App foundation and catalog sync | Done |
| 2 — Hebrew NLP core | Done. Typo tolerance descoped. |
| 3 — Retrieval pipeline | Done |
| 4 — Storefront surfaces | Done |
| 5 — Admin and ops | Admin and ops done. The HTTP regression gate is open. |
| 6 — Horizon-style search modal | Built. The live-store acceptance run is open. |
| 7 — Horizon-style results page | Built. The live-store acceptance run is open. |

## Known limits

These are decisions, not defects. Each one is recorded in the spec that made
it.

| Limit | Why |
|---|---|
| One instance only | The webhook drain and the daily reconcile run as an in-process `setInterval`. A second instance would run both twice. |
| No filters, no sort on the results page | Both need new server work. Filters need OpenSearch aggregations on both legs. |
| The results-page card is a fixed 1:1 | The index holds no image dimensions, so the card cannot follow the image's own ratio. |
| A zero-results page is a dead end | Horizon shows a fallback product grid. The search endpoint returns no second list. |
| Products only | No collections, articles or pages. |
| Shop-currency prices | No Markets or multi-currency handling. |
| The result count can read high on page one | `total` counts fused candidates plus the lexical tail, and the two sets may overlap. It is exact on the last page. |
| No typo tolerance | Descoped from v1. The design is preserved in `specs/hebrew-nlp/phase2-notes.md`. |

Installing this app forfeits native search on the storefront. That is the
design, and `specs/specs.md` §3 states it.

## Documentation

| File | Subject |
|---|---|
| `specs/specs.md` | The product specification and the evidence behind it |
| `specs/task-breakdown.md` | The phases and the estimates |
| `specs/<phase>/spec.md` | One spec per phase |
| `DEPLOYMENT.md` | Hosting |
| `AGENTS.md` | Instructions for coding agents |
