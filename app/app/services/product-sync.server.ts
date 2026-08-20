import db from "../db.server";
import { scheduleEmbeddingBackfill } from "./embedding-backfill.server";
import { indexProducts, removeProduct } from "./product-index.server";
import { stripHtml, type ProductInput } from "./product-doc.server";

type GraphqlFn = (
  query: string,
  opts?: { variables?: Record<string, unknown> },
) => Promise<Response>;

// Single-product re-fetch for webhook sync (task 1.3). Webhook payloads omit
// metafields, so create/update always re-fetches via Admin GraphQL. Same
// fields as BULK_QUERY in ingest.server.ts, but with explicit pagination —
// only bulk operations auto-paginate connections.
const PRODUCT_QUERY = `
  query Product($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      status
      productType
      vendor
      tags
      descriptionHtml
      onlineStoreUrl
      updatedAt
      category { id name }
      options { name values }
      featuredMedia { preview { image { url altText } } }
      metafields(first: 250) {
        edges { node { namespace key value } }
      }
      variants(first: 250) {
        edges {
          node {
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
  }`;

interface GqlProduct {
  id: string;
  handle: string;
  title: string;
  status: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  descriptionHtml?: string;
  onlineStoreUrl?: string;
  updatedAt: string;
  category?: { name: string };
  options?: { name: string; values: string[] }[];
  featuredMedia?: { preview?: { image?: { url: string; altText?: string } } };
  metafields?: { edges: { node: { namespace: string; key: string; value: unknown } }[] };
  variants?: {
    edges: {
      node: {
        title: string;
        sku?: string;
        barcode?: string;
        price?: string;
        availableForSale: boolean;
        selectedOptions?: { name: string; value: string }[];
      };
    }[];
  };
}

const gidToId = (gid: string) => gid.slice(gid.lastIndexOf("/") + 1);

function toProductInput(p: GqlProduct): ProductInput {
  const image = p.featuredMedia?.preview?.image;
  return {
    id: gidToId(p.id),
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
    variants: (p.variants?.edges ?? []).map(({ node: v }) => ({
      title: v.title,
      sku: v.sku ?? undefined,
      barcode: v.barcode ?? undefined,
      price: v.price != null ? parseFloat(v.price) : undefined,
      available: v.availableForSale,
      selectedOptions: (v.selectedOptions ?? []).filter((o) => o.name !== "Title"),
    })),
    metafields: (p.metafields?.edges ?? []).map(({ node: m }) => ({
      namespace: m.namespace,
      key: m.key,
      value: String(m.value ?? ""),
    })),
    updatedAt: p.updatedAt,
  };
}

// products/create | products/update | products/delete processor. Called by the
// cron drain worker off a persisted WebhookEvent (task 5.3) — idempotent, so a
// re-picked-up event is safe. Also the reconciliation sweep's index path for a
// missing product. Changed-text detection lives in indexProducts (content hash
// → embedding_stale). Returns a short outcome string for logging.
export async function processProductWebhook(
  shop: string,
  topic: string,
  payload: { id: number | string },
  graphql: GraphqlFn | null,
): Promise<string> {
  const shopRow = await db.shop.findUnique({ where: { id: shop } });
  if (!shopRow) throw new Error(`no Shop row for ${shop}`);
  const productId = String(payload.id);

  if (topic === "PRODUCTS_DELETE") {
    await removeProduct(shop, shopRow.indexAlias, productId);
    return "removed";
  }

  if (!graphql) throw new Error(`no admin client to re-fetch product ${productId}`);

  const res = await graphql(PRODUCT_QUERY, {
    variables: { id: `gid://shopify/Product/${productId}` },
  });
  const product = (await res.json()).data?.product as GqlProduct | null;

  // Deleted between webhook and re-fetch, no longer ACTIVE, or unpublished from
  // the Online Store — only active AND published products are indexed
  // (publication visibility, task 5.3: onlineStoreUrl is null unless published
  // to the Online Store channel). Drop it in every case; removeProduct is a
  // no-op if it was never indexed, so unpublishing removes it the same way a
  // status change does.
  if (!product || product.status !== "ACTIVE" || !product.onlineStoreUrl) {
    await removeProduct(shop, shopRow.indexAlias, productId);
    if (!product) return "removed (gone)";
    return product.status !== "ACTIVE"
      ? `removed (status ${product.status})`
      : "removed (unpublished)";
  }

  const result = await indexProducts(shop, shopRow.indexAlias, [toProductInput(product)]);
  if (result.newlyStale) scheduleEmbeddingBackfill(shop, shopRow.indexAlias);
  return result.newlyStale ? "indexed, marked stale" : "indexed";
}
