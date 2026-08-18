// Phase 4 task 4.1 — the storefront surfaces through the HTTP layer
// (specs/storefront-surfaces/spec.md §3.1, acceptance B2/B3): the route
// loaders are called with app-proxy-signed requests (HMAC with the app
// secret, exactly what Shopify does), resolved to the harness alias through a
// Shop row, against the frozen corpus with the benchmark's cached vectors
// pre-loaded into the query-embedding LRU. The embedder is switched off, so
// anything not in the LRU (every truncated type-ahead form) runs the
// cold-cache path — which is what production does on a keystroke anyway.
import { createHash, createHmac } from "node:crypto";

import type { LoaderFunctionArgs } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_ALIAS, cachedVector, hit10, loadRelevance, tierQueries, type RelevanceRow } from "./harness";

// shopify.server.ts validates its config at import time — set the env
// before anything that pulls it in is imported (hence the dynamic imports).
const APP_SECRET = "surface-test-secret";
process.env.SHOPIFY_API_KEY ??= "surface-test-key";
process.env.SHOPIFY_API_SECRET = APP_SECRET;
process.env.SHOPIFY_APP_URL ??= "https://surface-test.example";
process.env.SCOPES ??= "read_products";

const SHOP = "nlp-harness.myshopify.com";

const db = (await import("../../app/db.server")).default;
const { queryEmbeddings } = await import("../../app/services/query-embedding.server");
const { loader: suggestLoader } = await import("../../app/routes/proxy.search_.suggest");
const { loader: resultsLoader } = await import("../../app/routes/proxy.search_.results");
const { loader: pageLoader } = await import("../../app/routes/proxy.search");
const { esc } = await import("../../app/services/results-page.server");
const { SUGGEST_LIMIT_MAX, RESULTS_LIMIT_MAX } = await import(
  "../../app/services/storefront-search.server"
);

// App-proxy signature: sorted `key=value` pairs concatenated without
// separators, HMAC-SHA256 hex with the app secret (shopify-api
// hmac-validator.mjs, `signator: "appProxy"`). Shopify also sends
// path_prefix, timestamp, shop, logged_in_customer_id.
function signedUrl(path: string, params: Record<string, string>): string {
  const all: Record<string, string> = {
    shop: SHOP,
    path_prefix: "/apps/search",
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: "",
    ...params,
  };
  const message = Object.entries(all)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", APP_SECRET).update(message).digest("hex");
  const url = new URL(`https://app.example${path}`);
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return url.toString();
}

type Loader = (args: LoaderFunctionArgs) => Promise<Response>;
async function call(loader: Loader, url: string): Promise<Response> {
  try {
    return await loader({ request: new Request(url), params: {}, context: {} } as LoaderFunctionArgs);
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }
}

const suggest = (params: Record<string, string>) =>
  call(suggestLoader as Loader, signedUrl("/proxy/search/suggest", params));
const results = (params: Record<string, string>) =>
  call(resultsLoader as Loader, signedUrl("/proxy/search/results", params));
const page = (params: Record<string, string>) =>
  call(pageLoader as Loader, signedUrl("/proxy/search", params));

const json = async (res: Response) => {
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};
const handles = (body: { hits: { handle: string }[] }) => body.hits.map((h) => h.handle);

beforeAll(async () => {
  await db.shop.upsert({
    where: { id: SHOP },
    update: { indexAlias: TEST_ALIAS, uninstalledAt: null },
    create: { id: SHOP, indexAlias: TEST_ALIAS },
  });
  queryEmbeddings.clear();
  queryEmbeddings.setEmbedder(null); // provider off: misses report "off"
  for (const row of loadRelevance()) {
    queryEmbeddings.set(row.query, cachedVector(row.query, "RETRIEVAL_QUERY"));
  }
});

afterAll(async () => {
  await db.shop.deleteMany({ where: { id: SHOP } });
  await db.$disconnect();
});

