// Seeds the harness index once per test run: fresh index with the production
// INDEX_BODY (so analyzer changes are always picked up), bulk-loads the frozen
// 499-product corpus — with real vectors from the benchmark's embedding cache
// when present (see harness.ts) — and deletes it on teardown.
import { deleteIndex, ensureIndex, opensearch } from "../../app/services/opensearch.server";
import { TEST_ALIAS, corpusDocVector, hasEmbeddingCache, loadCorpusDocs } from "./harness";

// 3072-dim vectors make docs ~50KB each — chunk the bulk well under the
// default 100MB http.max_content_length.
const BULK_CHUNK = 100;

export default async function setup() {
  await deleteIndex(TEST_ALIAS);
  await ensureIndex(TEST_ALIAS);

  const withVectors = hasEmbeddingCache();
  if (!withVectors) {
    console.warn(
      "[harness] benchmark embedding cache missing — seeding without vectors; hybrid tests will fail",
    );
  }

  const docs = loadCorpusDocs();
  for (let i = 0; i < docs.length; i += BULK_CHUNK) {
    const body = docs.slice(i, i + BULK_CHUNK).flatMap(({ handle, doc }) => [
      { index: { _index: TEST_ALIAS, _id: handle } },
      withVectors
        ? { ...doc, embedding: corpusDocVector(doc), embedding_stale: false }
        : doc,
    ]);
    const res = await opensearch.bulk({ refresh: true, body: body as never });
    if (res.body.errors) {
      const bad = (res.body.items as any[]).find((it) => it.index?.error);
      throw new Error(`harness seed failed: ${JSON.stringify(bad?.index?.error)}`);
    }
  }

  const count = await opensearch.count({ index: TEST_ALIAS });
  if (count.body.count !== docs.length) {
    throw new Error(`harness seed count mismatch: ${count.body.count} != ${docs.length}`);
  }

  return async () => {
    await deleteIndex(TEST_ALIAS);
  };
}
