# Phase 5 Spec — Admin, QA, Hardening

> Phase 5 of `specs/task-breakdown.md` (~9 days). Inputs: `specs/specs.md`
> §5 (acceptance tiers — now run end-to-end), §4 (merchandising scope is
> deliberately capped — synonyms + boosts only, no rule builder); the
> Phase 1 data model in `app/prisma/schema.prisma` (`Shop`, `SyncRun`,
> `ProductSyncState`, `WebhookEvent`); the Phase 4 endpoints
> (`proxy.search_.suggest.tsx`, `proxy.search_.results.tsx`) and their
> `took_ms` / timing log line; and the deferred-hardening markers already
> planted in the code — every `task 5.3` comment
> (`ingest.server.ts:156`, `webhooks.products.tsx:10`,
> `webhooks.bulk-operations.tsx:8`, `product-sync.server.ts:113`,
> `embedding.server.ts:58`). This phase turns the demo into something a
> merchant can install unattended.

## 1. Goal

Make the app operable and durable. At the end of this phase a merchant
gets an embedded admin that shows sync state, lets them configure the
provider and a small set of synonyms/boosts, and the pipeline survives the
failures a real store produces: dropped webhooks and a half-finished sync.
The §5 tier battery runs green end-to-end against a reference catalog on
every push.

**Definition of done:** a fresh install syncs to completion with a visible
progress bar; a dropped/crashed webhook still lands the product in the
index by the next cron tick or the daily sweep; a merchant adds the synonym
`שמן↔אולי` and it changes results without a redeploy; the CI regression
suite fails the build if any §5 tier regresses.

## 2. Decisions carried in / made here

| Decision | Choice | Why |
|---|---|---|
| Merchandising scope | **Synonyms + per-field boosts only.** No rule builder, no pinned products, no per-query curation. | `specs.md` §4 caps merchandising deliberately; the task note says "keep minimal". Synonyms and boosts are the two levers that change relevance without a code change. |
| Synonym storage & application | Persist in a new `SearchConfig` row per shop (JSON); apply at **query time** as an OpenSearch `synonym_graph` token filter loaded from the config, not at index time. | Query-time synonyms change results without reindexing — a merchant edit must take effect immediately. Index-time would need a full re-embed/reindex per edit. |
| Boost storage & application | Same `SearchConfig` row holds field-weight overrides; merged over the Phase 3 defaults in `search.server.ts` at query build. | One config object, one write path. Boosts are multipliers on existing `dis_max` field weights — no schema change. |
| Webhook durability | **Persist, then drain by cron.** The webhook route already writes a `WebhookEvent` row and acks 200 (Phase 1); this phase drops the in-line `void processProductWebhook` and lets a **cron drain worker (every minute)** process `status='pending'`. **No retry in v1** (decided 2026-08-20): a throw marks the event `failed` and stops there — the daily reconciliation sweep is the safety net, not a per-event retry loop. Sweep re-lists Shopify products and repairs `ProductSyncState` drift. | The crash window (process dies between ack and processing) is the real data-loss bug — a table-driven drain closes it without a queue. Retry adds `attempts`/backoff state and failure-classification for little v1 gain while the sweep already repairs drift; defer it. |
| Error reporting | Structured JSON log lines (one schema, `level`/`shop`/`op`/`err`) + a `SyncRun.error` / `WebhookEvent` failure surfaced in the admin. **No third-party APM in v1** — leave a single `reportError()` seam. | The task budget is ops hardening, not observability tooling. One seam lets a pilot bolt on Sentry later without touching call sites. |
| Regression harness | Extend the existing vitest NLP harness (`app/tests/nlp/harness.ts`) to run the §5 battery **through the HTTP endpoints** (signed proxy request), not only the services, and wire it into CI. | Phase 4 B2 proved endpoint parity once by hand; 5.2 makes it a gate. Reuses the frozen 499-product corpus + cached vectors. |

## 3. Scope

### 3.1 Embedded admin (task 5.1 · 4d)

