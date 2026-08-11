// Reindex rollout runner (spec §3.6): rebuilds the physical index behind an
// alias with the current INDEX_BODY and flips the alias with zero downtime.
//
// Usage: npm run migrate-index -- <alias>     (e.g. products_hebrew_ai_search_dev)
// List candidates: curl -s localhost:9200/_cat/aliases?v
import { migrateIndex, opensearch } from "../app/services/opensearch.server";

async function main() {
  const alias = process.argv[2];
  if (!alias) {
    console.error("usage: npm run migrate-index -- <alias>");
    process.exit(1);
  }

  const before = await opensearch.indices.getAlias({ name: alias }, { ignore: [404] });
  if (before.statusCode === 404) {
    console.error(`alias ${alias} does not exist — nothing to migrate`);
    process.exit(1);
  }
  const current = Object.keys(before.body)[0];
  const count = await opensearch.count({ index: alias });
  console.log(`${alias} -> ${current} (${count.body.count} docs), migrating…`);

  const next = await migrateIndex(alias);

  const after = await opensearch.count({ index: alias });
  console.log(`${alias} -> ${next} (${after.body.count} docs), ${current} deleted`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
