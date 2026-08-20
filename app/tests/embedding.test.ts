// Embedding lifecycle (spec acceptance A2): full sweep embeds everything and
// clears embedding_stale; a title edit re-embeds that product only; a
// price-only edit re-embeds nothing (content hash unchanged). Runs against a
// dedicated index + shop so the seeded nlp harness is untouched; the worker
// gets a deterministic in-memory provider — no live Gemini calls.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import db from "../app/db.server";
import { backfillEmbeddings } from "../app/services/embedding-backfill.server";
import type { EmbeddingProvider, EmbedTaskType } from "../app/services/embedding.server";
import { EMBED_DIM, deleteIndex, ensureIndex, opensearch } from "../app/services/opensearch.server";
import { indexProducts } from "../app/services/product-index.server";
import type { ProductInput } from "../app/services/product-doc.server";

const SHOP = "embed-test.myshopify.com";
const ALIAS = "embed-test-products";

class FakeProvider implements EmbeddingProvider {
  readonly modelId = "fake";
  calls: { texts: string[]; taskType: EmbedTaskType }[] = [];

  async embed(texts: string[], taskType: EmbedTaskType): Promise<number[][]> {
    this.calls.push({ texts: [...texts], taskType });
    return texts.map((_, i) => {
      const vec = new Array(EMBED_DIM).fill(0);
      vec[i % EMBED_DIM] = 1; // unit vector, deterministic
      return vec;
    });
  }
}

const product = (id: string, title: string, price = 10): ProductInput => ({
  id,
  handle: `p-${id}`,
  title,
  productType: "שמן גוף",
  vendor: "Test",
  tags: ["טיפוח"],
  body: "תיאור המוצר",
  options: [],
  variants: [{ title: "Default Title", price, available: true, selectedOptions: [] }],
  metafields: [],
});

const staleRows = () =>
  db.productSyncState.findMany({ where: { shop: SHOP, embeddingStale: true } });

const staleDocCount = async () => {
  const res = await opensearch.count({
    index: ALIAS,
    body: { query: { term: { embedding_stale: true } } } as never,
  });
  return res.body.count;
};

beforeAll(async () => {
  await deleteIndex(ALIAS);
  await db.productSyncState.deleteMany({ where: { shop: SHOP } });
  await ensureIndex(ALIAS);
});

afterAll(async () => {
  await deleteIndex(ALIAS);
  await db.productSyncState.deleteMany({ where: { shop: SHOP } });
  await db.$disconnect();
});

describe("embedding lifecycle (A2)", () => {
  it("full sweep embeds every stale product and clears the flags", async () => {
    await indexProducts(
      SHOP,
      ALIAS,
      [product("1", "שמן שקדים"), product("2", "קרם ידיים"), product("3", "מסכת פנים")],
      { fullSync: true },
    );
    expect(await staleRows()).toHaveLength(3);

    const provider = new FakeProvider();
    const result = await backfillEmbeddings(SHOP, ALIAS, provider);

    expect(result).toEqual({ embedded: 3, missing: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(await staleRows()).toHaveLength(0);
    expect(await staleDocCount()).toBe(0);

    const doc = await opensearch.get({ index: ALIAS, id: "1" });
    const src = doc.body._source as { embedding: number[]; embedding_stale: boolean };
    expect(src.embedding).toHaveLength(EMBED_DIM);
    expect(src.embedding_stale).toBe(false);
  });

  it("re-embeds only the product whose title changed", async () => {
    await indexProducts(SHOP, ALIAS, [product("2", "קרם ידיים מועשר")]);
    expect((await staleRows()).map((s) => s.productId)).toEqual(["2"]);

    const provider = new FakeProvider();
    const result = await backfillEmbeddings(SHOP, ALIAS, provider);

    expect(result).toEqual({ embedded: 1, missing: 0 });
    expect(provider.calls[0].texts).toHaveLength(1);
    expect(provider.calls[0].texts[0]).toContain("קרם ידיים מועשר");
    expect(await staleRows()).toHaveLength(0);
  });

  it("embeds nothing after a price-only edit (hash unchanged)", async () => {
    await indexProducts(SHOP, ALIAS, [product("3", "מסכת פנים", 99)]);
    expect(await staleRows()).toHaveLength(0);

    const provider = new FakeProvider();
    const result = await backfillEmbeddings(SHOP, ALIAS, provider);

    expect(result).toEqual({ embedded: 0, missing: 0 });
    expect(provider.calls).toHaveLength(0);
  });
});