describe("transport hygiene", () => {
  it("unsigned request → 400 (authenticate.public.appProxy)", async () => {
    const res = await call(resultsLoader as Loader, "https://app.example/proxy/search/results?q=שמן&shop=" + SHOP);
    expect(res.status).toBe(400);
  });

  it("tampered query (signature no longer matches) → 400", async () => {
    const url = new URL(signedUrl("/proxy/search/results", { q: "שמן" }));
    url.searchParams.set("q", "שמנים");
    expect((await call(resultsLoader as Loader, url.toString())).status).toBe(400);
  });

  it("signed request for a shop that never installed → 404", async () => {
    const url = signedUrl("/proxy/search/results", { q: "שמן" }).replace(
      encodeURIComponent(SHOP),
      "ghost.myshopify.com",
    );
    // Re-sign for the ghost shop so only the shop lookup fails.
    const u = new URL(url);
    u.searchParams.delete("signature");
    const params = Object.fromEntries(u.searchParams.entries());
    const message = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("");
    u.searchParams.set("signature", createHmac("sha256", APP_SECRET).update(message).digest("hex"));
    expect((await call(resultsLoader as Loader, u.toString())).status).toBe(404);
  });

  it("empty / whitespace q → 200 { hits: [] } on both surfaces", async () => {
    for (const q of ["", "   "]) {
      const s = await json(await suggest({ q }));
      expect(s.hits).toEqual([]);
      const r = await json(await results({ q }));
      expect(r.hits).toEqual([]);
      expect(r.has_more).toBe(false);
    }
  });

  it("q is trimmed and capped at 200 chars; limits are clamped", async () => {
    const long = "שמן " + "א".repeat(300);
    const r = await json(await results({ q: `  ${long}  ` }));
    expect(r.query.length).toBeLessThanOrEqual(200);
    expect(r.query.startsWith("שמן")).toBe(true);

    const s = await json(await suggest({ q: "שמן", limit: "50" }));
    expect(s.hits.length).toBeLessThanOrEqual(SUGGEST_LIMIT_MAX);
    const big = await json(await results({ q: "שמן", limit: "500" }));
    expect(big.limit).toBe(RESULTS_LIMIT_MAX);
  });

  it("responses carry took_ms, gated, semantic and Cache-Control: private", async () => {
    const res = await results({ q: "שמנים" });
    expect(res.headers.get("cache-control")).toBe("private, max-age=0");
    const body = await json(res);
    expect(typeof body.took_ms).toBe("number");
    expect(typeof body.gated).toBe("boolean");
    expect(body.semantic).toBe("cached");
    // Frozen-corpus docs carry no images, so image_* are absent (undefined
    // is dropped from JSON); every present key must be in the spec's shape.
    const shape = ["available", "handle", "image_alt", "image_url", "price_max", "price_min", "title", "url"];
    for (const h of body.hits) {
      expect(h.handle).toBeTruthy();
      expect(h.title).toBeTruthy();
      for (const k of Object.keys(h)) expect(shape, k).toContain(k);
    }
  });
});

// B2 — the Phase 3 bars (hybrid.test.ts A3/A4/A5) must hold through the
// transport: signed request → loader → shop lookup → LRU hit → fusion.
describe("B2 — endpoint parity on the §5 battery through /results", () => {
  const top = async (q: string, limit = 10) => handles(await json(await results({ q, limit: String(limit) })));

  async function tierHitRate(rows: RelevanceRow[]) {
    const perQuery: Record<string, number> = {};
    for (const row of rows) perQuery[row.query] = hit10(await top(row.query), row.positives);
    const scores = Object.values(perQuery);
    return { mean: scores.reduce((a, b) => a + b, 0) / scores.length, perQuery };
  }

  for (const [tier, bar] of [
    ["baseline", 0.8],
    ["stemming", 0.9],
    ["prefixes", 0.9],
  ] as const) {
    it(`${tier}: every query hits ground truth in top-10, tier mean ≥ ${bar}`, async () => {
      const { mean, perQuery } = await tierHitRate(tierQueries(tier));
      for (const [q, score] of Object.entries(perQuery)) expect(score, `query ${q}`).toBeGreaterThan(0);
      expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(bar);
    });
  }

  it("semantic: ground truth in top 5 for every query, tier mean ≥ 0.85", async () => {
    for (const row of tierQueries("semantic")) {
      const top5 = await top(row.query, 5);
      expect(top5.some((h) => row.positives.includes(h)), `query ${row.query}: ${top5}`).toBe(true);
    }
    const { mean, perQuery } = await tierHitRate(tierQueries("semantic"));
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.85);
  });

  it("overall in-scope hit@10 ≥ 0.85", async () => {
    const rows = (["baseline", "stemming", "prefixes", "semantic"] as const).flatMap((t) => tierQueries(t));
    const { mean, perQuery } = await tierHitRate(rows);
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.85);
  });

  it("A5 through the transport: `body oil` gated, kNN-anchored, body oils in top 5", async () => {
    const body = await json(await results({ q: "body oil", limit: "5" }));
    expect(body.gated).toBe(true);
    expect(body.semantic).toBe("cached");
    const positives = tierQueries("semantic").find((r) => r.query === "body oil")!.positives;
    expect(handles(body).some((h) => positives.includes(h))).toBe(true);
  });

  it("every battery query answers from the LRU (semantic: cached), no live embedding", async () => {
    for (const row of loadRelevance()) {
      const body = await json(await results({ q: row.query, limit: "1" }));
      expect(body.semantic, row.query).toBe("cached");
    }
  });
});

