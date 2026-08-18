// A8 / B1 latency harness (specs/storefront-surfaces/spec.md §3.0): runs the
// §5 battery through the three Phase 3 entry points and reports p50/p95 so the
// type-ahead contract (bounded semantic — embedding timeout) is decided on
// measured numbers, not guesses. Numbers are recorded in
// specs/storefront-surfaces/phase4-notes.md.
//
//   lexical        lexicalSearch            — the lexical-only floor; must be
//                                             p95 < 100ms server-side (task
//                                             4.1 type-ahead budget, asserted)
//   hybrid-cached  hybridSearchWithVector   — cached query vector from the
//                                             benchmark cache → OpenSearch
//                                             fusion cost alone (lexical + kNN
//                                             legs in parallel + RRF)
//   embed-live     embedQuery               — the Gemini query-embedding round
//                                             trip alone (what the type-ahead
//                                             timeout bounds)
//   hybrid-live    embedQuery → hybridSearchWithVector — end-to-end hybrid,
//                                             the exact code path of
//                                             hybridSearch(), timed in two
//                                             segments so one Gemini call
//                                             yields both the embed and the
//                                             total sample
//
// Wall-clock in the Node process (performance.now()), i.e. server-side as the
// app would see it — includes the OpenSearch HTTP round trip on localhost, not
// the app-proxy hop. Every query is run once unmeasured as warm-up (client
// connection, JIT), then LATENCY_REPS times (default 5; live legs default 3
// to stay clear of Gemini rate limits — a 429 retry inside the provider would
// show up as a multi-second outlier, so `max` is reported alongside p95).
//
// Live legs are opt-in (LATENCY_LIVE=1 — `npm run latency` sets it) so the
// routine `npm test` stays free of Gemini calls; they need GEMINI_API_KEY
// (benchmark/.env — the key the benchmark cache was built with — else env)
// and are skipped without one. Run in isolation for clean numbers:
// `npm run latency` (single file, verbose reporter so the summary table
// prints, no parallel suites contending for OpenSearch).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, describe, expect, it } from "vitest";

import { embedQuery } from "../../app/services/embedding.server";
import { hybridSearchWithVector } from "../../app/services/hybrid-search.server";
import { queryEmbeddings } from "../../app/services/query-embedding.server";
import { lexicalSearch } from "../../app/services/search.server";
import {
  SUGGEST_EMBED_TIMEOUT_MS,
  suggest,
} from "../../app/services/storefront-search.server";
import { TEST_ALIAS, cachedVector, hasEmbeddingCache, loadRelevance } from "./harness";

const REPS = Number(process.env.LATENCY_REPS ?? 5);
const LIVE_REPS = Number(process.env.LATENCY_LIVE_REPS ?? 3);
const SIZE = 10; // results returned; hybrid legs still run at LEG_DEPTH (50) each

// The full frozen battery, all tiers (18 queries) — latency depends on query
// shape, not on whether a tier is in scope for relevance.
const QUERIES = [...new Set(loadRelevance().map((r) => r.query))];

type Mode =
  | "lexical"
  | "hybrid-cached"
  | "embed-live"
  | "hybrid-live"
  | "suggest-warm"
  | "suggest-cold";
const MODES: Mode[] = ["lexical", "hybrid-cached", "embed-live", "hybrid-live", "suggest-warm", "suggest-cold"];
const samples = Object.fromEntries(MODES.map((m) => [m, [] as number[]])) as Record<Mode, number[]>;
const perQuery = Object.fromEntries(
  MODES.map((m) => [m, {} as Record<string, number[]>]),
) as Record<Mode, Record<string, number[]>>;

function record(mode: Mode, query: string, ms: number) {
  samples[mode].push(ms);
  (perQuery[mode][query] ??= []).push(ms);
}

