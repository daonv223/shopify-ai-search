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

// Type-ahead prefix clause (Phase 4 spec §2 "partial-token handling"): the
// trailing token of a query being typed is a prefix, so `שמ` must meet
// `שמנים`. A raw `prefix` query per bare field on the app-side normalized
// last token (lowercase + final-letter folding, mirroring the `hebrew_text`
// analyzer — a typed `שמן` becomes the prefix `שמנ` and meets שמנים/שמני/שמן
// alike). Rewrite `top_terms_blended_freqs_N`: the expansions are BM25-scored
// with one blended document frequency, so a prefix hit is a mild, bounded
// signal — ties among the 58 שמן/שמפו/שמנים titles break on tf/title length
// instead of index order (what `bool_prefix`'s constant score gives), yet
// three rare `ג…` words in a gel title cannot outvote an exact `שמן` in an
// oil's title (what `scoring_boolean`'s per-term IDF sum did on `שמן ג`).
// N bounds the clause count on 1-char prefixes at any catalog size.
// High-signal fields at the exact_high weights for any prefix length;
// `body` at its low weight only once the token has PREFIX_BODY_MIN_CHARS —
// long prose would let two letters match half the catalog, but a concept
// that lives only in body copy (`מראה`, A5d) must still type-ahead.
const PREFIX_FIELDS: [string, number][] = HIGH_SIGNAL_MORPH_FIELDS.filter(([f]) =>
  ["title", "tags", "product_type", "vendor"].includes(f),
).map(([f, w]) => [f, w * BARE_UPLIFT]);
const PREFIX_BODY_FIELD: [string, number] = ["body", 1];
export const PREFIX_BODY_MIN_CHARS = 3;
const PREFIX_REWRITE = "top_terms_blended_freqs_100";

// Hebrew clitic on a partial token: the analyzer's `he_strip_prefix`
// (opensearch.server.ts HE_PREFIX) drops a leading ו/ב/ל/מ/כ/ה/ש only from a
// complete word with ≥3 letters after it, so a half-typed `לגו` (→ לגוף) or
// `בשמ` (→ בשמן) carries no evidence toward גוף / שמן. The type-ahead adds a
// second, half-weight prefix variant with the clitic stripped, permissive
// (any letter after it) because the word is still growing — `לג` → `ג` is
// what lets `שמן לג` prefer `שמן גוף` over `באלם לגוף`. Half weight and the
// blended-frequency rewrite keep the false-clitic noise (`שמנ` → `מנ…`, `שק`
// → `ק…`) at tie-break level under the unstripped prefix and the other
// tokens' clauses; measured on the harness (surface.test.ts B3).
const HE_CLITIC_PARTIAL = /^[ובלמכהש](?=[א-ת]+$)/;
const CLITIC_VARIANT_WEIGHT = 0.5;

export function prefixVariants(token: string): [string, number][] {
  const main = normalizeToken(token);
  const variants: [string, number][] = [[main, 1]];
  if (HE_CLITIC_PARTIAL.test(main)) variants.push([main.slice(1), CLITIC_VARIANT_WEIGHT]);
  return variants;
}

const FINAL_LETTERS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };

// Tokens as the standard tokenizer would cut them (letters/digits runs).
function tokenize(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[ךםןףץ]/g, (c) => FINAL_LETTERS[c]);
}

