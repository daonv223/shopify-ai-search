// Phase 5 task 5.3 (spec §3.3, acceptance C2) — webhook durability and the
// reconciliation safety net. Exercises the cron drain + sweep against the real
// Postgres + OpenSearch harness index, with an injected fake admin client so no
// Shopify session is needed. Asserts: a pending event drains to `processed`
// with the product indexed exactly once (idempotent on re-pick-up); a `failed`
// event is NOT retried; the daily sweep repairs a manually-deleted
// ProductSyncState row and an unpublished product.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TEST_ALIAS } from "../nlp/harness";

// shopify.server.ts validates its config at import time (webhook-drain pulls it
// in via `unauthenticated`) — set env before the dynamic imports.
process.env.SHOPIFY_API_KEY ??= "ops-test-key";
process.env.SHOPIFY_API_SECRET ??= "ops-test-secret";
process.env.SHOPIFY_APP_URL ??= "https://ops-test.example";
process.env.SCOPES ??= "read_products";

const SHOP = "ops-harness.myshopify.com";
const PID = "9001";
const GID = `gid://shopify/Product/${PID}`;

const db = (await import("../../app/db.server")).default;
const { opensearch } = await import("../../app/services/opensearch.server");
const { drainWebhookEvents } = await import("../../app/services/webhook-drain.server");
const { reconcileShop } = await import("../../app/services/reconcile.server");

type Product = { status: string; onlineStoreUrl: string | null };

// A fake admin.graphql that answers the single-product re-fetch and the
// reconcile product-list query from an in-memory catalog keyed by product id.
function fakeAdmin(catalog: Map<string, Product>) {
  const graphql = async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    let data: unknown;
    if (query.includes("query Product(")) {
      const id = String((opts?.variables?.id as string) ?? "").split("/").pop() ?? "";
      const p = catalog.get(id);
      data = {
        product: p
          ? {
              id: GID,
              handle: `p-${id}`,
              title: `Product ${id}`,
              status: p.status,
              productType: "Widget",
              vendor: "Acme",
              tags: [],
              descriptionHtml: "<p>desc</p>",
              onlineStoreUrl: p.onlineStoreUrl,
              updatedAt: "2026-08-20T00:00:00Z",
              options: [],
              variants: { edges: [] },
              metafields: { edges: [] },
            }
          : null,
      };
    } else if (query.includes("products(first:")) {
      const edges = [...catalog.entries()].map(([id, p]) => ({
        node: { id: `gid://shopify/Product/${id}`, status: p.status, onlineStoreUrl: p.onlineStoreUrl },
      }));
      data = { products: { pageInfo: { hasNextPage: false, endCursor: "" }, edges } };
    }
    return new Response(JSON.stringify({ data }), {
      headers: { "content-type": "application/json" },
    });
  };
  return async () => graphql;
}

const docExists = async (id: string) =>
  (await opensearch.exists({ index: TEST_ALIAS, id })).body === true;
const stateCount = () => db.productSyncState.count({ where: { shop: SHOP, productId: PID } });

beforeAll(async () => {
  await db.shop.upsert({
    where: { id: SHOP },
    update: { indexAlias: TEST_ALIAS, uninstalledAt: null },
    create: { id: SHOP, indexAlias: TEST_ALIAS },
  });
});

afterAll(async () => {
  await opensearch.delete({ index: TEST_ALIAS, id: PID }, { ignore: [404] });
  await db.webhookEvent.deleteMany({ where: { shop: SHOP } });
  await db.productSyncState.deleteMany({ where: { shop: SHOP } });
  await db.shop.deleteMany({ where: { id: SHOP } });
  await db.$disconnect();
});

beforeEach(async () => {
  await db.webhookEvent.deleteMany({ where: { shop: SHOP } });
  await db.productSyncState.deleteMany({ where: { shop: SHOP } });
  await opensearch.delete({ index: TEST_ALIAS, id: PID }, { ignore: [404] });
  await opensearch.indices.refresh({ index: TEST_ALIAS });
});

