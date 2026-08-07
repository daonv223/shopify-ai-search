import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Storefront-facing search endpoint, reached via the app proxy:
// https://{shop}/apps/search → /proxy/search. Signature verification is done
// by authenticate.public.appProxy — unsigned requests are rejected with 401.
// Phase 1 stub: echo the shop and query (acceptance test A7). Phase 4 (task
// 4.1) replaces the body with the real search pipeline.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  return Response.json({
    ok: true,
    shop: session?.shop ?? null,
    query: url.searchParams.get("q") ?? "",
  });
};