// Trailing partial tokens shorter than this are kept out of the morph clause:
// a 2-letter query token meets the multiplexer's over-stripped stems (`שמ` ←
// בשמים: ב- prefix and -ים suffix both stripped) and those rare stems carry
// high IDF, so `שמ` would rank perfumes above oils. Exact + prefix still
// apply to it. Measured on the harness (surface.test.ts B3).
export const MORPH_MIN_LAST_TOKEN = 3;

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
//
// `typeahead: true` wraps that dis_max in a bool with one additive
// should-clause, "prefix" (PREFIX_FIELDS above), on the trailing token. It is
// a STRICT prefix — `must: prefix`, `must_not: term` on the same field — so
// it only carries evidence the core cannot: a doc whose field holds the
// literal complete token is already scored by exact_high/exact_low and gets
// nothing extra, while a doc holding a longer word (שמנים for a typed שמנ,
// גוף for a typed ג) does. Measured on the harness (surface.test.ts B3):
//   - a plain additive prefix double-counted a fully typed last token —
//     conditioners tagged `שמנים` fired exact_high + prefix and outranked
//     morph-matched `שמן` oils on `שמנים`; literal-`לגוף` balms outranked
//     `שמן גוף` oils on `שמן לגוף`;
//   - a dis_max sibling (max) lost cross-token evidence — a `ג'ל…` title tied
//     an oil matching both `שמני` (morph) and `ג` (prefix) on `שמני ג`; with a
//     tie_breaker the same-token stacking came back.
// A prefix hit on a title/tag/type/vendor is treated as a high-signal exact
// match for the gate and diagnostics: `שמנ` has zero literal matches, and
// without that the v1 gate would drop the only leg that can answer a
// half-typed word. The morph clause drops a trailing token shorter than
// MORPH_MIN_LAST_TOKEN.
export type LexicalMode = { typeahead?: boolean };

export function lexicalQuery(query: string, { typeahead = false }: LexicalMode = {}): object {
  const tokens = tokenize(query);
  const last = tokens[tokens.length - 1] ?? "";
  const morphQuery =
    typeahead && last.length < MORPH_MIN_LAST_TOKEN
      ? tokens.slice(0, -1).join(" ")
      : query;
  const queries: object[] = [
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
  ];
  if (morphQuery) {
    queries.push({
      multi_match: {
        query: morphQuery,
        fields: MORPH_FIELDS,
        type: "best_fields",
        operator: "or",
        _name: "morph",
      },
    });
  }
  const core = { dis_max: { queries } };
  if (!typeahead || !last) return core;
  const variants = prefixVariants(last);
  const fields =
    variants[0][0].length >= PREFIX_BODY_MIN_CHARS ? [...PREFIX_FIELDS, PREFIX_BODY_FIELD] : PREFIX_FIELDS;
  const strictPrefix = (field: string, value: string, boost: number) => ({
    bool: {
      must: { prefix: { [field]: { value, rewrite: PREFIX_REWRITE } } },
      must_not: { term: { [field]: value } },
      boost,
    },
  });
  return {
    bool: {
      should: [
        core,
        {
          dis_max: {
            queries: fields.flatMap(([field, boost]) =>
              variants.map(([value, w]) => strictPrefix(field, value, boost * w)),
            ),
            _name: "prefix",
          },
        },
      ],
      minimum_should_match: 1,
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
  total: number; // matching docs (track_total_hits cap applies), any clause
};

export type LexicalOptions = LexicalMode & {
  from?: number; // offset — the results page's lexical tail beyond fusion depth
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
  { from = 0, typeahead = false }: LexicalOptions = {},
): Promise<LexicalResult> {
  const res = await opensearch.search({
    index: alias,
    body: {
      from,
      size,
      _source: SOURCE_FIELDS,
      query: lexicalQuery(query, { typeahead }),
    } as never,
  });
  const hits: LexicalHit[] = (res.body.hits.hits as any[]).map((h) => {
    const matched: string[] = h.matched_queries ?? [];
    const high = matched.includes("exact_high") || matched.includes("prefix");
    return {
      ...h._source,
      score: h._score,
      exact: high || matched.includes("exact_low"),
      highSignal: high,
    };
  });
  const total = res.body.hits.total;
  return {
    hits,
    exactMatchCount: hits.filter((h) => h.exact).length,
    highSignalMatchCount: hits.filter((h) => h.highSignal).length,
    total: typeof total === "number" ? total : (total?.value ?? hits.length),
  };
}
