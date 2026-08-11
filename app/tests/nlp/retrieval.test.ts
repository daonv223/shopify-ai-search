// Layer 2 (spec §3.5): retrieval tests per specs.md §5 tier against the frozen
// 499-product corpus, on the morph leg. Thresholds are set at
// benchmark-comparable levels (calibrated 2026-08-11: baseline 0.83,
// stemming 0.97, prefixes 1.0 — benchmark: stemming 97%).
// The Typos tier and its fuzzy leg were descoped (see phase2-notes.md).
import { describe, expect, it } from "vitest";

import {
  hit10,
  morphLegQuery,
  searchHandles,
  tierHitRate,
  tierQueries,
} from "./harness";

describe("baseline tier — morph leg (A3 regression guard)", () => {
  it("every baseline query still hits its ground truth in top-10", async () => {
    for (const row of tierQueries("baseline")) {
      const top = await searchHandles(morphLegQuery(row.query));
      expect(hit10(top, row.positives), `query ${row.query}`).toBeGreaterThan(0);
    }
  });

  it("tier hit@10 mean ≥ 0.8", async () => {
    const { mean, perQuery } = await tierHitRate(tierQueries("baseline"), morphLegQuery);
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.8);
  });
});

describe("stemming tier — morph leg (A2)", () => {
  it("every stemming query hits its ground truth in top-10", async () => {
    for (const row of tierQueries("stemming")) {
      const top = await searchHandles(morphLegQuery(row.query));
      expect(hit10(top, row.positives), `query ${row.query}`).toBeGreaterThan(0);
    }
  });

  it("שמנים returns body oils, not shampoos: top-10 dominated by ground truth", async () => {
    const row = tierQueries("stemming").find((r) => r.query === "שמנים")!;
    const top = await searchHandles(morphLegQuery("שמנים"));
    expect(hit10(top, row.positives), JSON.stringify(top)).toBeGreaterThanOrEqual(0.9);
  });

  it("tier hit@10 mean ≥ 0.9 (benchmark: 97%)", async () => {
    const { mean, perQuery } = await tierHitRate(tierQueries("stemming"), morphLegQuery);
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.9);
  });
});

describe("prefixes tier — morph leg (A3)", () => {
  it("bare and clitic-prefixed forms match the same products", async () => {
    for (const row of tierQueries("prefixes")) {
      const top = await searchHandles(morphLegQuery(row.query));
      expect(hit10(top, row.positives), `query ${row.query}`).toBeGreaterThan(0);
    }
  });

  it("tier hit@10 mean ≥ 0.9 (calibrated: 1.0)", async () => {
    const { mean, perQuery } = await tierHitRate(tierQueries("prefixes"), morphLegQuery);
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.9);
  });
});