Extends `app/app/routes/app._index.tsx` (today just a "start sync" button)
into a small Polaris admin.

- **Sync status & progress.** Read `SyncRun` (latest per shop) +
  `ProductSyncState` counts: show state (running/success/failed), products
  indexed / total, embedding-stale count, last-synced time, and the current
  bulk-operation phase. Poll while running. Surface `SyncRun.error` on
  failure with a re-run action. Manual "re-sync" and "re-embed stale"
  buttons.
- **Provider config.** Choose embedding provider (Gemini/OpenAI — the
  pluggable interface exists from Phase 3) and model; store the choice per
  shop; validate the key with a one-vector test call before saving. Never
  render the stored key back to the browser.
- **Synonym management.** Add/edit/remove synonym groups (Hebrew,
  bidirectional or one-way). Persist to `SearchConfig`; the query path
  loads them into the `synonym_graph` filter. Validate against the analyzer
  (reject tokens the tokenizer would split unexpectedly). Live preview: run
  one query before/after.
- **Boost management.** Per-field weight sliders over the Phase 3 defaults
  (title/tags/product_type/vendor/body). Reset-to-default. Same live
  preview.
- Minimal by design: no analytics dashboard, no rule builder (non-goals).

### 3.2 Automated regression suite (task 5.2 · 2d)

- Extend `harness.ts` with an **HTTP mode**: sign a proxy request with the
  app secret (as Phase 4 B2 did) and assert the §5 tiers —
  Baseline / Stemming / Prefixes / Semantic (filters descoped) — through
  `/proxy/search/results` and the prefix forms through `/proxy/search/suggest`.
- Keep the frozen 499-product corpus + cached vectors as the reference
  catalog so runs are deterministic and offline (no live Gemini).
- Assert the **bars already measured** in Phases 2–4 (A3/A4/A5, B3/B4),
  not new ones — this is a regression gate, not a re-tuning pass. A tier
  dropping below its recorded bar fails the build.
- **CI wiring**: spin up local OpenSearch (the existing
  `global-setup.ts`), seed the corpus, run the battery, publish a small
  pass/fail table. Runs on every push to a PR.

### 3.3 Ops hardening (task 5.3 · 3d)

- **Webhook durability (cron drain, no retry in v1).** The route already
  persists a `WebhookEvent` and acks fast (Phase 1); remove the in-line
  `void processProductWebhook` in `webhooks.products.tsx` /
  `webhooks.bulk-operations.tsx` so processing is owned by a **cron drain
  worker that runs every minute**: pick up `status='pending'`, process,
  mark `processed`; on throw mark `failed` and stop (**no retry loop, no
  backoff, no `attempts` column** — decided 2026-08-20). Processing stays
  idempotent by `WebhookEvent.id` so a crashed-mid-process event is safe to
  re-pick-up on the next tick. Add a **daily reconciliation sweep** that
  re-lists product IDs from Shopify and repairs `ProductSyncState` drift
  (missed create/delete, and any `failed` event) — this is the v1 safety
  net in place of retry. Both jobs are cron, matching how
  `scheduleEmbeddingBackfill` already runs.
- **Error reporting.** Two parts:
  - *Log schema (convention, no DB change).* Replace the ad-hoc
    `console.log`/`console.error` strings (e.g. `webhooks.products.tsx`'s
    `[sync] … failed:`) with one structured JSON line emitted from every
    op — `{ level, ts, shop, op, ok, ms?, err? }`, extending the Phase 4
    timing line's fields — funnelled through a single `reportError()` /
    `logEvent()` helper so a pilot can bolt on Sentry at that one seam.
  - *Prisma change (one column).* Add `error Json?` to `WebhookEvent`.
    Today the route sets `status='failed'` but **drops the error text**
    (`webhooks.products.tsx:34–38` only `console.error`s it), so the admin
    can show *that* an event failed, not *why*. Persist the failure detail
    there. `SyncRun.error` already exists — no change. That single column
    is the whole schema delta for error reporting; failures then render in
    the 5.1 admin. No APM vendor in v1.
