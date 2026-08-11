// Reindex rollout (spec §3.6 / acceptance A6): _v2 built from _v1 with the
// current analyzers, alias flipped atomically, doc count unchanged, _v1 gone.
// Uses its own alias so the seeded harness index is untouched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deleteIndex,
  ensureIndex,
  migrateIndex,
  opensearch,
} from "../../app/services/opensearch.server";

const ALIAS = "nlp-harness-migrate";

const DOCS = [
  { product_id: "1", handle: "almond-oil", title: "שמן גוף שקדים" },
  { product_id: "2", handle: "mask", title: "מסכה לפנים" },
];

beforeAll(async () => {
  await deleteIndex(ALIAS);
  await ensureIndex(ALIAS);
  await opensearch.bulk({
    refresh: true,
    body: DOCS.flatMap((doc) => [{ index: { _index: ALIAS, _id: doc.handle } }, doc]),
  });
});

afterAll(async () => {
  await deleteIndex(ALIAS);
});

describe("migrateIndex (§3.6, A6)", () => {
  it("builds _v2, flips the alias, keeps every doc, and drops _v1", async () => {
    const next = await migrateIndex(ALIAS);
    expect(next).toBe(`${ALIAS}_v2`);

    const aliasTarget = await opensearch.indices.getAlias({ name: ALIAS });
    expect(Object.keys(aliasTarget.body)).toEqual([`${ALIAS}_v2`]);

    const v1Exists = await opensearch.indices.exists({ index: `${ALIAS}_v1` });
    expect(v1Exists.body).toBe(false);

    const count = await opensearch.count({ index: ALIAS });
    expect(count.body.count).toBe(DOCS.length);

    // The migrated index runs the current analyzer stack: a morph-leg query
    // for the plural finds the doc indexed with a singular-only title.
    const res = await opensearch.search({
      index: ALIAS,
      body: {
        query: { match: { "title.morph": "שמנים" } },
      } as never,
    });
    const handles = (res.body.hits.hits as any[]).map((h) => h._id);
    expect(handles).toContain("almond-oil");
  });

  it("bumps to _v3 on a repeat migration (generic version parse)", async () => {
    const next = await migrateIndex(ALIAS);
    expect(next).toBe(`${ALIAS}_v3`);
    const count = await opensearch.count({ index: ALIAS });
    expect(count.body.count).toBe(DOCS.length);
  });
});
