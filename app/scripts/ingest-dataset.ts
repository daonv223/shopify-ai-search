// Local ingest test without a Shopify store (task 1.2 verification):
// feeds benchmark/dataset/products.jsonl (499 L'Occitane IL products, the
// Phase 0 corpus) through the same indexProducts() core the bulk-operation
// path uses, then checks the acceptance behaviors that don't need OAuth:
// doc count (A1-shape), anchor searchability (A9), final-letter folding (A2),
// idempotent re-run (A6), stale-flag semantics (A3/A4), vanished-product sweep.
//
// Run from app/:  node --env-file=.env --import tsx scripts/ingest-dataset.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import db from "../app/db.server";
import { opensearch } from "../app/services/opensearch.server";
import { indexProducts } from "../app/services/product-index.server";
import type { ProductInput } from "../app/services/product-doc.server";

const SHOP = "local-dataset.myshopify.com";
const ALIAS = "products_local_dataset";
const DATASET = path.resolve(import.meta.dirname, "../../benchmark/dataset/products.jsonl");
const ANCHOR = "shimmering-body-oil-100ml";

interface DatasetRow {
  id: number;
  handle: string;
  url: string;
  title: string;
  product_type: string;
  vendor: string;
  tags: string[];
  body: string;
  options: { name: string; values: string[] }[];
  variants: {
    title: string;
    sku?: string;
    price: string | number;
    available: boolean;
    option1?: string;
    option2?: string;
    option3?: string;
  }[];
  images: { src?: string }[];
  available: boolean;
  updated_at: string;
}

function toInput(row: DatasetRow): ProductInput {
  const optionNames = (row.options ?? []).map((o) => o.name);
  return {
    id: String(row.id),
    handle: row.handle,
    title: row.title,
    productType: row.product_type ?? "",
    vendor: row.vendor ?? "",
    tags: row.tags ?? [],
    body: row.body ?? "", // dataset body is already HTML-stripped
    url: row.url,
    imageUrl: row.images?.[0]?.src,
    options: (row.options ?? []).filter((o) => o.name !== "Title"),
    variants: (row.variants ?? []).map((v) => ({
      title: v.title,
      sku: v.sku || undefined,
      price: v.price != null ? Number(v.price) : undefined,
      available: v.available,
      selectedOptions: [v.option1, v.option2, v.option3]
        .map((value, i) => ({ name: optionNames[i], value: value as string }))
        .filter((o) => o.name && o.value && o.name !== "Title"),
    })),
    metafields: [],
    updatedAt: row.updated_at,
  };
}

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const rows: DatasetRow[] = readFileSync(DATASET, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const inputs = rows.map(toInput);
  console.log(`Dataset: ${inputs.length} products\n`);

  // Clean slate so re-runs of this script are themselves deterministic.
  await db.productSyncState.deleteMany({ where: { shop: SHOP } });
  await opensearch.indices
    .delete({ index: `${ALIAS}_v1` }, { ignore: [404] })
    .catch(() => {});

  // 1. Full ingest
  const r1 = await indexProducts(SHOP, ALIAS, inputs, { fullSync: true });
  const count1 = (await opensearch.count({ index: ALIAS })).body.count;
  check("full ingest: all products indexed", count1 === inputs.length, `${count1}/${inputs.length}`);
  check("full ingest: everything marked embedding-stale", r1.newlyStale === inputs.length, `${r1.newlyStale}`);

  // 2. Anchor product searchable (A9)
  const search = await opensearch.search({
    index: ALIAS,
    body: { query: { match: { title: "שימר" } }, size: 5 },
  });
  const hits = search.body.hits.hits.map((h) => (h._source as { handle: string }).handle);
  check("anchor searchable via title match on שימר (A9)", hits.includes(ANCHOR), hits.join(", "));

  // 3. Final-letter folding active (A2)
  const analyzed = await opensearch.indices.analyze({
    index: ALIAS,
    body: { analyzer: "hebrew_search", text: "שקדים" },
  });
  const token = analyzed.body.tokens?.[0]?.token;
  check("final-letter folding: שקדים -> שקדימ (A2)", token === "שקדימ", token);

  // 4. Idempotent re-run (A6)
  const r2 = await indexProducts(SHOP, ALIAS, inputs, { fullSync: true });
  const count2 = (await opensearch.count({ index: ALIAS })).body.count;
  check("re-run: no duplicates (A6)", count2 === inputs.length, `${count2}`);
  check("re-run: nothing newly stale (A6)", r2.newlyStale === 0 && r2.deleted === 0, `stale ${r2.newlyStale}, deleted ${r2.deleted}`);

  // 5. Stale-flag semantics (A3/A4). Pretend the anchor was embedded, then
  // change price only (hash stable) vs title (hash changes).
  const anchorId = String(rows.find((r) => r.handle === ANCHOR)!.id);
  await db.productSyncState.update({
    where: { shop_productId: { shop: SHOP, productId: anchorId } },
    data: { embeddingStale: false },
  });
  const priceChanged = inputs.map((p) =>
    p.id === anchorId
      ? { ...p, variants: p.variants.map((v) => ({ ...v, price: (v.price ?? 0) + 10 })) }
      : p,
  );
  await indexProducts(SHOP, ALIAS, priceChanged);
  let state = await db.productSyncState.findUnique({
    where: { shop_productId: { shop: SHOP, productId: anchorId } },
  });
  check("price-only change keeps embedding fresh (A4)", state!.embeddingStale === false);

  const titleChanged = inputs.map((p) =>
    p.id === anchorId ? { ...p, title: p.title + " חדש" } : p,
  );
  await indexProducts(SHOP, ALIAS, titleChanged);
  state = await db.productSyncState.findUnique({
    where: { shop_productId: { shop: SHOP, productId: anchorId } },
  });
  check("title change marks embedding stale (A3)", state!.embeddingStale === true);

  // 6. Vanished-product sweep (fullSync)
  const r3 = await indexProducts(SHOP, ALIAS, inputs.slice(0, -1), { fullSync: true });
  const count3 = (await opensearch.count({ index: ALIAS })).body.count;
  check("full sync removes vanished products", r3.deleted === 1 && count3 === inputs.length - 1, `deleted ${r3.deleted}, count ${count3}`);

  // Restore the full corpus for whoever uses this index next.
  await indexProducts(SHOP, ALIAS, inputs, { fullSync: true });

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().finally(() => db.$disconnect());
