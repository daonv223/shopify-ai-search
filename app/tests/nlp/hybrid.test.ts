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
    expect(res.gated).toBe(true);
  });

  it("top 5 are body oils — no haircare injection", async () => {
    const top5 = (await hybrid("body oil", 5)).hits.map((h) => h.handle);
    for (const handle of top5) {
      expect(row().positives, `unexpected ${handle} in top 5`).toContain(handle);
    }
  });

  it("hybrid ranking is identical to kNN-alone on this query", async () => {
    const fused = await hybridHandles("body oil");
    const knnAlone = await knnSearch(TEST_ALIAS, queryVector("body oil"));
    expect(fused).toEqual(knnAlone.slice(0, 10).map((h) => h.handle));
  });

  it("gate stays open on an ordinary Hebrew query (שמנים)", async () => {
    const res = await hybrid("שמנים");
    expect(res.exactMatchCount).toBeGreaterThan(0);
    expect(res.gated).toBe(false);
  });
});