- **Publication visibility** (Phase 4 open question 3): gate indexing on
  `product.status === "ACTIVE" && product.onlineStoreUrl != null` — no
  `read_publications` scope, no doc flag, no query-time filter. Shopify
  returns `onlineStoreUrl` as null unless the product is published to the
  **Online Store** channel, so this excludes active-but-unpublished and
  POS-only products at the source. Both legs already fetch the field
  (`ingest.server.ts:29`, `product-sync.server.ts` `PRODUCT_QUERY`), so the
  change is: (a) tighten the ingest predicate (today `status:active` only)
  to also require `onlineStoreUrl`, and (b) extend the webhook drop
  condition (`processProductWebhook`: currently `!product || status !==
  "ACTIVE"`) to `|| !product.onlineStoreUrl`, which `removeProduct`s a
  product the moment it is unpublished — same path as a status change.
  Scope stays `read_products`, so **no merchant re-consent**. **Must land
  before any pilot merchant.**

**Suggested build order**: 3.3 first (durability is load-bearing for a
real install), then 3.1 (the admin surfaces the state 3.3 produces), 3.2
in parallel throughout (extend the harness red-to-green per the
Phase 2/3/4 pattern).

## 4. Non-goals (Phase 5)

- Search analytics — query log, zero-result report, click-through,
  dashboards. (A pilot-feedback item, not v1.)
- Rule-based merchandising, pinned products, per-query curation — beyond
  the §4 cap.
- Third-party APM / error-tracking vendor (Sentry etc.) — seam only.
- Sorting other than relevance, facet sidebar — Phase 4 non-goals, still
  out unless open question 1 is pulled in.
- Redis-backed embedding cache — decide with real traffic (Phase 4 open
  question 2); in-process LRU stays until measured need.
- Billing, App Store listing, multi-store scaling — out of the v1
  estimate (`task-breakdown.md` Notes).
- Typo tolerance, query→filter extraction — descoped from v1.

## 5. Acceptance tests

Harness/vitest against local OpenSearch with the frozen 499-product corpus
and cached vectors, plus manual verification on the dev store (Dawn).
C1–C2 automated; C3–C5 manual with screenshots in `phase5-notes.md`.

| # | Test | Required outcome |
|---|---|---|
| C1 | Regression gate: full §5 tier battery through the HTTP endpoints in CI | Every tier at or above its recorded Phase 2–4 bar; any regression fails the build; run is offline/deterministic |
| C2 | Webhook durability: enqueue a `products/update`, kill the process mid-drain, let the next cron tick run | Event still `pending`, drain re-picks it up next minute, product ends indexed exactly once (idempotent); no lost update. A `failed` event is **not** retried (v1 decision); the daily reconciliation sweep repairs it and a manually-deleted `ProductSyncState` row |
| C3 | Synonym edit on Dawn: add `שמן↔אולי`, search the synonym | Result set changes immediately (no reindex/redeploy); live preview shows before/after; removing it reverts |
| C4 | Boost edit: raise `title` weight, lower `body` | Ranking shifts as expected in preview and on the storefront; reset restores Phase 3 defaults |
| C5 | Fresh-install run-through on Dawn: install → sync → progress bar → search | Progress bar advances to done; failure state (if forced) shows the error + re-run; first search works end-to-end |

## 6. Open questions (carry forward, non-blocking)

1. **Synonym scope vs. the Phase 2 morphology.** Query-time synonyms and
   the Hebrew analyzer both rewrite tokens; a merchant synonym on an
   already-stemmed form could double-expand. Validate the interaction on
   real edits; if it misbehaves, apply synonyms pre-analysis only.
2. **Reconciliation cadence & cost.** A daily full re-list is cheap at 499
   products, linear at 10k+. Revisit with the scale test the architecture
   review asks for (Phase 4 open question 4).
3. **Error surface depth.** v1 shows failures in the admin as a flag +
   message. If pilots need history/trends, that is the analytics work
   deferred above, not a Phase 5 expansion.
