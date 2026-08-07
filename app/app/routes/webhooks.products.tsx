import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// products/create, products/update, products/delete — enqueue and ack fast
// (Shopify's 5s deadline). Async processing (re-fetch product, changed-text
// detection, index upsert) is task 1.3 and consumes the WebhookEvent queue.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  await db.webhookEvent.create({
    data: { shop, topic, payload: payload as object },
  });

  return new Response();
};