describe("webhook drain durability (C2)", () => {
  it("drains a pending products/update to processed and indexes exactly once", async () => {
    const catalog = new Map([[PID, { status: "ACTIVE", onlineStoreUrl: "https://shop/p" }]]);
    const ev = await db.webhookEvent.create({
      data: { shop: SHOP, topic: "PRODUCTS_UPDATE", payload: { id: PID } },
    });

    const r = await drainWebhookEvents({ getAdmin: fakeAdmin(catalog) });

    expect(r).toEqual({ processed: 1, failed: 0 });
    const after = await db.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(after.status).toBe("processed");
    expect(await docExists(PID)).toBe(true);
    expect(await stateCount()).toBe(1);
  });

  it("is idempotent — re-picking the same event leaves exactly one doc", async () => {
    const catalog = new Map([[PID, { status: "ACTIVE", onlineStoreUrl: "https://shop/p" }]]);
    // Two pending events for the same product (a crash-then-redeliver shape).
    await db.webhookEvent.create({ data: { shop: SHOP, topic: "PRODUCTS_UPDATE", payload: { id: PID } } });
    await db.webhookEvent.create({ data: { shop: SHOP, topic: "PRODUCTS_UPDATE", payload: { id: PID } } });

    await drainWebhookEvents({ getAdmin: fakeAdmin(catalog) });

    expect(await stateCount()).toBe(1);
    const count = await opensearch.count({ index: TEST_ALIAS, body: { query: { term: { _id: PID } } } });
    expect(count.body.count).toBe(1);
  });

  it("marks a failing event failed with error detail and does NOT retry it", async () => {
    // bulk finish with no admin client available -> processWebhookEvent throws.
    const ev = await db.webhookEvent.create({
      data: {
        shop: SHOP,
        topic: "BULK_OPERATIONS_FINISH",
        payload: { admin_graphql_api_id: "gid://shopify/BulkOperation/1" },
      },
    });

    const first = await drainWebhookEvents({ getAdmin: async () => null });
    expect(first).toEqual({ processed: 0, failed: 1 });
    const failed = await db.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(failed.status).toBe("failed");
    expect((failed.error as { message?: string })?.message).toBeTruthy();

    // Next tick must not re-pick a failed event.
    const second = await drainWebhookEvents({ getAdmin: async () => null });
    expect(second).toEqual({ processed: 0, failed: 0 });
  });
});

describe("reconciliation sweep (C2 safety net)", () => {
  it("re-indexes a product whose ProductSyncState row was deleted", async () => {
    const catalog = new Map([[PID, { status: "ACTIVE", onlineStoreUrl: "https://shop/p" }]]);
    // First index it via the drain, then simulate drift: drop the state row.
    await db.webhookEvent.create({ data: { shop: SHOP, topic: "PRODUCTS_UPDATE", payload: { id: PID } } });
    await drainWebhookEvents({ getAdmin: fakeAdmin(catalog) });
    await db.productSyncState.deleteMany({ where: { shop: SHOP, productId: PID } });
    expect(await stateCount()).toBe(0);

    const r = await reconcileShop(SHOP, { getAdmin: fakeAdmin(catalog) });

    expect(r.indexed).toBe(1);
    expect(await stateCount()).toBe(1);
  });

  it("removes a product that is no longer published", async () => {
    // Index an active+published product, then unpublish it upstream.
    const published = new Map([[PID, { status: "ACTIVE", onlineStoreUrl: "https://shop/p" }]]);
    await db.webhookEvent.create({ data: { shop: SHOP, topic: "PRODUCTS_UPDATE", payload: { id: PID } } });
    await drainWebhookEvents({ getAdmin: fakeAdmin(published) });
    expect(await docExists(PID)).toBe(true);

    const unpublished = new Map([[PID, { status: "ACTIVE", onlineStoreUrl: null }]]);
    const r = await reconcileShop(SHOP, { getAdmin: fakeAdmin(unpublished) });

    expect(r.removed).toBe(1);
    expect(await stateCount()).toBe(0);
    await opensearch.indices.refresh({ index: TEST_ALIAS });
    expect(await docExists(PID)).toBe(false);
  });
});
