// Storefront surfaces (Phase 4 spec §3.1): the two shapes the app proxy
// serves — `suggest` (type-ahead, ≤8 hits, tight budget) and `results`
// (paginated grid) — over one hybrid pipeline. Routes stay thin: they
// authenticate the proxy request, resolve shop → alias, and call in here.
//
// Latency contract (phase4-notes.md, decided on A8): the type-ahead waits at
// most SUGGEST_EMBED_TIMEOUT_MS for a query vector — cold keystrokes are
// lexical-only by construction, the vector lands in the LRU behind them
// (fire-and-cache) — while the results page waits up to
// RESULTS_EMBED_TIMEOUT_MS (a resilience bound, not a budget).
import { performance } from "node:perf_hooks";

import {
  LEG_DEPTH,
  hybridSearchWithVector,
  type HybridHit,
  type HybridResult,
} from "./hybrid-search.server";
import { embeddingProviderFor } from "./embedding.server";
import { queryEmbeddings, type SemanticStatus } from "./query-embedding.server";
import { getQueryConfig } from "./search-config.server";
import { lexicalSearch, type BoostConfig, type LexicalResult, type SynonymGroup } from "./search.server";

export const QUERY_MAX_LEN = 200;

export const SUGGEST_LIMIT_MAX = 8;
export const SUGGEST_LIMIT_DEFAULT = 6;
export const SUGGEST_DEPTH = 20; // candidates per leg (spec §2 "surfaces")
export const SUGGEST_EMBED_TIMEOUT_MS = 50; // phase4-notes.md: budget − fusion

export const RESULTS_LIMIT_MAX = 48;
export const RESULTS_LIMIT_DEFAULT = 24;
export const RESULTS_EMBED_TIMEOUT_MS = 2_000;
export const RESULTS_TAIL_MAX = 1_000; // deepest lexical tail we will page into

