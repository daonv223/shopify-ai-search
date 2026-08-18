// App-proxy request context for the storefront surfaces (Phase 4 spec §3.1).
// `authenticate.public.appProxy` verifies the HMAC signature Shopify adds to
// every proxied request (invalid/missing → it throws a 400 Response) and
// hands back the Liquid helper. The shop comes from the signed `shop` query
// param — not from an offline session, which may be absent (expiring
// offline tokens) or irrelevant to a public storefront request — and is
// resolved to its index alias through the Shop row written at install.
import db from "../db.server";
import { authenticate } from "../shopify.server";

export type ProxyContext = {
  shop: string;
  alias: string;
  url: URL;
  liquid: Awaited<ReturnType<typeof authenticate.public.appProxy>>["liquid"];
};

export async function proxyContext(request: Request): Promise<ProxyContext> {
  const { liquid } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const row = shop ? await db.shop.findUnique({ where: { id: shop } }) : null;
  if (!row || row.uninstalledAt) {
    throw Response.json({ error: "shop not installed" }, { status: 404 });
  }
  return { shop, alias: row.indexAlias, url, liquid };
}

// Per-shop data through a shared proxy path: no public caching for now
// (revisit in Phase 5.3).
export const NO_STORE_HEADERS = { "Cache-Control": "private, max-age=0" };

// Resource-route error policy: signed-but-broken requests get a JSON 500 with
// a log line, never a stack trace; thrown Responses (400/404 above) pass
// through untouched.
export async function jsonRoute(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn(), { headers: NO_STORE_HEADERS });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error(
      JSON.stringify({ evt: "search_error", error: err instanceof Error ? err.message : String(err) }),
    );
    return Response.json({ error: "search unavailable" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
