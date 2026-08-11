// Seeds the harness index once per test run: fresh index with the production
// INDEX_BODY (so analyzer changes are always picked up), bulk-loads the frozen
// 499-product corpus, deletes it on teardown.
import { deleteIndex, ensureIndex, opensearch } from "../../app/services/opensearch.server";
import { TEST_ALIAS, loadCorpusDocs } from "./harness";

export default async function setup() {
  await deleteIndex(TEST_ALIAS);
  await ensureIndex(TEST_ALIAS);

  const docs = loadCorpusDocs();
  const body = docs.flatMap(({ handle, doc }) => [
    { index: { _index: TEST_ALIAS, _id: handle } },
    doc,
  ]);
  const res = await opensearch.bulk({ refresh: true, body: body as never });
  if (res.body.errors) {
    const bad = (res.body.items as any[]).find((it) => it.index?.error);
    throw new Error(`harness seed failed: ${JSON.stringify(bad?.index?.error)}`);
  }

  const count = await opensearch.count({ index: TEST_ALIAS });
  if (count.body.count !== docs.length) {
    throw new Error(`harness seed count mismatch: ${count.body.count} != ${docs.length}`);
  }

  return async () => {
    await deleteIndex(TEST_ALIAS);
  };
}
