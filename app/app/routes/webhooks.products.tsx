import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { processProductWebhook } from "../services/product-sync.server";

// products/create, products/update, products/delete — enqueue and ack fast
// (Shopify's 5s deadline), then process in the background: re-fetch the
// product (webhook payloads omit metafields), changed-text detection, index
// upsert/delete. In-process fire-and-forget is the v1 queue (same as
// bulk-operations); retry/reconciliation hardening is task 5.3.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  const event = await db.webhookEvent.create({
    data: { shop, topic, payload: payload as object },
  });

  const productId = (payload as { id?: number | string }).id;
  void processProductWebhook(
    shop,
    topic,
    payload as { id: number | string },
    admin?.graphql ?? null,
  )
    .then((outcome) =>
      db.webhookEvent
        .update({
          where: { id: event.id },
          data: { status: "processed", processedAt: new Date() },
        })
        .then(() => console.log(`[sync] ${shop} ${topic} ${productId}: ${outcome}`)),
    )
    .catch(async (err) => {
      console.error(`[sync] ${shop} ${topic} ${productId} failed:`, err);
      await db.webhookEvent.update({
        where: { id: event.id },
        data: { status: "failed", processedAt: new Date() },
      });
    });

  return new Response();
};
