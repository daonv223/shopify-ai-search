import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logEvent } from "../services/log.server";

// bulk_operations/finish — persist a WebhookEvent (status=pending) and ack fast.
// The cron drain worker (webhook-drain.server.ts) processes the catalog ingest
// (download JSONL -> compose docs -> index) on its next tick, re-resolving the
// shop's admin client from the offline session. No in-line fire-and-forget
// (task 5.3).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const event = await db.webhookEvent.create({
    data: { shop, topic, payload: payload as object },
  });
  logEvent({ op: "webhook.enqueue", ok: true, shop, topic, eventId: event.id });

  return new Response();
};
