import db from "../db.server";
import { ensureIndex, opensearch } from "./opensearch.server";
import { contentHash, toSearchDoc, type ProductInput } from "./product-doc.server";

export interface IndexResult {
  indexed: number;
  deleted: number;
  newlyStale: number;
}

const BATCH = 250;

// Shared core of both sync paths: bulk ingest (task 1.2) and, later, the
// webhook processor (task 1.3) reuse this for any set of products.
//
// Changed-text detection: a product whose content hash matches its stored
// ProductSyncState keeps its current embedding_stale flag (an unchanged
// product that already has a vector stays fresh); new or changed products are
// marked stale for Phase 3.2's embedder. fullSync additionally removes
// products that vanished from the catalog since the last sync.
export async function indexProducts(
  shop: string,
  indexAlias: string,
  inputs: ProductInput[],
  opts: { fullSync?: boolean } = {},
): Promise<IndexResult> {
  await ensureIndex(indexAlias);

  // fullSync needs every state row for vanished-product detection; the
  // single-product webhook path only needs the rows it's touching.
  const existing = new Map(
    (
      await db.productSyncState.findMany({
        where: opts.fullSync
          ? { shop }
          : { shop, productId: { in: inputs.map((p) => p.id) } },
        select: { productId: true, contentHash: true, embeddingStale: true },
      })
    ).map((s) => [s.productId, s]),
  );

  let newlyStale = 0;
  const now = new Date();
  const states: { productId: string; hash: string; stale: boolean }[] = [];

  for (let i = 0; i < inputs.length; i += BATCH) {
    const chunk = inputs.slice(i, i + BATCH);
    const lines: object[] = [];
    for (const p of chunk) {
      const hash = contentHash(p);
      const prev = existing.get(p.id);
      const stale = prev && prev.contentHash === hash ? prev.embeddingStale : true;
      if (stale && !(prev?.embeddingStale ?? false)) newlyStale += 1;
      states.push({ productId: p.id, hash, stale });
      lines.push({ index: { _index: indexAlias, _id: p.id } });
      lines.push({ ...toSearchDoc(p), content_hash: hash, embedding_stale: stale });
    }
    const res = await opensearch.bulk({ body: lines });
    if (res.body.errors) {
      const bad = res.body.items.find((it: { index?: { error?: unknown } }) => it.index?.error);
      throw new Error(`bulk index errors: ${JSON.stringify(bad?.index?.error).slice(0, 500)}`);
    }
  }

  for (let i = 0; i < states.length; i += 100) {
    await db.$transaction(
      states.slice(i, i + 100).map((s) =>
        db.productSyncState.upsert({
          where: { shop_productId: { shop, productId: s.productId } },
          update: { contentHash: s.hash, embeddingStale: s.stale, lastSyncedAt: now },
          create: {
            shop,
            productId: s.productId,
            contentHash: s.hash,
            embeddingStale: s.stale,
            lastSyncedAt: now,
          },
        }),
      ),
    );
  }

  let deleted = 0;
  if (opts.fullSync) {
    const seen = new Set(states.map((s) => s.productId));
    const vanished = [...existing.keys()].filter((id) => !seen.has(id));
    if (vanished.length) {
      await opensearch.bulk({
        body: vanished.map((id) => ({ delete: { _index: indexAlias, _id: id } })),
      });
      await db.productSyncState.deleteMany({
        where: { shop, productId: { in: vanished } },
      });
      deleted = vanished.length;
    }
  }

  await opensearch.indices.refresh({ index: indexAlias });
  return { indexed: inputs.length, deleted, newlyStale };
}

export async function removeProduct(shop: string, indexAlias: string, productId: string) {
  await opensearch.delete({ index: indexAlias, id: productId }, { ignore: [404] });
  await db.productSyncState.deleteMany({ where: { shop, productId } });
}
