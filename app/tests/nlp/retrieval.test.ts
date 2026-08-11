// Layer 2 (spec §3.5): retrieval tests per specs.md §5 tier against the frozen
// 499-product corpus. Baseline/Stemming/Prefixes run on the morph leg,
// Typos on the fuzzy leg. Thresholds are set at benchmark-comparable levels
// (calibrated 2026-08-11: baseline 0.83, stemming 0.97, prefixes 1.0,
// typos 0.90 — benchmark: stemming 97%, 3-leg typos 81%).
import { describe, expect, it } from "vitest";

import {
  ANCHOR,
  fuzzyLegQuery,
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

describe("typos tier — fuzzy leg (A4)", () => {
  it("every typo query finds relevant results in top-10 on the fuzzy leg alone", async () => {
    for (const row of tierQueries("typos")) {
      const top = await searchHandles(fuzzyLegQuery(row.query));
      expect(hit10(top, row.positives), `query ${row.query}`).toBeGreaterThan(0);
    }
  });

  it("flagship transposition שדקים retrieves the anchor product", async () => {
    const top = await searchHandles(fuzzyLegQuery("שדקים"));
    expect(top, JSON.stringify(top)).toContain(ANCHOR);
  });

  it("tier hit@10 mean ≥ 0.8 (calibrated: 0.90; benchmark 3-leg: 81%)", async () => {
    const { mean, perQuery } = await tierHitRate(tierQueries("typos"), fuzzyLegQuery);
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.8);
  });
});

describe("stacking guard (A5) — fuzziness must never run on .morph fields", () => {
  // Benchmark finding (verdict.md): the multiplexer emits several tokens per
  // word; fuzzy-expanding all of them pulls in noise and degraded the lexical
  // tier 90% → 66%. Reproduced on this corpus: typo tier 0.90 → 0.66, with
  // שדקים dropping from 1.0 to 0. The tier assertions above fail too if the
  // leg is repointed, but this pins the contract directly.
  it("fuzzyLegQuery targets only bare fields", () => {
    const query = fuzzyLegQuery("שדקים") as any;
    for (const field of query.multi_match.fields) {
      expect(field).not.toContain(".morph");
    }
    expect(query.multi_match.fuzziness).toBe("1"); // not AUTO — distance-2 pollution
    expect(query.multi_match.prefix_length).toBe(0);
    expect(query.multi_match.fuzzy_transpositions).toBe(true);
  });

  it("fuzzy-on-morph loses the anchor for שדקים (the 90%→66% finding, encoded)", async () => {
    const stacked = JSON.parse(JSON.stringify(fuzzyLegQuery("שדקים")));
    stacked.multi_match.fields = stacked.multi_match.fields.map((f: string) =>
      f.includes("^") ? f.replace("^", ".morph^") : `${f}.morph`,
    );
    const properTop = await searchHandles(fuzzyLegQuery("שדקים"));
    const stackedTop = await searchHandles(stacked);
    expect(properTop).toContain(ANCHOR);
    expect(stackedTop).not.toContain(ANCHOR);
  });
});
