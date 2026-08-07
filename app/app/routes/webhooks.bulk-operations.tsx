import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// bulk_operations/finish — fires when a catalog ingest bulk query completes.
// Enqueued here; the JSONL download + index pipeline is task 1.2.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  await db.webhookEvent.create({
    data: { shop, topic, payload: payload as object },
  });

  return new Response();
};
