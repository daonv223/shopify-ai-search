// Task 3.3: hybrid RRF fusion + v1 lexical-leg gate (hybrid-search.server.ts)
// against the frozen corpus, with real Gemini vectors from the benchmark's
// embedding cache (harness.ts) — no API key needed. Covers A3 (hybrid
// regression + overall ≥ 85%), A4 (semantic tier top-5), A5 (gating).
import { describe, expect, it } from "vitest";

import {
  hybridSearchWithVector,
  knnSearch,
} from "../../app/services/hybrid-search.server";
import {
  TEST_ALIAS,
  cachedVector,
  hit10,
  tierQueries,
  type RelevanceRow,
} from "./harness";

const queryVector = (q: string) => cachedVector(q, "RETRIEVAL_QUERY");

const hybrid = (query: string, size = 10) =>
  hybridSearchWithVector(TEST_ALIAS, query, queryVector(query), size);

const hybridHandles = async (query: string, size = 10) =>
  (await hybrid(query, size)).hits.map((h) => h.handle);

async function hybridTierHitRate(rows: RelevanceRow[]) {
  const perQuery: Record<string, number> = {};
  for (const row of rows) {
    perQuery[row.query] = hit10(await hybridHandles(row.query), row.positives);
  }
  const scores = Object.values(perQuery);
  return { mean: scores.reduce((a, b) => a + b, 0) / scores.length, perQuery };
}

// A3: the fused ranking must not regress the Phase 2 lexical tiers — same
// thresholds as search.test.ts. Calibrated 2026-08-14: baseline 1.0,
// stemming 0.967, prefixes 0.938, overall in-scope 0.949 (benchmark
// hybrid_morph: 87%).
describe("A3 — hybrid regression on the lexical tiers", () => {
  for (const [tier, bar] of [
    ["baseline", 0.8],
    ["stemming", 0.9],
    ["prefixes", 0.9],
  ] as const) {
    it(`every ${tier} query still hits its ground truth in top-10`, async () => {
      for (const row of tierQueries(tier)) {
        const top = await hybridHandles(row.query);
        expect(hit10(top, row.positives), `query ${row.query}`).toBeGreaterThan(0);
      }
    });

    it(`${tier} tier hit@10 mean ≥ ${bar}`, async () => {
      const { mean, perQuery } = await hybridTierHitRate(tierQueries(tier));
      expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(bar);
    });
  }

  it("overall in-scope hit@10 ≥ 0.85 (benchmark hybrid_morph: 87%)", async () => {
    const rows = (["baseline", "stemming", "prefixes", "semantic"] as const)
      .flatMap((t) => tierQueries(t));
    const { mean, perQuery } = await hybridTierHitRate(rows);
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.85);
  });
});

// A4: the spec's "at least parity with native" bar — a ground-truth product
// in the top 5 for every semantic-tier query. Calibrated 2026-08-14: tier
// mean 0.897 (נצנצים לגוף 1.0, ברק לעור 0.833, body oil 0.857 — the last at
// parity with native's 86%; the 7th positive, almond-indulgent-body-oil-duo,
// sits outside kNN's top-10 in the benchmark's engine_results.json too).
describe("A4 — semantic tier", () => {
  it("every semantic query has a ground-truth product in the top 5", async () => {
    for (const row of tierQueries("semantic")) {
      const top5 = await hybridHandles(row.query, 5);
      expect(
        top5.some((h) => row.positives.includes(h)),
        `query ${row.query}: ${JSON.stringify(top5)}`,
      ).toBe(true);
    }
  });

  it("tier hit@10 mean ≥ 0.85 (benchmark knn-alone: 95%)", async () => {
    const { mean, perQuery } = await hybridTierHitRate(tierQueries("semantic"));
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.85);
  });
});

// A5: the verdict's self-inflicted loss stays fixed. `body oil` is an English
// query on a Hebrew catalog: the exact lexical leg has zero signal (corpus
// audit 2026-08-14: no standalone `body` or `oil` token anywhere — the 41
// haircare docs say `oils`, unreachable without the descoped fuzzy leg), so
// the v1 gate must drop the lexical leg and leave the kNN ranking untouched.
describe("A5 — lexical-leg gating on `body oil`", () => {
  const row = () => tierQueries("semantic").find((r) => r.query === "body oil")!;

  it("gate closes: zero exact matches, lexical leg dropped", async () => {
    const res = await hybrid("body oil");
    expect(res.exactMatchCount).toBe(0);
    expect(res.highSignalMatchCount).toBe(0);
    expect(res.gated).toBe(true);
  });

  it("gated hybrid ranking equals the pure kNN ranking", async () => {
    const knn = (await knnSearch(TEST_ALIAS, queryVector("body oil"), 10)).map((h) => h.handle);
    expect(await hybridHandles("body oil")).toEqual(knn);
  });

  it("ground truth in top 5 (A4 bar holds for the previously-lost query)", async () => {
    const top5 = await hybridHandles("body oil", 5);
    expect(top5.some((h) => row().positives.includes(h))).toBe(true);
  });

  it("gate stays open on an ordinary Hebrew query (שמנים)", async () => {
    const res = await hybrid("שמנים");
    expect(res.exactMatchCount).toBeGreaterThan(0);
    expect(res.gated).toBe(false);
  });
});

