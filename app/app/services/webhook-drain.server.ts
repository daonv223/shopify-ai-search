import { Prisma, type WebhookEvent } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { logEvent, reportError } from "./log.server";
import { processProductWebhook } from "./product-sync.server";
import { processBulkOperationFinish } from "./ingest.server";

// Cron drain worker (task 5.3, decided 2026-08-20). The webhook routes persist
// a `WebhookEvent` row (status=pending) and ack fast; this worker owns all
// processing. Runs every minute (cron.server.ts): pick up pending, process,
// mark processed. On throw mark failed + persist the error and move on — NO
// retry loop, NO backoff, NO attempts column. The daily reconciliation sweep
// (reconcile.server.ts) is the v1 safety net in place of retry.
//
// Idempotency by WebhookEvent.id: an event is marked processed only AFTER its
// side effects land, and the side effects themselves (indexProducts /
// removeProduct, keyed by product id) are idempotent — so an event whose
// process crashed mid-flight stays `pending` and is safe to re-pick next tick.

type AdminGraphql = (
  query: string,
  opts?: { variables?: Record<string, unknown> },
) => Promise<Response>;

// Injectable for tests; production resolves the shop's offline admin client.
export type GetAdmin = (shop: string) => Promise<AdminGraphql | null>;

const defaultGetAdmin: GetAdmin = async (shop) => {
  const { admin } = await unauthenticated.admin(shop);
  return admin.graphql as AdminGraphql;
};

export interface DrainResult {
  processed: number;
  failed: number;
}

// Dispatch one event to its processor by topic. Returns a short outcome string.
export async function processWebhookEvent(
  event: Pick<WebhookEvent, "shop" | "topic" | "payload">,
  graphql: AdminGraphql | null,
): Promise<string> {
  const { shop, topic } = event;
  if (topic.startsWith("PRODUCTS_")) {
    return processProductWebhook(
      shop,
      topic,
      event.payload as { id: number | string },
      graphql,
    );
  }
  if (topic === "BULK_OPERATIONS_FINISH") {
    if (!graphql) throw new Error(`no admin client to process bulk finish for ${shop}`);
    const r = await processBulkOperationFinish(
      shop,
      event.payload as { admin_graphql_api_id: string },
      graphql,
    );
    return `indexed ${r.indexed}, deleted ${r.deleted}, stale ${r.newlyStale}`;
  }
  return `ignored topic ${topic}`;
}

// Process every pending event once, oldest first. Admin clients are resolved
// once per shop per drain. Per-event failures are isolated (marked failed, not
// retried); a db-level failure propagates to the caller.
export async function drainWebhookEvents(
  opts: { getAdmin?: GetAdmin } = {},
): Promise<DrainResult> {
  const getAdmin = opts.getAdmin ?? defaultGetAdmin;
  const pending = await db.webhookEvent.findMany({
    where: { status: "pending" },
    orderBy: { receivedAt: "asc" },
  });

  const adminByShop = new Map<string, AdminGraphql | null>();
  let processed = 0;
  let failed = 0;

  for (const event of pending) {
    const t0 = performance.now();
    try {
      if (!adminByShop.has(event.shop)) {
        adminByShop.set(
          event.shop,
          await getAdmin(event.shop).catch(() => null),
        );
      }
      const outcome = await processWebhookEvent(event, adminByShop.get(event.shop) ?? null);
      await db.webhookEvent.update({
        where: { id: event.id },
        data: { status: "processed", processedAt: new Date(), error: Prisma.DbNull },
      });
      logEvent({
        op: "webhook.drain",
        ok: true,
        shop: event.shop,
        topic: event.topic,
        eventId: event.id,
        outcome,
        ms: Math.round(performance.now() - t0),
      });
      processed++;
    } catch (err) {
      // No retry (v1): record the failure and continue with the next event.
      const detail = reportError("webhook.drain", err, {
        shop: event.shop,
        topic: event.topic,
        eventId: event.id,
      });
      await db.webhookEvent.update({
        where: { id: event.id },
        data: { status: "failed", processedAt: new Date(), error: detail as object },
      });
      failed++;
    }
  }

  return { processed, failed };
}
