// Lexical search leg (spec §3.1): multi_match over bare + `.morph` fields
// against a shop's alias. The `.morph` weights are the exact set the 87%
// hybrid hit@10 was measured on (benchmark 04_run_queries.py) — changes must
// re-earn their score on the harness. Each bare twin is weighted ×1.2 above
// its `.morph` field so an exact literal (a product titled מראה) outranks
// stem-only matches; a bare match also matches `.morph` (the multiplexer
// preserves the original token), so exact hits collect both clauses' scores.
import { opensearch } from "./opensearch.server";

const BARE_UPLIFT = 1.2;

// High-signal fields: a bare match here means the query is *about* the
// product — either it names what the product is (title/tags/product_type/
// variant_titles/option_values/category_name), who makes it (vendor), or
// identifies it outright (sku/barcode). The benchmark's weight-1 `body` is
// deliberately NOT here: it is long marketing prose prone to incidental
// mentions (the verdict's "68 docs say שמנים in marketing copy" finding), and
// so is `metafield_text` (free-form, conservatively low weight per §3.1).
// Weights are the benchmark's ranking weights, unchanged; the high/low split
// only labels what a hit matched (`highSignal` diagnostics). If a future gate
// keys off it, sku/barcode/vendor/category_name must stay high-signal: a SKU
// or brand query has no useful vector neighbourhood, so dropping the lexical
// leg drops the only leg that can answer it (hybrid.test.ts A5c).
const HIGH_SIGNAL_MORPH_FIELDS: [string, number][] = [
  ["title", 3],
  ["tags", 2],
  ["product_type", 2],
  ["variant_titles", 1.5],
  ["option_values", 1.5],
  ["vendor", 1],
];
// §3.1 coverage extensions — bare only, no `.morph`: category_name at a
// conservative low weight (untested in the benchmark corpus), sku/barcode as
// keyword lookup fields.
const HIGH_SIGNAL_BARE_ONLY_FIELDS = ["category_name", "sku", "barcode"];

// Low-signal bare fields: body (benchmark weight 1) and metafield_text (§3.1
// extension). A match proves the token exists somewhere in the doc but is
// weak evidence the query is about the product — long free-form text.
const EXACT_HIGH_FIELDS = [
  ...HIGH_SIGNAL_MORPH_FIELDS.map(([f, w]) => `${f}^${w * BARE_UPLIFT}`),
  ...HIGH_SIGNAL_BARE_ONLY_FIELDS,
];
const EXACT_LOW_FIELDS = [`body^${BARE_UPLIFT}`, "metafield_text"];
const MORPH_FIELDS = HIGH_SIGNAL_MORPH_FIELDS.map(([f, w]) =>
  w === 1 ? `${f}.morph` : `${f}.morph^${w}`,
).concat(["body.morph"]);

// Three named clauses in one round trip. `matched_queries` on each hit tells
// 3.3's fusion gating which clause matched:
//   "exact_high" — a high-signal bare field (title/tags/vendor/sku/...).
//   "exact_low"  — a low-signal bare field (body/metafield_text).
//   "morph"      — survived only via the morphology analyzer.
// The v1 gate (hybrid-search.server.ts) closes on zero exact matches of
// either kind; the high/low split is a shadow diagnostic for the stricter
// gate architecture-review finding 2 asks for — see that file's header for
// why neither doc-count rule is sufficient (`ברק לעור` vs `מראה`). A hit
// that matched both a high-signal and a low-signal field collects both
// names; `exact` stays the union so the exact-precedence test is unaffected.
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
            fields: EXACT_HIGH_FIELDS,
            type: "best_fields",
            operator: "or",
            _name: "exact_high",
          },
        },
        {
          multi_match: {
            query,
            fields: EXACT_LOW_FIELDS,
            type: "best_fields",
            operator: "or",
            _name: "exact_low",
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
  exact: boolean; // matched any bare/exact field (high or low signal)
  highSignal: boolean; // matched a high-signal bare field (title/tags/...)
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
  highSignalMatchCount: number; // hits matching title/tags/product_type/...
};

export const SOURCE_FIELDS = [
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
  const hits: LexicalHit[] = (res.body.hits.hits as any[]).map((h) => {
    const matched = h.matched_queries ?? [];
    return {
      ...h._source,
      score: h._score,
      exact: matched.includes("exact_high") || matched.includes("exact_low"),
      highSignal: matched.includes("exact_high"),
    };
  });
  return {
    hits,
    exactMatchCount: hits.filter((h) => h.exact).length,
    highSignalMatchCount: hits.filter((h) => h.highSignal).length,
  };
}