// Architecture-review finding 2 asks for a stricter gate than "zero exact
// matches" and for tests on semantic queries with noisy, NONZERO lexical
// matches. The two cases below pin the measured behaviour of both candidate
// doc-count rules on the frozen corpus; neither is adopted (see the header
// of hybrid-search.server.ts). They are the "shown to fail" evidence the
// review requires before escalating to per-token or IDF-style signals.
//
// A5b — the v1 exact gate is too PERMISSIVE on `ברק לעור` (radiance for
// skin): `ברק` matches 143 products in body text (zero in titles), `לעור`
// matches 6 titles. exact > 0 keeps the gate open, the body noise enters the
// fusion, and kNN's 100% (6/6) degrades to 83% — still over the A4 bar.
describe("A5b — noisy nonzero lexical matches (`ברק לעור`)", () => {
  const row = () => tierQueries("semantic").find((r) => r.query === "ברק לעור")!;

  it("gate stays open: nonzero exact (and high-signal, from `לעור`) matches", async () => {
    const res = await hybrid("ברק לעור");
    expect(res.exactMatchCount).toBeGreaterThan(0);
    expect(res.highSignalMatchCount).toBeGreaterThan(0);
    expect(res.gated).toBe(false);
  });

  it("ground truth still in top 5 (A4 bar holds despite the noise)", async () => {
    const top5 = await hybridHandles("ברק לעור", 5);
    expect(
      top5.some((h) => row().positives.includes(h)),
      `query ברק לעור: ${JSON.stringify(top5)}`,
    ).toBe(true);
  });
});

// A5d — a high-signal-only gate would be too STRICT on `מראה` (prefixes
// tier). Corpus audit 2026-08-17: 41 exact hits, every one in body text,
// zero in title/tags/product_type/vendor/sku — yet the lexical leg's top 10
// carries 5/6 positives, while kNN (מראה also means "mirror") returns luffa,
// pouches and a ceramic pot: 2/6. Gating on highSignalMatchCount === 0 drops
// the leg and the prefixes tier falls 0.938 → 0.818, under its 0.9 bar.
describe("A5d — body-only exact matches are real signal (`מראה`)", () => {
  const row = () => tierQueries("prefixes").find((r) => r.query === "מראה")!;

  it("zero high-signal but many exact matches: gate must stay open", async () => {
    const res = await hybrid("מראה");
    expect(res.highSignalMatchCount).toBe(0);
    expect(res.exactMatchCount).toBeGreaterThan(20);
    expect(res.gated).toBe(false);
  });

  it("hybrid beats pure kNN on this query (hit@10 ≥ 0.5)", async () => {
    const top = await hybridHandles("מראה");
    expect(hit10(top, row().positives), JSON.stringify(top)).toBeGreaterThanOrEqual(0.5);
  });
});

// A5c — gate must stay OPEN for lookup-style queries only the lexical leg can
// answer. A SKU or a brand name has no useful vector neighbourhood, so any
// gate that classified sku/vendor as low-signal would drop the one leg that
// finds the product. Corpus audit 2026-08-17: SKU 69101278 belongs to a
// single variant (four-species-gift-set) and appears in no indexed text
// field; ERBORIAN is the vendor of 16 products and appears in none of their
// titles/tags/product_type. Neither query has a cached embedding, so the
// kNN leg is fed an unrelated cached vector (`body oil`) — the assertion is
// about the gate and the lexical leg's contribution, not about kNN.
describe("A5c — gate stays open on lookup queries (SKU, brand)", () => {
  const unrelatedVector = () => queryVector("body oil");

  it("SKU query: gate open, high-signal, product carried in by the lexical leg", async () => {
    const res = await hybridSearchWithVector(TEST_ALIAS, "69101278", unrelatedVector(), 10);
    expect(res.gated).toBe(false);
    expect(res.highSignalMatchCount).toBe(1);
    const hit = res.hits.find((h) => h.handle === "four-species-gift-set");
    expect(hit, JSON.stringify(res.hits.map((h) => h.handle))).toBeDefined();
    expect(hit!.lexicalRank).toBe(1);
    // RRF: lexical rank 1 (1/61) ties the kNN #1 at worst → top 2.
    expect(res.hits.slice(0, 2).map((h) => h.handle)).toContain("four-species-gift-set");
  });

  it("brand query: gate open, all 16 ERBORIAN products high-signal, lexical #1 in top 2", async () => {
    const res = await hybridSearchWithVector(TEST_ALIAS, "ERBORIAN", unrelatedVector(), 20);
    expect(res.gated).toBe(false);
    expect(res.highSignalMatchCount).toBe(16);
    expect(res.hits.slice(0, 2).some((h) => h.lexicalRank === 1)).toBe(true);
  });
});
