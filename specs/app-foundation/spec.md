# Phase 1 Spec — App Foundation & Catalog Sync

> Phase 1 of `specs/task-breakdown.md` (~9 days). Inputs: `specs/specs.md` §3
> (architecture constraints, indexing scope) and the Phase 0 verdict in
> `specs/pre-build-validation/part2-results.md` (**gate passed — build the
> replacement engine** on OpenSearch + Gemini `gemini-embedding-001`).

## 1. Goal

A production-shaped Shopify app that keeps a complete, always-fresh copy of a
store's catalog in a search index that can serve lexical, vector, and facet
queries from one place. At the end of this phase there is **no search UX and no
Hebrew NLP yet** — the deliverable is the foundation the later phases index
into: install flow, full ingest, incremental sync, and the index schema.

**Definition of done:** install the app on a dev store and press "Sync All
Catalog" → full catalog appears in OpenSearch; edit/create/delete a product in admin → the index reflects it
within seconds; only products whose *searchable text* actually changed are
marked for re-embedding.

## 2. Decisions carried in from Phase 0

These were open questions in the task breakdown; the benchmark settled them.

| Decision | Choice | Why |
|---|---|---|
| Index storage (task 1.4) | **OpenSearch** (≥2.12), single engine for BM25 + kNN + facet filtering | Exactly the setup the Phase 0 gate was passed on (87% vs native 59% hit@10). One engine avoids merging results across stores. |
| Embedding provider | **Gemini `gemini-embedding-001`**, 3072-dim, `RETRIEVAL_DOCUMENT` | Validated in Part 1 (morphology clustering) and Part 2 (kNN leg carried the semantic tier at 95%). Provider stays behind an interface (spec §2.4) but Gemini is the v1 default. |
| Vector field | `knn_vector`, dimension 3072, HNSW, cosine similarity | Matches the benchmark configuration. Vectors are **not populated in Phase 1** — embedding happens in Phase 3.2 — but the mapping ships now so no reindex is needed later. |

## 3. Scope

### 3.1 App scaffold (task 1.1 · 2d)

- Shopify Remix app template (Shopify CLI), embedded app, OAuth via the
  template's session flow.
- **Scopes**: `read_products` (+ `read_publications` if needed to resolve sales-
  channel visibility). Request nothing we don't use — scope creep hurts install
  conversion.
- **App proxy** configured (e.g. `/apps/search`) and verified end-to-end with a
  stub JSON endpoint returning shop + query echo. Phase 4 builds the real
  endpoint on this; Phase 1 only proves signature verification and routing work.
- App database via the template's Prisma setup on **Postgres** (SQLite is fine
  for local dev): sessions, shops, and the sync-state tables in §3.5.
- `app/uninstalled` webhook: mark the shop uninstalled, schedule index + data
  cleanup (GDPR-shaped: purge within 48h).

### 3.2 Initial catalog ingest via Bulk Operations (task 1.2 · 3d)

One `bulkOperationRunQuery` per shop fetching, per product:

- **Core**: id, handle, title, `productType`, vendor, tags, `descriptionHtml`
  (stripped to text), status, `onlineStoreUrl`, featured image URL + alt.
- **Variants**: title, SKU, barcode, price, `selectedOptions`, availability.
- **Options**: name + values (facet vocabulary for Phase 3.4).
- **Category**: the Standard Product Taxonomy category (id + localized name).
- **Metafields**: the native gap the whole spec leans on (specs.md §2.3, §3) —
  **do not cut**. Include:
  - the `shopify` namespace (taxonomy category metafields, e.g.
    `shopify.color-pattern` — where structured attribute values live),
  - merchant-defined namespaces, controlled by a per-shop allowlist config
    (default: all `visibleToStorefrontApi` metafields; admin UI for the
    allowlist is Phase 5.1).
- Only `ACTIVE` products published to the Online Store channel are indexed.
- Flow: merchant presses **"Sync All Catalog"** in the app's admin page to
  start the bulk op (install does **not** auto-trigger it) → `bulk_operations/finish`
  webhook → download JSONL → stream-parse → compose search documents (§3.5) →
  bulk-index into OpenSearch. Must handle the one-concurrent-bulk-op-per-shop
  limit and resume/retry a failed download.
- Record a `sync_runs` row (started/finished, counts, errors) — this feeds the
  Phase 5.1 sync-status UI.
- Target: a 10k-product store ingests in minutes, not hours; memory-bounded
  (streaming, no full-catalog buffering).

### 3.3 Webhook incremental sync (task 1.3 · 2d)

- Subscribe (declaratively, in `shopify.app.toml`) to `products/create`,
  `products/update`, `products/delete`.
