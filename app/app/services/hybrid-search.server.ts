// Hybrid ranking (spec §3.3): fuse the lexical leg (search.server.ts) with a
// kNN leg over the query embedding via client-side RRF, per the benchmark
// implementation (04_run_queries.py): 50 candidates per leg, k=60,
// score = Σ 1/(60 + rank), ties broken by handle so results are deterministic.
//
// v1 lexical-leg gate (verdict finding 3, the `body oil` case): zero
// exact-field matches means the query doesn't speak the corpus's language
// lexically — whatever the leg ranked is morph/noise artifacts that must not
// outvote a clean kNN ranking, so the leg is dropped from the fusion entirely.
// Escalation path if the harness ever shows this cliff-edge rule failing
// (an incidental literal token opening the gate at full fusion weight):
// weight the leg by exactMatchCount instead.
import { embedQuery } from "./embedding.server";
import { opensearch } from "./opensearch.server";
import { SOURCE_FIELDS, lexicalSearch, type LexicalHit } from "./search.server";

const LEG_DEPTH = 50; // benchmark parity — candidates per leg fed into the fusion
const RRF_K = 60;

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

export type HybridHit = Omit<LexicalHit, "score" | "exact"> & {
  score: number; // RRF score
  lexicalRank?: number; // 1-based rank within each leg (fusion diagnostics)
  knnRank?: number;
};

export type HybridResult = {
  hits: HybridHit[];
  exactMatchCount: number; // over the lexical leg's LEG_DEPTH candidates
  gated: boolean; // lexical leg dropped from the fusion (zero exact matches)
};

export async function hybridSearch(
  alias: string,
  query: string,
  size = 10,
): Promise<HybridResult> {
  return hybridSearchWithVector(alias, query, await embedQuery(query), size);
}

// Split from hybridSearch so the harness can inject cached query vectors and
// run the full fusion without a Gemini key.
export async function hybridSearchWithVector(
  alias: string,
  query: string,
  queryVector: number[],
  size = 10,
): Promise<HybridResult> {
  const [lex, knn] = await Promise.all([
    lexicalSearch(alias, query, LEG_DEPTH),
    knnSearch(alias, queryVector, LEG_DEPTH),
  ]);
  const gated = lex.exactMatchCount === 0;

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
  addLeg(knn, "knnRank");

  const hits = [...fused.values()]
    .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
    .slice(0, size);
  return { hits, exactMatchCount: lex.exactMatchCount, gated };
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
