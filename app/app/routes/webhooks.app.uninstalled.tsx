import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Mark the shop uninstalled; the index-drop/data-purge cleanup job (spec
  // §3.1, 48h GDPR window) keys off this timestamp.
  await db.shop.updateMany({
    where: { id: shop },
    data: { uninstalledAt: new Date() },
  });

  return new Response();
};
