import readline from "node:readline";
import { Readable } from "node:stream";
import db from "../db.server";
import { indexProducts, type IndexResult } from "./product-index.server";
import { stripHtml, type ProductInput } from "./product-doc.server";

type GraphqlFn = (
  query: string,
  opts?: { variables?: Record<string, unknown> },
) => Promise<Response>;

// Bulk queries paginate connections themselves — no first/after args. Nested
// connections (variants, metafields) arrive as separate JSONL lines carrying
// __parentId; plain nested objects (options, category, selectedOptions) stay
// inline on their parent line.
const BULK_QUERY = `
{
  products(query: "status:active") {
    edges {
      node {
        id
        handle
        title
        productType
        vendor
        tags
        descriptionHtml
        onlineStoreUrl
        updatedAt
        category { id name }
        options { name values }
        featuredMedia { preview { image { url altText } } }
        metafields {
          edges { node { id namespace key value type } }
        }
        variants {
          edges {
            node {
              id
              title
              sku
              barcode
              price
              availableForSale
              selectedOptions { name value }
            }
          }
        }
      }
    }
  }
}`;

const gidToId = (gid: string) => gid.slice(gid.lastIndexOf("/") + 1);

// Kick off a full catalog ingest (on demand via the "Sync All Catalog" button).
// Shopify allows one running bulk query per shop; a second start is a no-op.
export async function startCatalogIngest(graphql: GraphqlFn, shop: string): Promise<string | null> {
  const running = await db.syncRun.findFirst({ where: { shop, status: "running" } });
  if (running) return null;

  const res = await graphql(
    `mutation($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { variables: { query: BULK_QUERY } },
  );
  const body = await res.json();
  const op = body.data?.bulkOperationRunQuery;
  if (!op?.bulkOperation) {
    throw new Error(`bulkOperationRunQuery failed: ${JSON.stringify(op?.userErrors)}`);
  }

  const run = await db.syncRun.create({
    data: { shop, status: "running", bulkOperationId: op.bulkOperation.id },
  });
  return run.id;
}

interface BulkProductRow {
  id: string;
  handle: string;
  title: string;
  productType: string;
  vendor: string;
  tags: string[];
  descriptionHtml: string;
  onlineStoreUrl?: string;
  updatedAt: string;
  category?: { name: string };
  options?: { name: string; values: string[] }[];
  featuredMedia?: { preview?: { image?: { url: string; altText?: string } } };
}

// Stream-parse a bulk operation JSONL result into ProductInputs. Child lines
// always follow their parent, so a single accumulator map suffices; memory
// holds the composed inputs (small), never the raw file.
export async function parseBulkJsonl(stream: NodeJS.ReadableStream): Promise<ProductInput[]> {
  const products = new Map<string, ProductInput>();
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const gid: string = row.id ?? "";

    if (gid.includes("/Product/")) {
      const p = row as BulkProductRow;
      const image = p.featuredMedia?.preview?.image;
      products.set(gid, {
        id: gidToId(gid),
        handle: p.handle,
        title: p.title,
        productType: p.productType ?? "",
        vendor: p.vendor ?? "",
        tags: p.tags ?? [],
        body: stripHtml(p.descriptionHtml ?? ""),
        url: p.onlineStoreUrl ?? undefined,
        imageUrl: image?.url,
        imageAlt: image?.altText ?? undefined,
        categoryName: p.category?.name,
        options: (p.options ?? []).filter((o) => o.name !== "Title"),
        variants: [],
        metafields: [],
        updatedAt: p.updatedAt,
      });
    } else if (gid.includes("/ProductVariant/")) {
      const parent = products.get(row.__parentId);
      parent?.variants.push({
        title: row.title,
        sku: row.sku ?? undefined,
        barcode: row.barcode ?? undefined,
        price: row.price != null ? parseFloat(row.price) : undefined,
        available: row.availableForSale,
        selectedOptions: (row.selectedOptions ?? []).filter(
          (o: { name: string }) => o.name !== "Title",
        ),
      });
    } else if (gid.includes("/Metafield/")) {
      const parent = products.get(row.__parentId);
      parent?.metafields.push({
        namespace: row.namespace,
        key: row.key,
        value: String(row.value ?? ""),
      });
    }
  }
  return [...products.values()];
}

// bulk_operations/finish webhook processor. Called fire-and-forget after the
// webhook is acked; full retry/reconciliation hardening is task 5.3.
export async function processBulkOperationFinish(
  shop: string,
  payload: { admin_graphql_api_id: string },
  graphql: GraphqlFn,
): Promise<IndexResult> {
  const opId = payload.admin_graphql_api_id;
  const run = await db.syncRun.findFirst({
    where: { shop, bulkOperationId: opId },
    orderBy: { startedAt: "desc" },
  });

  const fail = async (message: string) => {
    if (run) {
      await db.syncRun.update({
        where: { id: run.id },
        data: { status: "failed", error: { message }, finishedAt: new Date() },
      });
    }
    throw new Error(message);
  };

  const res = await graphql(
    `query($id: ID!) {
      node(id: $id) {
        ... on BulkOperation { id status errorCode url objectCount }
      }
    }`,
    { variables: { id: opId } },
  );
  const op = (await res.json()).data?.node;
  if (!op || op.status !== "COMPLETED") {
    return fail(`bulk operation ${opId} not completed: ${op?.status} ${op?.errorCode ?? ""}`);
  }

  const shopRow = await db.shop.findUnique({ where: { id: shop } });
  if (!shopRow) return fail(`no Shop row for ${shop}`);

  let inputs: ProductInput[] = [];
  if (op.url) {
    const download = await fetch(op.url);
    if (!download.ok || !download.body) {
      return fail(`bulk result download failed: ${download.status}`);
    }
    inputs = await parseBulkJsonl(
      Readable.fromWeb(download.body as import("stream/web").ReadableStream),
    );
  } // no url => empty catalog; fall through and sync to zero

  const result = await indexProducts(shop, shopRow.indexAlias, inputs, { fullSync: true });

  if (run) {
    await db.syncRun.update({
      where: { id: run.id },
      data: { status: "success", productCount: result.indexed, finishedAt: new Date() },
    });
  }
  return result;
}
