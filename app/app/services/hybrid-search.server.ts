// Hybrid ranking (spec §3.3): fuse the lexical leg (search.server.ts) with a
// kNN leg over the query embedding via client-side RRF, per the benchmark
// implementation (04_run_queries.py): 50 candidates per leg, k=60,
// score = Σ 1/(60 + rank), ties broken by handle so results are deterministic.
//
// v1 lexical-leg gate (verdict finding 3, the `body oil` case): zero
// exact-field matches means the query doesn't speak the corpus's language
// lexically — whatever the leg ranked is morph/noise artifacts that must not
// outvote a clean kNN ranking, so the leg is dropped from the fusion entirely.
//
// Architecture-review finding 2 asked for a stricter, observable signal. The
// lexical leg now reports a high-signal split (search.server.ts: bare hits on
// title/tags/product_type/variant_titles/option_values/vendor/category_name/
// sku/barcode vs body/metafield_text) and `highSignalMatchCount` is exposed
// here as a shadow diagnostic — but it is NOT the gate. Both candidate rules
// have a measured failure on the frozen corpus (hybrid.test.ts A5b/A5d):
//   - `exactMatchCount === 0` (this gate) is too permissive on `ברק לעור`:
//     `ברק` hits 143 bodies, `לעור` 6 titles; the body noise enters the fusion
//     and kNN's 100% degrades to 83% (still over the A4 bar).
//   - `highSignalMatchCount === 0` is too strict on `מראה`: 41 body-only
//     exact hits, 0 high-signal, so the leg would be dropped — but those body
//     hits carry 5/6 positives while kNN (מראה = mirror) finds 2/6, and the
//     prefixes tier falls 0.938 → 0.818, under its 0.9 bar.
// A doc-count rule at either granularity cannot separate these two; the
// escalation path is per-token analysis (does EACH query token hit a
// high-signal field?) or a doc-frequency/IDF-style concentration signal
// (`ברק` matches 29% of the catalog, `מראה` 8%), tuned against the frozen v1
// benchmark (review finding 3) rather than against either single query.
import { embedQuery } from "./embedding.server";
import { opensearch } from "./opensearch.server";
import {
  SOURCE_FIELDS,
  lexicalSearch,
  type LexicalHit,
  type LexicalMode,
  type LexicalResult,
} from "./search.server";

// Benchmark parity — candidates per leg fed into the fusion. The results page
// runs at this depth; the type-ahead passes a shallower per-surface depth
// (Phase 4 spec §2 "surfaces").
export const LEG_DEPTH = 50;
const RRF_K = 60;

// Semantic-anchor floor (Phase 4, phase4-notes.md "empty state"): kNN always
// returns k neighbours, so a gated query (zero lexical exact matches) would
// otherwise never be empty — `זזזז` would show 50 products. faiss innerproduct
// scores unit vectors as 1 + cosine; probed on the frozen corpus with live
// gemini-embedding-001 vectors (2026-08-18): junk / out-of-catalog queries
// top out at 1.625–1.682 (`זזזז`, `asdfgh`, `מקדחה חשמלית`, `טלפון סלולרי`),
// real semantic queries start at 1.703 (`moisturizer`, `body oil` 1.706,
// `shampoo` 1.708, `ברק לעור` 1.732, `נצנצים לגוף` 1.743). Query-level, on
// the top-1 only, and only when the lexical leg is gated: a per-hit floor
// would cut real recall (`body oil`'s own top-10 dips to 1.683), and an
// un-gated query has lexical evidence that it belongs to the catalog. The
// gap is narrow (0.02) — logged per request (`knn_top`) so it can be
// re-calibrated on real traffic.
export const KNN_ANCHOR_MIN_SCORE = 1.69;

export type HybridOptions = LexicalMode & {
  depth?: number; // candidates per leg (default LEG_DEPTH)
  // A lexical leg already in flight (same alias/query/depth/mode) — the
  // storefront surfaces start it before waiting on the query embedding so a
  // cold-cache type-ahead costs max(timeout, lexical), not the sum.
  lexical?: Promise<LexicalResult>;
};

export type KnnHit = Omit<LexicalHit, "exact">;

