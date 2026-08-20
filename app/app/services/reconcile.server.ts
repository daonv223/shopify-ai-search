import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { logEvent, reportError } from "./log.server";
import { processProductWebhook } from "./product-sync.server";
import { removeProduct } from "./product-index.server";

// Daily reconciliation sweep (task 5.3, decided 2026-08-20). This is the v1
// safety net in place of per-event webhook retry: re-list every currently
// published product from Shopify and repair `ProductSyncState` drift —
//   missing (published in Shopify, absent locally)   -> re-fetch + index
//   extra   (present locally, not published anymore) -> removeProduct
// which covers a dropped/failed create, a missed delete/unpublish, and a
// manually-deleted ProductSyncState row. Runs daily via cron.server.ts; cheap
// at 499 products, linear at scale (spec open question 2 — revisit with the
// scale test).

type AdminGraphql = (
  query: string,
  opts?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export type GetAdmin = (shop: string) => Promise<AdminGraphql | null>;

const defaultGetAdmin: GetAdmin = async (shop) => {
  const { admin } = await unauthenticated.admin(shop);
  return admin.graphql as AdminGraphql;
};

const gidToId = (gid: string) => gid.slice(gid.lastIndexOf("/") + 1);

// Publication visibility (task 5.3): the desired set is active AND published to
// the Online Store — onlineStoreUrl is null otherwise. Same predicate the
// ingest and webhook paths use.
const LIST_QUERY = `
  query($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges { node { id status onlineStoreUrl } }
    }
  }`;

interface ListNode {
  id: string;
  status: string;
  onlineStoreUrl?: string | null;
}

export interface ReconcileResult {
  scanned: number; // published products seen in Shopify
  indexed: number; // drift repaired by (re-)indexing
  removed: number; // drift repaired by removing
}

export async function reconcileShop(
  shop: string,
  opts: { getAdmin?: GetAdmin } = {},
): Promise<ReconcileResult> {
  const shopRow = await db.shop.findUnique({ where: { id: shop } });
  if (!shopRow) throw new Error(`no Shop row for ${shop}`);

  const getAdmin = opts.getAdmin ?? defaultGetAdmin;
  const graphql = await getAdmin(shop);
  if (!graphql) throw new Error(`no admin client for ${shop}`);

  // desired = currently published product IDs (paginated Admin GraphQL).
  const desired = new Set<string>();
  let cursor: string | null = null;
  do {
    const res = await graphql(LIST_QUERY, { variables: { cursor } });
    const conn = (await res.json()).data?.products as
      | { pageInfo: { hasNextPage: boolean; endCursor: string }; edges: { node: ListNode }[] }
      | undefined;
    if (!conn) break;
    for (const { node } of conn.edges) {
      if (node.status === "ACTIVE" && node.onlineStoreUrl) desired.add(gidToId(node.id));
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  const current = new Set(
    (
      await db.productSyncState.findMany({ where: { shop }, select: { productId: true } })
    ).map((r) => r.productId),
  );

  let indexed = 0;
  let removed = 0;

  // Missing: published upstream but not tracked locally — re-fetch and index
  // through the same path a products/update webhook takes.
  for (const id of desired) {
    if (!current.has(id)) {
      await processProductWebhook(shop, "PRODUCTS_UPDATE", { id }, graphql);
      indexed++;
    }
  }
  // Extra: tracked locally but no longer published — drop it.
  for (const id of current) {
    if (!desired.has(id)) {
      await removeProduct(shop, shopRow.indexAlias, id);
      removed++;
    }
  }

  logEvent({ op: "reconcile", ok: true, shop, scanned: desired.size, indexed, removed });
  return { scanned: desired.size, indexed, removed };
}

// Reconcile every installed shop; one shop's failure does not stop the rest.
export async function reconcileAllShops(opts: { getAdmin?: GetAdmin } = {}): Promise<void> {
  const shops = await db.shop.findMany({
    where: { uninstalledAt: null },
    select: { id: true },
  });
  for (const { id } of shops) {
    try {
      await reconcileShop(id, opts);
    } catch (err) {
      reportError("reconcile", err, { shop: id });
    }
  }
}
