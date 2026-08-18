import type { LoaderFunctionArgs } from "react-router";

import { jsonRoute, proxyContext } from "../services/proxy-context.server";
import { suggest } from "../services/storefront-search.server";

// Type-ahead: https://{shop}/apps/search/suggest?q=&limit= → this route
// (sub-paths are forwarded by the app proxy). ≤ 8 hits, bounded semantic
// (phase4-notes.md). Resource route — no UI.
export const loader = async ({ request }: LoaderFunctionArgs) =>
  jsonRoute(async () => {
    const { shop, alias, url } = await proxyContext(request);
    return suggest(shop, alias, url.searchParams.get("q"), url.searchParams.get("limit"));
  });
