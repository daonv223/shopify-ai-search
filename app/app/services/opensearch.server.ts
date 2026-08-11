import { Client } from "@opensearch-project/opensearch";

export const EMBED_DIM = 3072; // gemini-embedding-001, per Phase 0 benchmark

export const opensearch = new Client({
  node: process.env.OPENSEARCH_URL ?? "http://localhost:9200",
});

// Phase 2 analyzer stack, ported from the validated benchmark design
// (benchmark/part2_retrieval/03_index_opensearch.py). Every text field is
// indexed twice so retrieval legs stay independently addressable:
//   <field>        `hebrew_text`  — final-letter folding + lowercase (exact/fuzzy legs)
//   <field>.morph  `hebrew_morph` — same + `he_variants` multiplexer (morphology leg)
//
// Hebrew clitics are ambiguous with root letters — ש is a prefix in שמן-לא but
// the first root letter of שיער/שימר — so stripping runs inside a `multiplexer`
// that emits the ORIGINAL token plus every variant at the same position; no
// real word is ever destroyed (מראה keeps מראה and also emits ראה).
//
// Suffix folding puts plural and construct forms on the same stem as the
// singular: שמנים → שמנ, שמני → שמנ, שמן → שמנ. The pattern matches ימ/יימ (not
// ים/יים) because the char_filter has already folded the final mem by the time
// token filters run. Deliberately does NOT strip feminine ה/ת — that over-stems
// common roots (בית → בי).
const HE_PREFIX = "^[ובלמכהש](?=[א-ת]{3,}$)";
const HE_SUFFIX = "(?<=[א-ת]{2})(יימ|ימ|ות|י)$";

// Feminine ־ה singulars never meet their ־ות/־ימ plurals: the plural's suffix
// strips (אריזות → אריז) but the singular keeps its ה (general ה-stripping is
// excluded — it over-stems). Corpus audit (scripts/nlp-audit.ts §C): curated
// retrieval-relevant nouns only, each mapped onto the stem its plural already
// produces. Runs inside the suffix chains, so prefixed forms (באריזה) are
// covered by the existing prefix strips.
const HE_FEM_SINGULAR_RULES = [
  "אריזה => אריז", // packaging / refill
  "מסכה => מסכ", // mask
  "נסיעה => נסיע", // travel (kits)
  "לילה => ליל", // night (cream)
  "חומצה => חומצ", // acid (hyaluronic)
  "פורמולה => פורמול", // formula
  "שכבה => שכב", // layer
  "מידה => מיד", // size
  "תחושה => תחוש", // sensation
  "תוצאה => תוצא", // result
  "נגיעה => נגיע", // touch (of color)
  "טיפה => טיפ", // drop
  "סדרה => סדר", // product line
  "טכניקה => טכניק", // technique
  "אומגה => אומג", // omega (3/6)
];

const TEXT = {
  type: "text",
  analyzer: "hebrew_text",
  fields: { morph: { type: "text", analyzer: "hebrew_morph" } },
};

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
      filter: {
        he_strip_prefix: {
          type: "pattern_replace",
          pattern: HE_PREFIX,
          replacement: "",
        },
        he_strip_suffix: {
          type: "pattern_replace",
          pattern: HE_SUFFIX,
          replacement: "",
        },
        he_fem_singular: {
          type: "stemmer_override",
          rules: HE_FEM_SINGULAR_RULES,
        },
        // Emits the original token plus each chain's output at the same
        // position. Double prefix chains cover stacked clitics (ולמראה).
        he_variants: {
          type: "multiplexer",
          preserve_original: true,
          filters: [
            "he_fem_singular,he_strip_suffix",
            "he_strip_prefix",
            "he_strip_prefix,he_fem_singular,he_strip_suffix",
            "he_strip_prefix,he_strip_prefix",
            "he_strip_prefix,he_strip_prefix,he_fem_singular,he_strip_suffix",
          ],
        },
      },
      analyzer: {
        hebrew_text: {
          type: "custom",
          char_filter: ["he_final_letters"],
          tokenizer: "standard",
          filter: ["lowercase"],
        },
        hebrew_morph: {
          type: "custom",
          char_filter: ["he_final_letters"],
          tokenizer: "standard",
          filter: ["lowercase", "he_variants"],
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
      product_type: { ...TEXT, fields: { ...TEXT.fields, raw: { type: "keyword" } } },
      vendor: { ...TEXT, fields: { ...TEXT.fields, raw: { type: "keyword" } } },
      variant_titles: TEXT,
      option_values: TEXT,
      metafield_text: TEXT,
      category_name: { ...TEXT, fields: { ...TEXT.fields, raw: { type: "keyword" } } },
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

// Rebuild the physical index behind `alias` with the current INDEX_BODY and
// flip the alias (spec §3.6): create the next _vN, _reindex into it (analyzers
// re-run automatically; stored fields and vectors carry over, so no Shopify
// re-fetch and no re-embedding), verify the doc count, swap the alias in one
// atomic updateAliases call so search keeps answering throughout, then delete
// the old index. Writes that land between the reindex snapshot and the alias
// flip stay in the old index and are dropped with it — run during a quiet
// window; the webhook pipeline re-syncs any product on its next update.
export async function migrateIndex(alias: string): Promise<string> {
  const res = await opensearch.indices.getAlias({ name: alias }, { ignore: [404] });
  if (res.statusCode === 404) return ensureIndex(alias);

  const current = Object.keys(res.body)[0];
  const version = Number(current.match(/_v(\d+)$/)?.[1] ?? 1);
  const next = `${alias}_v${version + 1}`;

  // A leftover from an aborted migration is stale — rebuild from scratch.
  const leftover = await opensearch.indices.exists({ index: next });
  if (leftover.body) await opensearch.indices.delete({ index: next });
  await opensearch.indices.create({ index: next, body: INDEX_BODY as never });

  await opensearch.reindex(
    {
      refresh: true,
      wait_for_completion: true,
      body: { source: { index: current }, dest: { index: next } },
    },
    { requestTimeout: 600_000 },
  );

  const [oldCount, newCount] = await Promise.all([
    opensearch.count({ index: current }),
    opensearch.count({ index: next }),
  ]);
  if (newCount.body.count !== oldCount.body.count) {
    await opensearch.indices.delete({ index: next });
    throw new Error(
      `migrateIndex(${alias}): reindex count mismatch ` +
        `(${current}=${oldCount.body.count}, ${next}=${newCount.body.count}); ` +
        `${next} discarded, alias untouched`,
    );
  }

  await opensearch.indices.updateAliases({
    body: {
      actions: [
        { remove: { index: current, alias } },
        { add: { index: next, alias } },
      ],
    },
  });
  await opensearch.indices.delete({ index: current });
  return next;
}

export async function deleteIndex(alias: string): Promise<void> {
  const res = await opensearch.indices.getAlias({ name: alias }, { ignore: [404] });
  if (res.statusCode === 404) return;
  await opensearch.indices.delete({ index: Object.keys(res.body).join(",") });
}