- Webhook handlers **enqueue and ack fast** (Shopify's 5s deadline): persist
  the event, return 200, process async. A simple DB-backed queue is fine for
  v1; full retry/reconciliation hardening is Phase 5.3.
- On create/update: re-fetch the product via Admin GraphQL (webhook payloads
  omit metafields), recompose the search document, upsert into OpenSearch.
- On delete: remove from the index and sync-state.
- **Changed-text detection** — the cost guard: `products/update` fires for
  inventory and price noise far more often than for text edits.
  - Compose the **embedding input text** (the canonical field concatenation,
    same composition the Phase 0 benchmark used) and hash it (SHA-256).
  - Hash unchanged → update only non-text fields (price, availability) in the
    index; do **not** touch `embedding_stale`.
  - Hash changed → full document upsert + set `embedding_stale = true`, clear
    the stored vector. Phase 3.2's embedder consumes this flag.
- Freshness target: admin edit → index reflects it in **< 30s** under normal
  load.

### 3.4 Index setup (task 1.4 · 2d)

- One index per shop, addressed through an **alias** (`products_{shop}` →
  `products_{shop}_v1`) so Phase 2's analyzer change and any mapping change is
  a build-new + swap-alias, zero-downtime reindex.
- Mapping (three concerns in one index — the 1.4 requirement):
  - **Lexical** `text` fields: title, body, tags, vendor, product_type,
    variant titles, SKU, barcode, metafield text, category name — each indexed
    with a `hebrew_search` analyzer that in Phase 1 is only **final-letter
    folding (ך→כ ם→מ ן→נ ף→פ ץ→צ) + lowercase**. Phase 2 replaces its
    internals; the field names and query contracts don't change.
  - **Facets**: `keyword` fields for option name/value pairs, taxonomy
    attributes, vendor, product_type, price (numeric), availability — the
    substrate for Phase 3.4 filter extraction.
  - **Vector**: `knn_vector` dim 3072 (HNSW/cosine), plus `embedding_stale`
    (boolean) and `content_hash` (keyword) as metadata.
- Local dev: `docker-compose` with OpenSearch (single node) — reuse the Phase 0
  benchmark container setup. Production hosting choice (managed vs
  self-hosted) is recorded as an open question, not blocking.

### 3.5 Data model (app DB)

- `shops`: domain, access token (via session storage), install/uninstall
  timestamps, metafield allowlist, index alias name.
- `product_sync_state`: shop, product_id, `content_hash`, `embedding_stale`,
  `last_synced_at` — the source of truth Phase 3.2 queries for "what needs
  embedding".
- `sync_runs`: per bulk ingest — status, product count, error payloads.
- `webhook_events`: raw event queue with processed/failed status.

## 4. Non-goals (Phase 1)

- Hebrew morphology, stemming, typo tolerance — Phase 2 (the analyzer ships as
  a folding-only stub).
- Calling the embedding API, populating vectors — Phase 3.2 (Phase 1 only
  maintains `embedding_stale`).
- Ranking, hybrid fusion, filter extraction — Phase 3.
- Any storefront or admin UI — Phases 4–5 (the app's embedded page can be the
  template placeholder).
- Billing, App Store listing, multi-region scaling.

## 5. Acceptance tests

Run against a dev store seeded with the Phase 0 dataset
(`benchmark/dataset/products.csv`, 499 L'Occitane IL products) so later phases
inherit a corpus with known ground truth.

| # | Test | Required outcome |
|---|---|---|
| A1 | Fresh install on the seeded dev store, then press "Sync All Catalog" | OAuth completes with **no** automatic ingest; pressing the button runs the bulk ingest; OpenSearch doc count = published-product count; `sync_runs` row shows success |
| A2 | Spot-check indexed doc for the anchor product (`שמן גוף & שימר שקדים למראה עור זוהר`) | All §3.2 fields present incl. variant SKUs and metafields; final-letter folding visible via `_analyze` |
| A3 | Edit a product title in admin | Index updated < 30s; `content_hash` changed; `embedding_stale = true` |
| A4 | Change only inventory/price on a product | Index price/availability updated; `content_hash` unchanged; `embedding_stale` **not** set |
| A5 | Create and delete a product | Appears in / disappears from the index < 30s |
| A6 | Re-run full ingest on an already-synced store | Idempotent: no duplicate docs, unchanged products keep `content_hash` and don't go stale |
| A7 | App proxy stub | Signed request through `{shop}.myshopify.com/apps/search` returns the stub JSON; unsigned direct request is rejected |
| A8 | Uninstall | Webhook processed; shop marked uninstalled; index dropped by cleanup job |
| A9 | Basic lexical query via OpenSearch (`match` on title, e.g. `שימר`) | Returns the anchor product — proves the index is queryable end-to-end before Phase 2 begins |

## 6. Open questions (carry forward, non-blocking)

1. **OpenSearch production hosting** — managed (AWS OpenSearch Service /
   Bonsai) vs self-hosted; drives cost model. Decide before first real
   merchant install, not before building.
2. **Metafield allowlist defaults** — is `visibleToStorefrontApi` the right
   default filter, or index everything in `shopify` + merchant namespaces?
   Revisit with real merchant catalogs in Phase 5.1.
3. **Queue infrastructure** — DB-backed queue now; whether Phase 5.3 hardening
   needs a real broker (SQS/BullMQ) depends on observed webhook volume.
