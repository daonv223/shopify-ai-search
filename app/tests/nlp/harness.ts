// Shared plumbing for the NLP regression harness (spec §3.5).
//
// Seeds from the frozen Phase 0 corpus (benchmark/dataset/) so tier hit-rates
// are directly comparable to the benchmark's numbers (lexical-morph 74%
// overall, stemming 97%). Vectors come from the benchmark's embedding cache
// (see embeddingCache below), so hybrid tests need no Gemini key.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { opensearch } from "../../app/services/opensearch.server";
import { composeEmbeddingInput } from "../../app/services/product-doc.server";

// Distinct from the production `products_{shop}` alias pattern so a harness
// run can never touch a dev-store index.
export const TEST_ALIAS = "nlp-harness-products";

const DATASET = path.resolve(import.meta.dirname, "../../../benchmark/dataset");

export type RelevanceRow = {
  query: string;
  tier: "baseline" | "stemming" | "prefixes" | "typos" | "semantic";
  positives: string[];
};

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

// Real Gemini vectors from the benchmark's disk cache, keyed by
// sha1(`${taskType}\0${text}`) (common.py EmbeddingClient). The app's
// composeEmbeddingInput is byte-identical to the benchmark's compose(), so
// every corpus doc and battery query resolves — verified 2026-08-14: 499/499
// docs, 18/18 queries, zero misses. The cache is gitignored (21MB); without
// it the corpus seeds vector-less and hybrid tests fail with the error below.
const EMBED_CACHE = path.resolve(
  import.meta.dirname,
  "../../../benchmark/part2_retrieval/cache/embeddings.json",
);

let embedCache: Record<string, number[]> | null | undefined;
function embeddingCache(): Record<string, number[]> | null {
  if (embedCache === undefined) {
    embedCache = existsSync(EMBED_CACHE)
      ? JSON.parse(readFileSync(EMBED_CACHE, "utf8"))
      : null;
  }
  return embedCache ?? null;
}

export const hasEmbeddingCache = () => embeddingCache() !== null;

// The cache stores raw API values; the production provider unit-normalizes
// before indexing (innerproduct == cosine), so match it here.
export function cachedVector(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
): number[] {
  const key = createHash("sha1").update(`${taskType}\x00${text}`, "utf8").digest("hex");
  const raw = embeddingCache()?.[key];
  if (!raw) {
    throw new Error(
      `embedding cache miss for ${taskType} ${JSON.stringify(text.slice(0, 60))} — ` +
        `rebuild ${EMBED_CACHE} with benchmark/part2_retrieval/03_index_opensearch.py + 04_run_queries.py`,
    );
  }
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
  return raw.map((x) => x / norm);
}

export function corpusDocVector(doc: {
  title?: string;
  product_type?: string;
  tags?: string[];
  body?: string;
}): number[] {
  const text = composeEmbeddingInput({
    title: doc.title ?? "",
    productType: doc.product_type ?? "",
    tags: doc.tags ?? [],
    body: doc.body ?? "",
  });
  return cachedVector(text, "RETRIEVAL_DOCUMENT");
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