// Trim, collapse whitespace, cap length. Empty → "" (callers answer 200 with
// no hits — the dropdown polls constantly, a 4xx would just be noise).
export function cleanQuery(raw: string | null | undefined): string {
  return (raw ?? "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, QUERY_MAX_LEN).trim();
}

export function clampInt(
  raw: string | null | undefined,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Partial-token rule (spec §2): the trailing token of a type-ahead query is
// being typed; embedding half a word is noise (and a Gemini call), so the kNN
// leg is skipped until the last token has ≥ 3 chars. "A single partial
// token" collapses into the same rule — partial-ness is not observable, and
// a 3-letter Hebrew word (שמן, גוף, עור) is a complete query.
export function shouldEmbedTypeahead(query: string): boolean {
  const tokens = query.split(" ");
  return tokens[tokens.length - 1].length >= 3;
}

export type SurfaceHit = {
  handle: string;
  title: string;
  url?: string;
  image_url?: string;
  image_alt?: string;
  price_min?: number;
  price_max?: number;
  available?: boolean;
};

type Diagnostics = {
  gated: boolean;
  semantic: SemanticStatus;
  took_ms: number;
};

export type SuggestResponse = Diagnostics & {
  query: string;
  hits: SurfaceHit[];
  total: number; // distinct candidates across both legs at SUGGEST_DEPTH
};

export type ResultsResponse = Diagnostics & {
  query: string;
  hits: SurfaceHit[];
  page: number;
  limit: number;
  has_more: boolean;
  // Upper bound on servable products: fused candidates + the lexical tail
  // beyond fusion depth (which may overlap the fused set). Exact once
  // has_more is false.
  total: number;
};

const toHit = ({
  handle,
  title,
  url,
  image_url,
  image_alt,
  price_min,
  price_max,
  available,
}: HybridHit): SurfaceHit => ({
  handle,
  title,
  url,
  image_url,
  image_alt,
  price_min,
  price_max,
  available,
});

const empty = (query: string, took_ms = 0): Diagnostics & { query: string; hits: []; total: 0 } => ({
  query,
  hits: [],
  total: 0,
  gated: false,
  semantic: "skipped",
  took_ms,
});

// One timing line per request — the observability Phase 5.3 builds on.
type LogExtra = { hits: number; total: number; knn_top: number | null; anchored: boolean };
function logTiming(
  surface: "suggest" | "results" | "page",
  shop: string,
  query: string,
  diag: Diagnostics,
  extra: LogExtra,
) {
  console.log(
    JSON.stringify({
      evt: "search",
      surface,
      shop,
      q_len: query.length,
      gated: diag.gated,
      semantic: diag.semantic,
      knn_top: extra.knn_top === null ? null : Number(extra.knn_top.toFixed(3)),
      anchored: extra.anchored,
      hits: extra.hits,
      total: extra.total,
      ms: Math.round(diag.took_ms),
    }),
  );
}

export async function suggest(
  shop: string,
  alias: string,
  rawQuery: string | null | undefined,
  rawLimit?: string | null,
): Promise<SuggestResponse> {
  const t0 = performance.now();
  const query = cleanQuery(rawQuery);
  const limit = clampInt(rawLimit, { min: 1, max: SUGGEST_LIMIT_MAX, fallback: SUGGEST_LIMIT_DEFAULT });
  if (!query) return empty(query);

  // Per-shop boosts/synonyms (task 5.1). Synonyms are a no-op on the type-ahead
  // path (a trailing token is a prefix, not a synonym trigger); boosts apply.
  const cfg = await getQueryConfig(shop);
  const lexOpts = { boosts: cfg.boosts, synonyms: cfg.synonyms };
  // Lexical leg first, embedding wait alongside it: a cold keystroke costs
  // max(SUGGEST_EMBED_TIMEOUT_MS, lexical), not the sum.
  const lexical = swallow(lexicalSearch(alias, query, SUGGEST_DEPTH, { typeahead: true, ...lexOpts }));
  const embed = shouldEmbedTypeahead(query)
    ? await queryEmbeddings.get(query, SUGGEST_EMBED_TIMEOUT_MS, embeddingProviderFor(cfg.embedding))
    : { vector: null, status: "skipped" as const };
  const res = await hybridSearchWithVector(alias, query, embed.vector, limit, {
    depth: SUGGEST_DEPTH,
    typeahead: true,
    lexical,
    ...lexOpts,
  });
  const out: SuggestResponse = {
    query,
    hits: res.hits.map(toHit),
    total: res.anchored ? res.fusedCount : 0,
    gated: res.gated,
    semantic: embed.status,
    took_ms: performance.now() - t0,
  };
  logTiming("suggest", shop, query, out, {
    hits: out.hits.length,
    total: out.total,
    knn_top: res.knnTopScore,
    anchored: res.anchored,
  });
  return out;
}

export async function results(
  shop: string,
  alias: string,
  rawQuery: string | null | undefined,
  rawPage?: string | null,
  rawLimit?: string | null,
  surface: "results" | "page" = "results",
): Promise<ResultsResponse> {
  const t0 = performance.now();
  const query = cleanQuery(rawQuery);
  const page = clampInt(rawPage, { min: 1, max: 10_000, fallback: 1 });
  const limit = clampInt(rawLimit, { min: 1, max: RESULTS_LIMIT_MAX, fallback: RESULTS_LIMIT_DEFAULT });
  if (!query) return { ...empty(query), page, limit, has_more: false };

  const cfg = await getQueryConfig(shop);
  const lexOpts = { boosts: cfg.boosts, synonyms: cfg.synonyms };
  const lexical = swallow(lexicalSearch(alias, query, LEG_DEPTH, lexOpts));
  const embed = await queryEmbeddings.get(
    query,
    RESULTS_EMBED_TIMEOUT_MS,
    embeddingProviderFor(cfg.embedding),
  );
  // The whole fused list (≤ 2 × depth) — page N is a slice of it.
  const res = await hybridSearchWithVector(alias, query, embed.vector, 2 * LEG_DEPTH, {
    lexical,
    ...lexOpts,
  });
  const offset = (page - 1) * limit;
  const list = await withLexicalTail(alias, query, res, offset + limit + 1, lexOpts);

  const out: ResultsResponse = {
    query,
    hits: list.slice(offset, offset + limit).map(toHit),
    page,
    limit,
    has_more: list.length > offset + limit,
    total: servableTotal(res),
    gated: res.gated,
    semantic: embed.status,
    took_ms: performance.now() - t0,
  };
  logTiming(surface, shop, query, out, {
    hits: out.hits.length,
    total: out.total,
    knn_top: res.knnTopScore,
    anchored: res.anchored,
  });
  return out;
}

// A promise started before an `await` on something else must not surface an
// unhandled rejection if that something throws first; the rejection is
// re-thrown where the promise is actually awaited (inside the fusion).
function swallow(p: Promise<LexicalResult>): Promise<LexicalResult> {
  p.catch(() => {});
  return p;
}

// Beyond fusion depth the endpoint appends the lexical tail rather than
// returning nothing (spec §3.1): lexical ranks > LEG_DEPTH, minus anything
// the fused list already carries. Always fetched from the same offset
// (LEG_DEPTH) so pagination is stable across requests; the extra LEG_DEPTH
// of slack covers every possible collision with the kNN leg's candidates.
// No tail when the lexical leg is gated — the gate's premise is that those
// hits are morph noise — nor when the query has no semantic anchor.
async function withLexicalTail(
  alias: string,
  query: string,
  res: HybridResult,
  wanted: number,
  lexOpts: { boosts?: BoostConfig; synonyms?: SynonymGroup[] } = {},
): Promise<HybridHit[]> {
  if (!res.anchored) return [];
  if (res.gated || res.hits.length >= wanted || res.lexicalTotal <= LEG_DEPTH) return res.hits;
  const need = Math.min(wanted - res.hits.length + LEG_DEPTH, RESULTS_TAIL_MAX);
  const tail = await lexicalSearch(alias, query, need, { from: LEG_DEPTH, ...lexOpts });
  const seen = new Set(res.hits.map((h) => h.handle));
  const extra: HybridHit[] = [];
  for (const hit of tail.hits) {
    if (seen.has(hit.handle)) continue;
    seen.add(hit.handle);
    extra.push({ ...toHit(hit), product_id: hit.product_id, score: 0 });
  }
  return res.hits.concat(extra);
}

function servableTotal(res: HybridResult): number {
  if (!res.anchored) return 0;
  if (res.gated) return res.fusedCount;
  return res.fusedCount + Math.max(0, res.lexicalTotal - LEG_DEPTH);
}
