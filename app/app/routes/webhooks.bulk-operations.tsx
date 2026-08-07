import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { processBulkOperationFinish } from "../services/ingest.server";

// bulk_operations/finish — enqueue, ack fast, then process the catalog ingest
// in the background (download JSONL -> compose docs -> index). In-process
// fire-and-forget is the v1 queue; retry/reconciliation hardening is task 5.3.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  const event = await db.webhookEvent.create({
    data: { shop, topic, payload: payload as object },
  });

  if (admin) {
    void processBulkOperationFinish(
      shop,
      payload as { admin_graphql_api_id: string },
      admin.graphql,
    )
      .then((result) =>
        db.webhookEvent.update({
          where: { id: event.id },
          data: { status: "processed", processedAt: new Date() },
        }).then(() => console.log(`[ingest] ${shop}: indexed ${result.indexed}, deleted ${result.deleted}, stale ${result.newlyStale}`)),
      )
      .catch(async (err) => {
        console.error(`[ingest] ${shop} failed:`, err);
        await db.webhookEvent.update({
          where: { id: event.id },
          data: { status: "failed", processedAt: new Date() },
        });
      });
  }

  return new Response();
};
