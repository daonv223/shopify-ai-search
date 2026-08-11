// Shared plumbing for the NLP regression harness (spec §3.5).
//
// Seeds from the frozen Phase 0 corpus (benchmark/dataset/) so tier hit-rates
// are directly comparable to the benchmark's numbers (lexical-morph 74%
// overall, stemming 97%). Lexical legs only — no embeddings, no kNN.
import { readFileSync } from "node:fs";
import path from "node:path";

import { opensearch } from "../../app/services/opensearch.server";

// Distinct from the production `products_{shop}` alias pattern so a harness
// run can never touch a dev-store index.
export const TEST_ALIAS = "nlp-harness-products";

const DATASET = path.resolve(import.meta.dirname, "../../../benchmark/dataset");

export type RelevanceRow = {
  query: string;
  tier: "baseline" | "stemming" | "prefixes" | "typos" | "semantic";
  positives: string[];
};

// Anchor product (benchmark ground_truth.json): שמן גוף & שימר שקדים למראה עור זוהר
export const ANCHOR = "shimmering-body-oil-100ml";

function jsonl(file: string): any[] {
  return readFileSync(path.join(DATASET, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function loadRelevance(): RelevanceRow[] {
  return jsonl("query_relevance.jsonl");
}

export function tierQueries(tier: RelevanceRow["tier"]): RelevanceRow[] {
  return loadRelevance().filter((r) => r.tier === tier);
}

// Map a frozen-corpus row onto the searchable text fields of the production
// mapping (same derivation as the benchmark's 01_ingest_catalog.py).
export function loadCorpusDocs(): { handle: string; doc: object }[] {
  return jsonl("products.jsonl").map((p) => {
    const variants: any[] = p.variants ?? [];
    const options: any[] = p.options ?? [];
    return {
      handle: p.handle,
      doc: {
        product_id: String(p.id),
        handle: p.handle,
        url: p.url,
        title: p.title ?? "",
        body: p.body ?? "",
        tags: p.tags ?? [],
        product_type: p.product_type ?? "",
        vendor: p.vendor ?? "",
        variant_titles: variants.map((v) => v.title ?? ""),
        option_values: [...new Set(options.flatMap((o) => o.values ?? []))],
        sku: variants.map((v) => v.sku).filter(Boolean),
        price_min: p.price_min,
        price_max: p.price_max,
        available: p.available,
        updated_at: p.updated_at,
      },
    };
  });
}

// Field weights carried over from the benchmark's 04_run_queries.py, plus
// metafield_text (searchable in the production mapping, empty in the corpus).
const BASE_FIELDS = [
  "title^3",
  "tags^2",
  "product_type^2",
  "variant_titles^1.5",
  "option_values^1.5",
  "vendor",
  "body",
  "metafield_text",
];
const MORPH_FIELDS = BASE_FIELDS.map((f) =>
  f.includes("^") ? f.replace("^", ".morph^") : `${f}.morph`,
);

// Morphology leg: plain match over the `.morph` subfields — the multiplexed
// analyzer does all the work, the query stays a vanilla multi_match.
export function morphLegQuery(query: string): object {
  return {
    multi_match: {
      query,
      fields: MORPH_FIELDS,
      type: "best_fields",
      operator: "or",
    },
  };
}

// Typo leg per spec §3.4: fuzziness 1 with transpositions (NOT AUTO — AUTO
// grants distance-2 on longer tokens, the `oil`→`OILS` pollution),
// prefix_length 0 (Hebrew clitics shift every character position), and BARE
// fields only — never `.morph` (stacking degraded the lexical tier 90%→66%,
// benchmark verdict.md; the guard test in retrieval.test.ts encodes this).
// Task 2.4 (§3.4) promotes this into the app's search service; the harness
// should then import it from there.
export function fuzzyLegQuery(query: string): object {
  return {
    multi_match: {
      query,
      fields: BASE_FIELDS,
      type: "best_fields",
      operator: "or",
      fuzziness: "1",
      prefix_length: 0,
      fuzzy_transpositions: true,
      max_expansions: 50,
    },
  };
}

export async function searchHandles(
  query: object,
  size = 10,
): Promise<string[]> {
  const res = await opensearch.search({
    index: TEST_ALIAS,
    body: { size, _source: ["handle"], query } as never,
  });
  return (res.body.hits.hits as any[]).map((h) => h._source.handle);
}

// Benchmark metric (06_report.py): relevant found in the top 10, normalized by
// min(10, |relevant|) so small concepts can still score 1.0.
export function hit10(top10: string[], positives: string[]): number {
  const found = top10.filter((h) => positives.includes(h)).length;
  return positives.length ? found / Math.min(10, positives.length) : 0;
}

export async function tierHitRate(
  rows: RelevanceRow[],
  leg: (q: string) => object,
): Promise<{ mean: number; perQuery: Record<string, number> }> {
  const perQuery: Record<string, number> = {};
  for (const row of rows) {
    perQuery[row.query] = hit10(await searchHandles(leg(row.query)), row.positives);
  }
  const scores = Object.values(perQuery);
  return { mean: scores.reduce((a, b) => a + b, 0) / scores.length, perQuery };
}

export async function analyzeTokens(
  analyzer: string,
  text: string,
): Promise<string[]> {
  const res = await opensearch.indices.analyze({
    index: TEST_ALIAS,
    body: { analyzer, text },
  });
  return (res.body.tokens ?? []).map((t: { token: string }) => t.token);
}

// Batched _analyze for single-token words: joins words with spaces (each gets
// one position from the standard tokenizer; multiplexer variants share their
// original's position) and groups the output tokens back per input word.
export async function opensearchAnalyzeBatch(
  analyzer: string,
  words: string[],
  chunkSize = 200,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize);
    const res = await opensearch.indices.analyze({
      index: TEST_ALIAS,
      body: { analyzer, text: chunk.join(" ") },
    });
    for (const t of res.body.tokens as { token: string; position: number }[]) {
      const word = chunk[t.position];
      if (!out.has(word)) out.set(word, new Set());
      out.get(word)!.add(t.token);
    }
  }
  return out;
}