describe("results pagination and the lexical tail", () => {
  it("pages slice one stable list: disjoint, ordered, has_more accurate", async () => {
    const all = await json(await results({ q: "שמנים", limit: "20" }));
    const p1 = await json(await results({ q: "שמנים", page: "1", limit: "10" }));
    const p2 = await json(await results({ q: "שמנים", page: "2", limit: "10" }));
    expect(handles(p1).concat(handles(p2))).toEqual(handles(all));
    expect(p1.has_more).toBe(true);
    expect(p1.page).toBe(1);
    expect(p2.page).toBe(2);
  });

  it("beyond fusion depth the lexical tail is appended, never a blank page, no duplicates", async () => {
    // Fused list ≤ 100 (50 + 50). Page 3 at 48/page starts at offset 96 and
    // runs into the tail; שמנים matches far more than 50 docs lexically.
    const seen = new Set<string>();
    let more = true;
    let pageNo = 1;
    let tailReached = false;
    while (more && pageNo <= 12) {
      const body = await json(await results({ q: "שמנים", page: String(pageNo), limit: "48" }));
      for (const h of handles(body)) {
        expect(seen.has(h), `duplicate ${h} on page ${pageNo}`).toBe(false);
        seen.add(h);
      }
      if ((pageNo - 1) * 48 >= 100 && body.hits.length > 0) tailReached = true;
      if (body.has_more) expect(body.hits.length).toBe(48);
      more = body.has_more;
      pageNo++;
    }
    expect(tailReached).toBe(true);
    expect(seen.size).toBeGreaterThan(100);
  });

  it("past the end: 200 with no hits and has_more false", async () => {
    const body = await json(await results({ q: "שמנים", page: "500", limit: "48" }));
    expect(body.hits).toEqual([]);
    expect(body.has_more).toBe(false);
  });
});

// Empty state (B6 backing): the kNN leg always has k neighbours, so a gated
// query with no semantic anchor must come back empty rather than 50 random
// products. עןר (typo tier) is gated (zero exact matches) and its cached
// vector's best neighbour scores 1.687 < KNN_ANCHOR_MIN_SCORE.
describe("empty state — semantic-anchor floor", () => {
  it("gated + unanchored (עןר) → zero hits, total 0, on both surfaces", async () => {
    const r = await json(await results({ q: "עןר" }));
    expect(r.semantic).toBe("cached");
    expect(r.gated).toBe(true);
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
    const s = await json(await suggest({ q: "עןר" }));
    expect(s.hits).toEqual([]);
  });

  it("gibberish with no vector (זזזז) → zero hits", async () => {
    const r = await json(await results({ q: "זזזז" }));
    expect(r.semantic).toBe("off");
    expect(r.hits).toEqual([]);
    expect(r.has_more).toBe(false);
  });
});

