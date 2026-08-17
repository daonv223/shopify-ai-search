// Task 3.1: the production lexical leg (search.server.ts) against the frozen
// corpus. Re-runs the Phase 2 tier battery through `lexicalQuery` — same
// thresholds as retrieval.test.ts, so the bare-field uplift and the §3.1
// coverage extension must not regress the morph leg's scores (A3).
import { afterAll, describe, expect, it } from "vitest";

import { opensearch } from "../../app/services/opensearch.server";
import { lexicalQuery, lexicalSearch } from "../../app/services/search.server";
import { TEST_ALIAS, hit10, searchHandles, tierHitRate, tierQueries } from "./harness";

describe("baseline tier — production lexical leg (A3 regression guard)", () => {
  it("every baseline query still hits its ground truth in top-10", async () => {
    for (const row of tierQueries("baseline")) {
      const top = await searchHandles(lexicalQuery(row.query));
      expect(hit10(top, row.positives), `query ${row.query}`).toBeGreaterThan(0);
    }
  });

  it("tier hit@10 mean ≥ 0.8", async () => {
    const { mean, perQuery } = await tierHitRate(tierQueries("baseline"), lexicalQuery);
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.8);
  });
});

describe("stemming tier — production lexical leg (A3)", () => {
  it("every stemming query hits its ground truth in top-10", async () => {
    for (const row of tierQueries("stemming")) {
      const top = await searchHandles(lexicalQuery(row.query));
      expect(hit10(top, row.positives), `query ${row.query}`).toBeGreaterThan(0);
    }
  });

  it("tier hit@10 mean ≥ 0.9 (benchmark: 97%)", async () => {
    const { mean, perQuery } = await tierHitRate(tierQueries("stemming"), lexicalQuery);
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.9);
  });
});

describe("prefixes tier — production lexical leg (A3)", () => {
  it("bare and clitic-prefixed forms match the same products", async () => {
    for (const row of tierQueries("prefixes")) {
      const top = await searchHandles(lexicalQuery(row.query));
      expect(hit10(top, row.positives), `query ${row.query}`).toBeGreaterThan(0);
    }
  });

  // Calibrated 0.971 (morph-only leg: 1.0): for שמן לגוף the bare clause
  // ranks literal-לגוף titles above one stem-only positive — the intended
  // exact-precedence tradeoff, still comfortably over the tier bar.
  it("tier hit@10 mean ≥ 0.9", async () => {
    const { mean, perQuery } = await tierHitRate(tierQueries("prefixes"), lexicalQuery);
    expect(mean, JSON.stringify(perQuery)).toBeGreaterThanOrEqual(0.9);
  });
});

// Exact-vs-morph precedence + `exact` diagnostics, on a corpus-audited case:
// for the query מסכה, two products carry the literal token in their title
// (reset-mask-10gr, intensive-repair-mask-200ml-200ml) while two others say
// only מסכות/למסכת and can match solely through morphology (face-mask-brush,
// glow-revealing-exfoliating-mask-75ml).
describe("exact precedence — מסכה", () => {
  const EXACT_DOCS = ["reset-mask-10gr", "intensive-repair-mask-200ml-200ml"];
  const MORPH_ONLY_DOCS = ["face-mask-brush", "glow-revealing-exfoliating-mask-75ml"];

  it("literal-title docs outrank stem-only docs, and the exact flag separates them", async () => {
    const { hits } = await lexicalSearch(TEST_ALIAS, "מסכה", 50);
    const rank = (h: string) => {
      const i = hits.findIndex((hit) => hit.handle === h);
      return i === -1 ? Infinity : i;
    };
    for (const exact of EXACT_DOCS) {
      expect(rank(exact), `${exact} missing`).toBeLessThan(Infinity);
      expect(hits[rank(exact)].exact, `${exact} should be an exact match`).toBe(true);
      for (const morphOnly of MORPH_ONLY_DOCS) {
        expect(rank(exact), `${exact} vs ${morphOnly}`).toBeLessThan(rank(morphOnly));
      }
    }
    for (const morphOnly of MORPH_ONLY_DOCS) {
      const i = rank(morphOnly);
      if (i < Infinity) {
        expect(hits[i].exact, `${morphOnly} should be morph-only`).toBe(false);
      }
    }
  });
});

// A1: a doc whose distinctive attribute exists ONLY in metafield_text is found
// by the lexical leg. The frozen corpus has no metafields, so index one
// synthetic doc (token פלומיאל appears nowhere in the corpus), then remove it
// so parallel test files see the corpus unchanged for every real query.
describe("A1 — metafield_text coverage", () => {
  const HANDLE = "a1-synthetic-metafield-only";
  const TOKEN = "פלומיאל";

  afterAll(async () => {
    await opensearch.delete({ index: TEST_ALIAS, id: HANDLE, refresh: true });
  });

  it("finds a product searchable only through metafield_text", async () => {
    await opensearch.index({
      index: TEST_ALIAS,
      id: HANDLE,
      refresh: true,
      body: {
        product_id: "a1-synthetic",
        handle: HANDLE,
        title: "A1 synthetic",
        metafield_text: [`מכיל תמצית ${TOKEN} טהורה`],
      } as never,
    });

    const { hits, exactMatchCount, highSignalMatchCount } = await lexicalSearch(TEST_ALIAS, TOKEN);
    expect(hits.map((h) => h.handle)).toContain(HANDLE);
    const hit = hits.find((h) => h.handle === HANDLE)!;
    expect(hit.exact).toBe(true); // metafield_text is a bare/exact field
    // metafield_text is free-form text → low-signal (unlike sku/vendor/
    // category_name, which are high-signal lookup fields). Diagnostic only:
    // the v1 gate keys off `exact`, so this hit alone keeps the leg open.
    expect(hit.highSignal).toBe(false);
    expect(exactMatchCount).toBeGreaterThanOrEqual(1);
    expect(highSignalMatchCount).toBe(0);
  });
});
