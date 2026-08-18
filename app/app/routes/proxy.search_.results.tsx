import type { LoaderFunctionArgs } from "react-router";

import { jsonRoute, proxyContext } from "../services/proxy-context.server";
import { results } from "../services/storefront-search.server";

// Results page data: https://{shop}/apps/search/results?q=&page=&limit= →
// this route. Paginated over the fused list, lexical tail beyond fusion
// depth. Resource route — no UI; the theme app block renders it.
export const loader = async ({ request }: LoaderFunctionArgs) =>
  jsonRoute(async () => {
    const { shop, alias, url } = await proxyContext(request);
    const p = url.searchParams;
    return results(shop, alias, p.get("q"), p.get("page"), p.get("limit"));
  });