// Nearest-rank percentile on the sorted samples.
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function summary(values: number[]) {
  const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
    mean,
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

// `run` returns the sample for `mode`; it may record extra segments through
// `sub` (a no-op during the unmeasured warm-up pass, so warm-up never leaks
// into any series).
type Recorder = (mode: Mode, query: string, ms: number) => void;
async function measure(
  mode: Mode,
  reps: number,
  run: (q: string, sub: Recorder) => Promise<number>,
) {
  for (const q of QUERIES) await run(q, () => {}); // warm-up, unmeasured
  for (let rep = 0; rep < reps; rep++) {
    for (const q of QUERIES) record(mode, q, await run(q, record));
  }
}

// GEMINI_API_KEY from benchmark/.env first (the key the benchmark's embedding
// cache was produced with — the same source of truth as the vectors), else
// the environment. The file wins deliberately: dev shells have been seen
// exporting a stale key, and a 400 from Gemini would fail the live legs.
function resolveGeminiKey(): string | undefined {
  const envFile = path.resolve(import.meta.dirname, "../../../benchmark/.env");
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, "utf8").match(/^GEMINI_API_KEY=(.+)$/m);
    const key = m?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (key) return key;
  }
  return process.env.GEMINI_API_KEY || undefined;
}
const geminiKey = process.env.LATENCY_LIVE === "1" ? resolveGeminiKey() : undefined;
if (geminiKey) process.env.GEMINI_API_KEY = geminiKey;

const queryVector = (q: string) => cachedVector(q, "RETRIEVAL_QUERY");

describe("A8 / B1 — latency over the §5 battery", () => {
  it(`lexical: p95 < 100ms server-side (task 4.1 type-ahead budget), ${REPS} reps`, async () => {
    await measure("lexical", REPS, async (q) => {
      const { ms, value } = await timed(() => lexicalSearch(TEST_ALIAS, q, SIZE));
      expect(Array.isArray(value.hits)).toBe(true);
      return ms;
    });
    const s = summary(samples.lexical);
    expect(s.p95, `lexical p95 ${s.p95.toFixed(1)}ms`).toBeLessThan(100);
  });

  it.skipIf(!hasEmbeddingCache())(
    `hybrid with cached query vectors: fusion cost alone, ${REPS} reps`,
    async () => {
      const vectors = new Map(QUERIES.map((q) => [q, queryVector(q)]));
      await measure("hybrid-cached", REPS, async (q) => {
        const { ms, value } = await timed(() =>
          hybridSearchWithVector(TEST_ALIAS, q, vectors.get(q)!, SIZE),
        );
        // No hit-count bar: the semantic-anchor floor legitimately empties
        // gated typo-tier queries (עןר), and this test measures cost only.
        expect(Array.isArray(value.hits)).toBe(true);
        return ms;
      });
      // Recorded, not gated: the spec sets no bar on the fusion cost itself;
      // it only has to leave the lexical budget intact when the embedding is
      // already in hand (warm cache → sub-100ms suggest, B4).
      expect(summary(samples["hybrid-cached"]).n).toBe(QUERIES.length * REPS);
    },
  );

  // Live Gemini: one call per sample, timed in two segments. embed-live is
  // what the type-ahead timeout must bound; hybrid-live is A8 as Phase 3
  // defined it (end-to-end incl. query embedding — hybridSearch's code path).
  it.skipIf(!geminiKey)(
    `hybrid with live query embedding (Gemini): end-to-end, ${LIVE_REPS} reps`,
    async () => {
      await measure("hybrid-live", LIVE_REPS, async (q, sub) => {
        const t0 = performance.now();
        const vector = await embedQuery(q);
        const embedMs = performance.now() - t0;
        const res = await hybridSearchWithVector(TEST_ALIAS, q, vector, SIZE);
        const totalMs = performance.now() - t0;
        expect(Array.isArray(res.hits)).toBe(true);
        sub("embed-live", q, embedMs);
        return totalMs;
      });
      expect(summary(samples["embed-live"]).n).toBe(QUERIES.length * LIVE_REPS);
      expect(summary(samples["hybrid-live"]).n).toBe(QUERIES.length * LIVE_REPS);
    },
    // 18 queries × (1 warm-up + LIVE_REPS) Gemini calls, with retry headroom.
    600_000,
  );

  // B4 — the type-ahead surface itself (storefront-search.server.ts
  // `suggest`: partial-token rule, bounded embedding wait, depth-20 fusion),
  // minus the app-proxy hop. Warm: every battery vector already in the LRU.
  // Cold: LRU cleared before every call, live embedder → the wait expires at
  // SUGGEST_EMBED_TIMEOUT_MS and the answer is lexical-only, while the
  // embedding lands in the cache behind it (fire-and-cache).
  const quiet = async <T>(fn: () => Promise<T>) => {
    const orig = console.log; // one timing line per request — keep the report readable
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = orig;
    }
  };

  it.skipIf(!hasEmbeddingCache())(
    `B4 suggest, warm LRU: p95 < 100ms server-side, ${REPS} reps`,
    async () => {
      queryEmbeddings.clear();
      queryEmbeddings.setEmbedder(null);
      for (const q of QUERIES) queryEmbeddings.set(q, queryVector(q));
      await quiet(() =>
        measure("suggest-warm", REPS, async (q) => {
          const { ms, value } = await timed(() => suggest("latency", TEST_ALIAS, q, "8"));
          expect(["cached", "skipped"]).toContain(value.semantic);
          return ms;
        }),
      );
      expect(summary(samples["suggest-warm"]).p95).toBeLessThan(100);
    },
  );

  it.skipIf(!geminiKey)(
    `B4 suggest, cold LRU (live Gemini): p95 ≤ timeout (${SUGGEST_EMBED_TIMEOUT_MS}ms) + lexical p95, ${LIVE_REPS} reps`,
    async () => {
      queryEmbeddings.setEmbedder(undefined); // default provider (GEMINI_API_KEY)
      const statuses: string[] = [];
      await quiet(() =>
        measure("suggest-cold", LIVE_REPS, async (q) => {
          queryEmbeddings.clear(); // every keystroke cold (also drops what the previous one fired)
          const { ms, value } = await timed(() => suggest("latency", TEST_ALIAS, q, "8"));
          statuses.push(value.semantic);
          return ms;
        }),
      );
      // Let the fire-and-cache calls of the last round settle before teardown.
      await new Promise((r) => setTimeout(r, 1500));
      const measured = statuses.slice(-samples["suggest-cold"].length);
      const timeouts = measured.filter((st) => st === "timeout").length;
      const cold = summary(samples["suggest-cold"]);
      const lexP95 = percentile(samples.lexical, 95);
      console.log(
        `B4 cold: ${timeouts}/${measured.length} keystrokes timed out (lexical-only), ` +
          `${measured.filter((st) => st === "live").length} embedded in time; LRU holds ${queryEmbeddings.size} after settling`,
      );
      expect(cold.p95, `cold p95 ${cold.p95.toFixed(1)}ms`).toBeLessThanOrEqual(SUGGEST_EMBED_TIMEOUT_MS + lexP95 + 20);
      expect(cold.p95).toBeLessThan(100);
      // The vectors did land: after LIVE_REPS × 18 keystrokes the LRU is warm.
      expect(queryEmbeddings.size).toBeGreaterThan(0);
    },
    600_000,
  );
});

