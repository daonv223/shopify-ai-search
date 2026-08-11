// Lexical search leg (spec §3.1): multi_match over bare + `.morph` fields
// against a shop's alias. The `.morph` weights are the exact set the 87%
// hybrid hit@10 was measured on (benchmark 04_run_queries.py) — changes must
// re-earn their score on the harness. Each bare twin is weighted ×1.2 above
// its `.morph` field so an exact literal (a product titled מראה) outranks
// stem-only matches; a bare match also matches `.morph` (the multiplexer
// preserves the original token), so exact hits collect both clauses' scores.
import { opensearch } from "./opensearch.server";

const BARE_UPLIFT = 1.2;

// [field, morph weight] — benchmark values, do not retune casually.
const BENCHMARK_FIELDS: [string, number][] = [
  ["title", 3],
  ["tags", 2],
  ["product_type", 2],
  ["variant_titles", 1.5],
  ["option_values", 1.5],
  ["vendor", 1],
  ["body", 1],
];

// §3.1 coverage extension beyond the benchmark set — bare only, no `.morph`:
// metafield_text/category_name at a conservative low weight (untested in the
// benchmark corpus), sku/barcode as keyword lookup fields.
const EXTENDED_BARE_FIELDS = [
  "metafield_text",
  "category_name",
  "sku",
  "barcode",
];

const EXACT_FIELDS = [
  ...BENCHMARK_FIELDS.map(([f, w]) => `${f}^${w * BARE_UPLIFT}`),
  ...EXTENDED_BARE_FIELDS,
];
const MORPH_FIELDS = BENCHMARK_FIELDS.map(([f, w]) =>
  w === 1 ? `${f}.morph` : `${f}.morph^${w}`,
);

// Two named clauses in one round trip: `matched_queries` on each hit tells
// 3.3's fusion gating whether the hit matched a bare/exact field ("exact") or
// only survived via morphology ("morph") — near-zero exact matches means the
// leg has no real signal and gets dropped from the fusion (verdict finding 3).
//
// dis_max, not bool/should: summing the clauses double-counts docs that match
// both and lets a literal-but-incidental body mention (68 docs say שמנים in
// marketing copy) outscore a morph title match — measured as a stemming-tier
// collapse to 0.65. Max keeps each doc on its best clause, extending the
// benchmark's best_fields philosophy across the exact/morph pair.
export function lexicalQuery(query: string): object {
  return {
    dis_max: {
      queries: [
        {
          multi_match: {
            query,
            fields: EXACT_FIELDS,
            type: "best_fields",
            operator: "or",
            _name: "exact",
          },
        },
        {
          multi_match: {
            query,
            fields: MORPH_FIELDS,
            type: "best_fields",
            operator: "or",
            _name: "morph",
          },
        },
      ],
    },
  };
}

export type LexicalHit = {
  product_id: string;
  handle: string;
  score: number;
  exact: boolean; // matched a bare/exact field, not just `.morph`
  title: string;
  url?: string;
  image_url?: string;
  image_alt?: string;
  price_min?: number;
  price_max?: number;
  available?: boolean;
};

export type LexicalResult = {
  hits: LexicalHit[]; // ranked; array position is the leg rank for RRF
  exactMatchCount: number;
};

const SOURCE_FIELDS = [
  "product_id",
  "handle",
  "title",
  "url",
  "image_url",
  "image_alt",
  "price_min",
  "price_max",
  "available",
];

export async function lexicalSearch(
  alias: string,
  query: string,
  size = 10,
): Promise<LexicalResult> {
  const res = await opensearch.search({
    index: alias,
    body: { size, _source: SOURCE_FIELDS, query: lexicalQuery(query) } as never,
  });
  const hits: LexicalHit[] = (res.body.hits.hits as any[]).map((h) => ({
    ...h._source,
    score: h._score,
    exact: (h.matched_queries ?? []).includes("exact"),
  }));
  return { hits, exactMatchCount: hits.filter((h) => h.exact).length };
}
