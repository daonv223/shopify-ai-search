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

  // Mark the shop uninstalled and drop its search data (spec §3.1 cleanup;
  // well inside the 48h GDPR window).
  const shopRow = await db.shop.findUnique({ where: { id: shop } });
  await db.shop.updateMany({
    where: { id: shop },
    data: { uninstalledAt: new Date() },
  });
  if (shopRow) {
    const { deleteIndex } = await import("../services/opensearch.server");
    await deleteIndex(shopRow.indexAlias).catch((err) =>
      console.error(`[uninstall] index cleanup failed for ${shop}:`, err),
    );
    await db.productSyncState.deleteMany({ where: { shop } });
  }

  return new Response();
};
