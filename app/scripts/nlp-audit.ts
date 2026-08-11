// NLP precision audit (spec §3.2/§3.3): seeds the harness index from the
// frozen corpus, then dumps for human review:
//   A. top catalog tokens with their hebrew_morph variant expansions
//      (over-stripping spot-check)
//   B. highest-frequency stem collisions — distinct original words that meet
//      on one stem (desired for inflections of a lexeme, bad for unrelated words)
//   C. feminine singular↔plural gap pairs — catalog words ending ־ות whose
//      ־ה singular also occurs but shares no stem (the known gap of not
//      stripping feminine ה; candidates for a curated stemmer_override)
//
// Usage: npm run nlp:audit   (needs local OpenSearch)
import setup from "../tests/nlp/global-setup";
import { analyzeTokens, loadCorpusDocs, opensearchAnalyzeBatch } from "../tests/nlp/harness";

const HEBREW = /^[א-ת]+$/;

function docText(doc: any): string {
  return [
    doc.title,
    Array.isArray(doc.tags) ? doc.tags.join(" ") : doc.tags,
    doc.product_type,
    Array.isArray(doc.variant_titles) ? doc.variant_titles.join(" ") : "",
    Array.isArray(doc.option_values) ? doc.option_values.join(" ") : "",
    doc.body,
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  const teardown = await setup();
  const docs = loadCorpusDocs();

  // Original-token frequencies via the bare analyzer (post final-letter folding).
  const freq = new Map<string, number>();
  for (const { doc } of docs) {
    for (const t of await analyzeTokens("hebrew_text", docText(doc))) {
      if (HEBREW.test(t)) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const vocab = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`Hebrew vocab: ${vocab.length} unique tokens\n`);

  // Morph variants per unique vocab word (batched _analyze, grouped by position).
  const variants = await opensearchAnalyzeBatch(
    "hebrew_morph",
    vocab.map(([w]) => w),
  );

  console.log("=== A. Top 60 tokens → morph variants (spot-check for over-stripping) ===");
  for (const [w, n] of vocab.slice(0, 60)) {
    console.log(`${String(n).padStart(4)}  ${w}  →  ${[...variants.get(w)!].join(" | ")}`);
  }

  console.log("\n=== B. Top stem collisions (≥2 distinct originals on one stem) ===");
  const byStem = new Map<string, Set<string>>();
  for (const [w] of vocab) {
    for (const s of variants.get(w)!) {
      if (!byStem.has(s)) byStem.set(s, new Set());
      byStem.get(s)!.add(w);
    }
  }
  const collisions = [...byStem.entries()]
    .filter(([, words]) => words.size >= 2)
    .map(([stem, words]) => ({
      stem,
      words: [...words],
      total: [...words].reduce((a, w) => a + freq.get(w)!, 0),
    }))
    .sort((a, b) => b.total - a.total);
  for (const c of collisions.slice(0, 40)) {
    console.log(`${String(c.total).padStart(4)}  ${c.stem}  ←  ${c.words.join(", ")}`);
  }
  console.log(`(${collisions.length} colliding stems total)`);

  console.log("\n=== C. Plural vs ־ה singular pairs with NO shared stem (־ות and ־ימ plurals) ===");
  let gaps = 0;
  for (const [w, n] of vocab) {
    if (!(w.endsWith("ות") || w.endsWith("ימ")) || w.length < 4) continue;
    const singular = w.slice(0, -2) + "ה";
    if (!freq.has(singular)) continue;
    const shared = [...variants.get(w)!].some((s) => variants.get(singular)!.has(s));
    if (!shared) {
      gaps++;
      console.log(
        `${w} (${n})  vs  ${singular} (${freq.get(singular)})  —  ` +
          `${[...variants.get(w)!].join("|")}  vs  ${[...variants.get(singular)!].join("|")}`,
      );
    }
  }
  console.log(`(${gaps} gap pairs)`);

  await teardown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