// B3 — prefix type-ahead: every §5 query truncated by its final 1–2 chars
// through /suggest. Cold-cache path (no vector for a truncated form; the
// embedder is off), i.e. exactly what a keystroke gets in production.
//
// Bar, set on the first measurement (2026-08-18, phase4-notes.md B3 table):
// ground truth in the top 5 for every truncated form of a Baseline/Stemming
// query, except a form that is a single token of < 3 letters — `שי` is shea
// (שיאה) as much as shimmer (שימר), and the spec's own partial-token rule
// treats such a fragment as too short to reason about. Prefixes/semantic
// forms are pinned at their measured top-8 behaviour as regression guards.
describe("B3 — prefix type-ahead through /suggest", () => {
  const truncations = (q: string) =>
    [q.slice(0, -1), q.slice(0, -2)].map((t) => t.trim()).filter((t) => t.length > 0);
  const inScope = () =>
    (["baseline", "stemming", "prefixes", "semantic"] as const).flatMap((t) => tierQueries(t));
  const ambiguousFragment = (t: string) => !t.includes(" ") && t.length < 3;

  it("no truncated form returns zero hits when the full query has hits", async () => {
    for (const row of inScope()) {
      const full = await json(await suggest({ q: row.query, limit: "8" }));
      if (full.hits.length === 0) continue;
      for (const t of truncations(row.query)) {
        const body = await json(await suggest({ q: t, limit: "8" }));
        expect(body.hits.length, `${row.query} → ${t}`).toBeGreaterThan(0);
        // cold path — or an LRU hit when the truncation is itself a battery
        // query (שקדים → שקד); never a live embedding
        expect(["off", "skipped", "cached"]).toContain(body.semantic);
      }
    }
  });

  it("baseline/stemming: ground truth in the top 5 for every truncated form (bar: see header)", async () => {
    const perForm: Record<string, number> = {};
    for (const row of [...tierQueries("baseline"), ...tierQueries("stemming")]) {
      for (const t of truncations(row.query)) {
        const body = await json(await suggest({ q: t, limit: "5" }));
        const top5 = handles(body);
        const found = top5.filter((h) => row.positives.includes(h)).length;
        perForm[`${row.query}→${t}`] = found;
        if (ambiguousFragment(t)) {
          expect(body.hits.length, `${row.query} → ${t}`).toBeGreaterThan(0);
        } else {
          expect(found, `${row.query} → ${t}: ${top5}`).toBeGreaterThan(0);
        }
      }
    }
    console.log(`B3 hit-count@5 per truncated form: ${JSON.stringify(perForm)}`);
  });

  it("prefixes/semantic forms: pinned top-8 behaviour (regression guard)", async () => {
    // Measured 2026-08-18 with the strict prefix + clitic variant; forms not
    // listed here (`מר`, `בשמ`, `בש`, `body oi`) legitimately miss — see notes.
    const pinned = ["שמן לגו", "שמן לג", "השמ", "מרא", "ברק לעו", "ברק לע", "נצנצים לגו", "נצנצים לג"];
    const rows = [...tierQueries("prefixes"), ...tierQueries("semantic")];
    for (const t of pinned) {
      const row = rows.find((r) => r.query.startsWith(t))!;
      const top = handles(await json(await suggest({ q: t, limit: "8" })));
      expect(top.some((h) => row.positives.includes(h)), `${row.query} → ${t}: ${top}`).toBe(true);
    }
  });

  it("`שמ` and `שמני ג` surface body oils", async () => {
    const bodyOil = tierQueries("baseline").find((r) => r.query === "שמן גוף")!.positives;
    for (const q of ["שמ", "שמני ג"]) {
      const top = handles(await json(await suggest({ q, limit: "8" })));
      expect(top.some((h) => bodyOil.includes(h)), `${q}: ${top}`).toBe(true);
    }
  });

  it("full battery queries through /suggest: ground truth at rank ≤ 2 (typeahead mode ≠ regression)", async () => {
    for (const row of inScope()) {
      if (row.query === "body oil") continue; // cold lexical-only until the upgrade re-fetch (4.2)
      const top = handles(await json(await suggest({ q: row.query, limit: "8" })));
      const rank = top.findIndex((h) => row.positives.includes(h)) + 1;
      expect(rank, `${row.query}: ${top}`).toBeGreaterThan(0);
      expect(rank, `${row.query}: ${top}`).toBeLessThanOrEqual(2);
    }
  });

  it("morph guard: `שמ` never surfaces perfumes through the over-stripped stem of בשמים", async () => {
    // Before the guard, the 2-letter morph token שמ met בשמים (ב- and -ים
    // stripped) and EDTs outranked every oil and shampoo.
    const top = handles(await json(await suggest({ q: "שמ", limit: "8" })));
    expect(top.some((h) => h.includes("edt"))).toBe(false);
  });
});

describe("vintage-theme fallback page (/proxy/search, application/liquid)", () => {
  it("renders the grid inside the theme layout, prices through | money, RTL", async () => {
    const res = await page({ q: "שמנים" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/liquid");
    const html = await res.text();
    expect(html).not.toMatch(/\{% layout none %\}/);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("ai-search-grid");
    expect(html).toMatch(/\{\{ \d+ \| money \}\}/);
    expect(html).toContain("data-ai-search-more"); // has_more → next link
    expect((html.match(/ai-search-item/g) ?? []).length).toBeGreaterThan(5);
  });

  it("empty state links to native search", async () => {
    const html = await (await page({ q: "זזזז" })).text();
    expect(html).toContain("ai-search-empty");
    // the proxy Liquid helper adds a trailing slash to relative hrefs
    expect(html).toMatch(/href="\/search\/?\?q=/);
  });

  it("no q → search form, not an error", async () => {
    const html = await (await page({})).text();
    expect(html).toContain("ai-search-form");
  });

  it("interpolated text can never open a Liquid tag", () => {
    expect(esc('{{ shop.name }} {% raw %} <b>"x"</b>')).toBe(
      "&#123;&#123; shop.name &#125;&#125; &#123;% raw %&#125; &lt;b&gt;&quot;x&quot;&lt;/b&gt;",
    );
  });
});

// Keep the harness honest about which vectors were used: the LRU key is
// normalized, so `שמנים` and ` שמנים ` share one entry.
describe("query-embedding LRU", () => {
  it("normalizes whitespace/case for cache identity", () => {
    expect(queryEmbeddings.peek("  שמנים ")).toBeDefined();
    expect(queryEmbeddings.peek("BODY   OIL")).toBeDefined();
    const key = createHash("sha1").update("x").digest("hex");
    expect(queryEmbeddings.peek(key)).toBeUndefined();
  });
});
