import db from "../db.server";
import { opensearch } from "./opensearch.server";
import { composeEmbeddingInput } from "./product-doc.server";
import { defaultEmbeddingProvider, type EmbeddingProvider } from "./embedding.server";

// Embedding backfill worker (task 3.2): embed every product whose
// ProductSyncState says embedding_stale, write the vector into the index,
// clear the flag. Cost discipline: only stale products are ever embedded —
// content_hash keeps price/inventory edits from landing here at all.

export interface BackfillResult {
  embedded: number;
  missing: number; // stale in DB but doc absent from the index (out-of-sync row)
}

const EMBED_BATCH = 50; // Gemini batch size; also the bulk-write unit

export async function backfillEmbeddings(
  shop: string,
  indexAlias: string,
  provider: EmbeddingProvider,
): Promise<BackfillResult> {
  const stale = await db.productSyncState.findMany({
    where: { shop, embeddingStale: true },
    select: { productId: true },
  });

  let embedded = 0;
  let missing = 0;
  for (let i = 0; i < stale.length; i += EMBED_BATCH) {
    const ids = stale.slice(i, i + EMBED_BATCH).map((s) => s.productId);

    // The indexed doc carries title/product_type/tags/body verbatim, so the
    // embedding input is recomposed from _source — no Shopify re-fetch.
    const res = await opensearch.mget({
      index: indexAlias,
      _source: ["title", "product_type", "tags", "body", "content_hash"],
      body: { ids },
    });
    type StaleDoc = {
      _id: string;
      found: boolean;
      _source: {
        title?: string;
        product_type?: string;
        tags?: string[];
        body?: string;
        content_hash?: string;
      };
    };
    const docs = (res.body.docs as StaleDoc[]).filter((d) => d.found);
    missing += ids.length - docs.length;
    if (!docs.length) continue;

    const inputs = docs.map((d) =>
      composeEmbeddingInput({
        title: d._source.title ?? "",
        productType: d._source.product_type ?? "",
        tags: d._source.tags ?? [],
        body: d._source.body ?? "",
      }),
    );
    const vectors = await provider.embed(inputs, "RETRIEVAL_DOCUMENT");

    const bulk = await opensearch.bulk({
      body: docs.flatMap((d, j) => [
        { update: { _index: indexAlias, _id: d._id } },
        { doc: { embedding: vectors[j], embedding_stale: false } },
      ]),
    });
    if (bulk.body.errors) {
      const bad = bulk.body.items.find((it: { update?: { error?: unknown } }) => it.update?.error);
      throw new Error(`bulk vector write errors: ${JSON.stringify(bad?.update?.error).slice(0, 500)}`);
    }

    // Resumable: a product's DB flag clears only after its vector is written —
    // a crash mid-run loses nothing. The clear is conditional on the content
    // hash we embedded, so a product re-marked stale mid-run (newer edit)
    // keeps its flag and gets re-embedded on the next sweep.
    await db.$transaction(
      docs.map((d) =>
        db.productSyncState.updateMany({
          where: {
            shop,
            productId: d._id,
            embeddingStale: true,
            contentHash: d._source.content_hash ?? "",
          },
          data: { embeddingStale: false },
        }),
      ),
    );
    embedded += docs.length;
  }

  if (embedded) await opensearch.indices.refresh({ index: indexAlias });
  return { embedded, missing };
}

// Debounced per-shop trigger (spec §3.2): webhook bursts and post-ingest kicks
// collapse into one sweep a few seconds after the last kick. Fire-and-forget;
// a real queue is Phase 5.3. Freshness target is minutes, not seconds.
const DEBOUNCE_MS = 5_000;
const pending = new Map<string, NodeJS.Timeout>();

export function scheduleEmbeddingBackfill(shop: string, indexAlias: string): void {
  clearTimeout(pending.get(shop));
  pending.set(
    shop,
    setTimeout(() => {
      pending.delete(shop);
      const provider = defaultEmbeddingProvider();
      if (!provider) {
        console.log(`[embedding] ${shop}: GEMINI_API_KEY not set, skipping backfill`);
        return;
      }
      backfillEmbeddings(shop, indexAlias, provider)
        .then(({ embedded, missing }) =>
          console.log(`[embedding] ${shop}: embedded ${embedded}, missing ${missing}`),
        )
        .catch((err) => console.error(`[embedding] ${shop} backfill failed:`, err));
    }, DEBOUNCE_MS),
  );
}
