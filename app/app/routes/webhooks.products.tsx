import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logEvent } from "../services/log.server";

// products/create, products/update, products/delete — persist a WebhookEvent
// (status=pending) and ack fast (Shopify's 5s deadline). Processing is owned by
// the cron drain worker (webhook-drain.server.ts, every minute), NOT this
// route: the crash window between ack and processing was the real data-loss bug
// (task 5.3, decided 2026-08-20). The daily reconciliation sweep is the safety
// net — no in-line fire-and-forget, no per-event retry.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const event = await db.webhookEvent.create({
    data: { shop, topic, payload: payload as object },
  });
  logEvent({ op: "webhook.enqueue", ok: true, shop, topic, eventId: event.id });

  return new Response();
};
