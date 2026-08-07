import { Client } from "@opensearch-project/opensearch";

export const EMBED_DIM = 3072; // gemini-embedding-001, per Phase 0 benchmark

export const opensearch = new Client({
  node: process.env.OPENSEARCH_URL ?? "http://localhost:9200",
});

// Phase 1 analyzer: final-letter folding + lowercase only (spec §3.4). Phase 2
// replaces the internals of `hebrew_search` (morphology multiplexer, validated
// in benchmark/part2_retrieval/03_index_opensearch.py); field names and query
// contracts stay stable, the swap happens via reindex + alias flip.
const TEXT = { type: "text", analyzer: "hebrew_search" };

const INDEX_BODY = {
  settings: {
    index: { knn: true, number_of_shards: 1, number_of_replicas: 0 },
    analysis: {
      char_filter: {
        he_final_letters: {
          type: "mapping",
          mappings: ["ך => כ", "ם => מ", "ן => נ", "ף => פ", "ץ => צ"],
        },
      },
      analyzer: {
        hebrew_search: {
          type: "custom",
          char_filter: ["he_final_letters"],
          tokenizer: "standard",
          filter: ["lowercase"],
        },
      },
    },
  },
  mappings: {
    properties: {
      product_id: { type: "keyword" },
      handle: { type: "keyword" },
      url: { type: "keyword", index: false },
      image_url: { type: "keyword", index: false },
      image_alt: TEXT,
      title: TEXT,
      body: TEXT,
      tags: TEXT,
      product_type: { ...TEXT, fields: { raw: { type: "keyword" } } },
      vendor: { ...TEXT, fields: { raw: { type: "keyword" } } },
      variant_titles: TEXT,
      option_values: TEXT,
      metafield_text: TEXT,
      category_name: { ...TEXT, fields: { raw: { type: "keyword" } } },
      sku: { type: "keyword" },
      barcode: { type: "keyword" },
      // "Name::Value" pairs — the attribute vocabulary Phase 3.4 filter
      // extraction reads.
      option_facets: { type: "keyword" },
      price_min: { type: "float" },
      price_max: { type: "float" },
      available: { type: "boolean" },
      updated_at: { type: "date" },
      content_hash: { type: "keyword" },
      embedding_stale: { type: "boolean" },
      // Populated by Phase 3.2; hnsw/faiss/innerproduct matches the benchmark
      // (vectors are unit-normalized, so innerproduct is cosine).
      embedding: {
        type: "knn_vector",
        dimension: EMBED_DIM,
        method: {
          name: "hnsw",
          space_type: "innerproduct",
          engine: "faiss",
          parameters: { ef_construction: 256, m: 16 },
        },
      },
    },
  },
};

// One index per shop behind an alias (spec §3.4): products_{shop} -> _v1.
// Mapping changes build a _v2 and flip the alias; callers only ever see the alias.
export async function ensureIndex(alias: string): Promise<string> {
  const hasAlias = await opensearch.indices.existsAlias({ name: alias });
  if (hasAlias.body) return alias;

  const physical = `${alias}_v1`;
  const hasIndex = await opensearch.indices.exists({ index: physical });
  if (!hasIndex.body) {
    await opensearch.indices.create({
      index: physical,
      body: INDEX_BODY as never,
    });
  }
  await opensearch.indices.putAlias({ index: physical, name: alias });
  return alias;
}

export async function deleteIndex(alias: string): Promise<void> {
  const res = await opensearch.indices.getAlias({ name: alias }, { ignore: [404] });
  if (res.statusCode === 404) return;
  await opensearch.indices.delete({ index: Object.keys(res.body).join(",") });
}
