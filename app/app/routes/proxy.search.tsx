import type { LoaderFunctionArgs } from "react-router";

import { NO_STORE_HEADERS, proxyContext } from "../services/proxy-context.server";
import { renderErrorPage, renderResultsPage } from "../services/results-page.server";
import { cleanQuery, results } from "../services/storefront-search.server";

// Vintage-theme fallback page: https://{shop}/apps/search?q=&page= → an
// `application/liquid` document Shopify renders inside the theme layout
// (Phase 4 spec §3.1/§3.3). OS 2.0 themes use the app block + JSON routes
// instead; this is what the embed points the search form at when there is
// no app-block slot. Replaces the Phase 1 echo stub. Signature verification
// is done by authenticate.public.appProxy inside proxyContext — unsigned or
// tampered requests are rejected with 400.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, alias, url, liquid } = await proxyContext(request);
  const p = url.searchParams;
  try {
    const out = await results(shop, alias, p.get("q"), p.get("page"), p.get("limit"), "page");
    return liquid(renderResultsPage(out), { headers: NO_STORE_HEADERS });
  } catch (err) {
    console.error(
      JSON.stringify({ evt: "search_error", surface: "page", error: err instanceof Error ? err.message : String(err) }),
    );
    return liquid(renderErrorPage(cleanQuery(p.get("q"))), { headers: NO_STORE_HEADERS });
  }
};