// Docs without a vector are absent from the HNSW graph, so unembedded
// products drop out of this leg naturally. Stale-but-present vectors still
// serve: embedding freshness lags text edits by minutes (spec §3.2), and
// hiding a product for that window would be worse than slightly outdated
// semantics.
export async function knnSearch(
  alias: string,
  vector: number[],
  size = LEG_DEPTH,
): Promise<KnnHit[]> {
  const res = await opensearch.search({
    index: alias,
    body: {
      size,
      _source: SOURCE_FIELDS,
      query: { knn: { embedding: { vector, k: size } } },
    } as never,
  });
  return (res.body.hits.hits as any[]).map((h) => ({
    ...h._source,
    score: h._score,
  }));
}

export type HybridHit = Omit<LexicalHit, "score" | "exact" | "highSignal"> & {
  score: number; // RRF score
  lexicalRank?: number; // 1-based rank within each leg (fusion diagnostics)
  knnRank?: number;
};

export type HybridResult = {
  hits: HybridHit[];
  exactMatchCount: number; // over the lexical leg's `depth` candidates
  highSignalMatchCount: number; // shadow diagnostic, not the gate (see header)
  gated: boolean; // lexical leg dropped from the fusion (zero exact matches)
  knnTopScore: number | null; // kNN leg's best score (null: leg not run)
  anchored: boolean; // false when gated AND kNN top-1 < KNN_ANCHOR_MIN_SCORE → no hits
  fusedCount: number; // distinct candidates across both legs (before `size`)
  lexicalTotal: number; // lexical leg's total matching docs (results-page tail)
};

export async function hybridSearch(
  alias: string,
  query: string,
  size = 10,
  opts: HybridOptions = {},
): Promise<HybridResult> {
  return hybridSearchWithVector(alias, query, await embedQuery(query), size, opts);
}

// Split from hybridSearch so the harness can inject cached query vectors and
// run the full fusion without a Gemini key. `queryVector: null` runs the
// lexical leg alone through the same shape (the type-ahead's cold-cache and
// partial-token paths) — no gate applies, since there is nothing to protect
// from the leg.
export async function hybridSearchWithVector(
  alias: string,
  query: string,
  queryVector: number[] | null,
  size = 10,
  { depth = LEG_DEPTH, typeahead = false, lexical }: HybridOptions = {},
): Promise<HybridResult> {
  const [lex, knn] = await Promise.all([
    lexical ?? lexicalSearch(alias, query, depth, { typeahead }),
    queryVector ? knnSearch(alias, queryVector, depth) : Promise.resolve([]),
  ]);
  const gated = queryVector !== null && lex.exactMatchCount === 0;
  const knnTopScore = knn.length ? knn[0].score : null;
  const anchored = !gated || (knnTopScore !== null && knnTopScore >= KNN_ANCHOR_MIN_SCORE);

  const fused = new Map<string, HybridHit>();
  const addLeg = (
    leg: (LexicalHit | KnnHit)[],
    rankKey: "lexicalRank" | "knnRank",
  ) => {
    leg.forEach((hit, i) => {
      const entry = fused.get(hit.handle) ?? { ...display(hit), score: 0 };
      entry.score += 1 / (RRF_K + i + 1);
      entry[rankKey] = i + 1;
      fused.set(hit.handle, entry);
    });
  };
  if (!gated) addLeg(lex.hits, "lexicalRank");
  if (anchored) addLeg(knn, "knnRank");

  const hits = [...fused.values()]
    .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
    .slice(0, size);
  return {
    hits,
    exactMatchCount: lex.exactMatchCount,
    highSignalMatchCount: lex.highSignalMatchCount,
    gated,
    knnTopScore,
    anchored,
    fusedCount: fused.size,
    lexicalTotal: lex.total,
  };
}

const display = ({
  product_id,
  handle,
  title,
  url,
  image_url,
  image_alt,
  price_min,
  price_max,
  available,
}: LexicalHit | KnnHit): Omit<HybridHit, "score"> => ({
  product_id,
  handle,
  title,
  url,
  image_url,
  image_alt,
  price_min,
  price_max,
  available,
});