// Markdown table for phase4-notes.md. Skipped modes are reported as such so
// a run without a Gemini key can't be mistaken for a measurement.
afterAll(() => {
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "—");
  const rows = (Object.keys(samples) as Mode[]).map((mode) => {
    const s = summary(samples[mode]);
    return s.n
      ? `| ${mode} | ${s.n} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.max)} | ${fmt(s.mean)} |`
      : `| ${mode} | 0 | skipped | | | |`;
  });
  const slowest = (mode: Mode) =>
    Object.entries(perQuery[mode])
      .map(([q, v]) => [q, percentile(v, 50)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([q, p50]) => `${q} ${fmt(p50)}ms`)
      .join(", ");
  console.log(
    [
      "",
      `A8 latency — ${QUERIES.length} queries, reps: ${REPS} (live: ${LIVE_REPS}), size ${SIZE}, ms server-side`,
      "| mode | n | p50 | p95 | max | mean |",
      "|---|---|---|---|---|---|",
      ...rows,
      "",
      `slowest queries by p50 — lexical: ${slowest("lexical") || "—"}`,
      `slowest queries by p50 — hybrid-cached: ${slowest("hybrid-cached") || "—"}`,
      `slowest queries by p50 — embed-live: ${slowest("embed-live") || "—"}`,
      `slowest queries by p50 — suggest-warm: ${slowest("suggest-warm") || "—"}`,
      "",
    ].join("\n"),
  );
});
