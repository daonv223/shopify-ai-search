# Task Breakdown & Estimates — AI Search for Hebrew Shopify Stores

> Decomposed from `specs.md` (2026-07-27). Estimates are ideal dev-days for one
> experienced full-stack developer familiar with Shopify apps but not necessarily
> with Hebrew NLP. **Total: ~55–65 days (~11–13 weeks) for v1.**

## Phase 0 — Pre-build validation (spec §6) · ~4 days

These gate architecture decisions, so they come first.

| # | Subtask | Est. | Notes |
|---|---------|------|-------|
| 0.1 | Hebrew embedding benchmark: embed ~50 morphological word pairs on Gemini vs OpenAI, measure cosine similarity | 2d | Blocks provider choice for 3.2; spec calls this an explicit precondition |
| 0.2 | Storefront API semantic test: run Tier-5 queries through the API on a Grow+ store | 1d | Decides whether hybrid-fallback (spec §3) is even possible |
| 0.3 | Go/no-go writeup: full replacement vs hybrid architecture decision | 1d | Everything in Phase 3 depends on this call |

The prospect-audit script (open question #2) is a sales tool, not product — left
out of the estimate; decide separately (~2–3d if wanted).

## Phase 1 — App foundation & catalog sync · ~9 days

| # | Subtask | Est. | Notes |
|---|---------|------|-------|
| 1.1 | Shopify app scaffold: Remix template, OAuth, app proxy setup | 2d | |
| 1.2 | Initial catalog ingest via Bulk Operations: title, type, body, tags, vendor, variants, SKU, barcode, **metafields + taxonomy category metafields** | 3d | Metafields are the native gap the spec leans on — don't cut |
| 1.3 | Webhook incremental sync (products/create, update, delete) with changed-text detection so only dirty products re-embed | 2d | |
| 1.4 | Index storage selection and setup (e.g. Postgres + pgvector, or Typesense/Elasticsearch + separate vector store) | 2d | Needs to support lexical + vector + facet filtering in one place |

## Phase 2 — Hebrew NLP core (spec §2.1) · ~10 days

The differentiator and the highest-uncertainty work.

| # | Subtask | Est. | Notes |
|---|---------|------|-------|
| 2.1 | Tokenizer + final-letter normalization (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ) | 1d | Simple, do first |
| 2.2 | Clitic/prefix stripping (ה, ו, ב, ל, מ, כ, ש) with ambiguity handling — `מראה` must not be stripped to `ראה` wrongly | 3d | Ambiguity is the hard part; likely needs a vocabulary check against the indexed catalog |
| 2.3 | Plural↔singular stemming including construct state (`שמני גוף` ≈ `שמן גוף`) | 5d | Hardest linguistic piece. Evaluate existing Hebrew stemmers/lexicons (e.g. hspell-derived) before writing rules from scratch — could swing this ±3d |
| 2.4 | ~~Typo tolerance~~ — **descoped 2026-08-11**, not in v1 | — | Fuzzy leg + keyboard-adjacency weighting dropped after review; design preserved in the Phase 0 benchmark and `specs/hebrew-nlp/phase2-notes.md` if revived |
| 2.5 | NLP unit-test harness seeded with the spec §5 acceptance queries | 1d | Build early so 2.2–2.3 develop against it |

## Phase 3 — Retrieval pipeline · ~15 days

| # | Subtask | Est. | Notes |
|---|---------|------|-------|
| 3.1 | Lexical search over normalized index, all fields incl. metafields, field-weighted scoring | 3d | |
| 3.2 | Embedding layer: pluggable provider interface (Gemini/OpenAI), batch embedding on ingest, re-embed on change | 3d | Provider chosen in 0.1 |
| 3.3 | Hybrid ranking: merge lexical + vector results, tune so semantic queries hit "at least parity with native" (Tier-5 target: product in top 5) | 4d | Tuning-heavy; budget iteration time |
| 3.4 | Query→filter extraction: build attribute vocabulary from options/variants/metafields/taxonomy, match attribute words in any inflection (`ירוק/ירוקה/ירוקים/ירוקות`), apply as AND filters | 5d | Second-hardest piece; the inflection matching reuses Phase 2 morphology |

## Phase 4 — Storefront surfaces · ~10 days

| # | Subtask | Est. | Notes |
|---|---------|------|-------|
| 4.1 | Search API endpoint via app proxy with type-ahead latency budget (<~100ms server-side) | 2d | |
| 4.2 | Predictive type-ahead dropdown running the **full** pipeline, RTL-correct | 4d | Spec §2.5 — where most searches happen and where native has no semantic layer |
| 4.3 | Results page grid + applied-filter UI, RTL-correct, theme app extension wiring to override native search | 4d | Override mechanics vary by theme; budget for OS 2.0 + one fallback path |

## Phase 5 — Admin, QA, hardening · ~9 days

| # | Subtask | Est. | Notes |
|---|---------|------|-------|
| 5.1 | Embedded admin: sync status/progress, provider config, basic synonym & boost management | 4d | Spec caps merchandising scope deliberately — keep minimal |
| 5.2 | Automated regression suite: the full §5 tier battery (baseline/stemming/prefixes/filters/semantic) against a reference catalog | 2d | Extends the 2.5 harness to end-to-end |
| 5.3 | Ops hardening: webhook retry/reconciliation, embedding-API rate limits & cost guards, error reporting | 3d | |

## Notes

- **Critical path**: 0.1 → 0.3 → 1.4 → Phase 2 → 3.3/3.4. Phases 1 and 2 can run
  in parallel with two people, compressing the calendar to ~7–8 weeks.
- **Biggest risks**: 2.3 (Hebrew stemming quality) and 3.3 (beating native semantic
  quality on Tier-5, since the app *replaces* native search outright). If 3.3 can't
  reach parity, the hybrid fallback validated in 0.2 becomes load-bearing — keep
  that test rig around.
- **Not included**: billing/App Store listing (~3–5d), multi-store scaling, and the
  deferred non-goals (ktiv male/haser normalization, determinism guarantees).
