// Query-embedding cache + bounded wait (Phase 4 spec §3.1, decided in
// phase4-notes.md "A8"): the storefront surfaces ask for a query vector with a
// deadline. A cache hit answers at once; otherwise the embedding call is
// started (or joined, if the same query is already in flight) and awaited for
// at most `timeoutMs`. On expiry the caller gets `null` and goes lexical-only
// — but the call is NOT aborted: fire-and-cache. It lands in the LRU ~400ms
// later (A8: Gemini floor ~340ms), so the shopper's settled query is warm by
// the time the results page asks, and every repeat is hybrid within budget.
//
// In-process LRU keyed by model id + normalized query. Embeddings are
// shop-independent (same model → same vector), so one entry serves every store
// on that model, while a shop on a different model can never read another
// model's vectors. Redis is Phase 5.3 (open question 2) if multi-instance hit
// rates demand it.
import type { EmbeddingProvider } from "./embedding.server";

export const QUERY_CACHE_CAPACITY = 5_000; // 5k × 3072 floats × 8B ≈ 120MB worst case
const INFLIGHT_MAX_MS = 15_000; // an in-flight promise older than this is treated as dead

// What the semantic leg did for a request — surfaced in every response so the
// dropdown knows when a one-shot upgrade re-fetch is worth it (only on
// "timeout": the vector is on its way into the cache).
export type SemanticStatus =
  | "cached" // LRU hit
  | "live" // embedded within the deadline (results page, or a fast round trip)
  | "timeout" // fired, deadline expired, lexical-only for this request
  | "skipped" // caller skipped the leg (partial-token rule)
  | "off"; // no provider configured, or the embedding call failed

export type Embedder = (text: string) => Promise<number[]>;

// Vector space for entries written without a provider — a test-injected
// embedder, or a manual `set()`. Real providers key on their model id.
export const DEFAULT_SPACE = "default";

function cacheKey(space: string, query: string): string {
  return `${space}\u0000${normalizeQuery(query)}`;
}

// Normalization is only for cache identity: whitespace and case. Hebrew has
// no case, and final-letter folding belongs to the analyzer, not the key —
// `שמן` and `שמנ` are different queries to embed.
export function normalizeQuery(q: string): string {
  return q.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

class QueryEmbeddingCache {
  private lru = new Map<string, number[]>();
  private inflight = new Map<string, { promise: Promise<number[]>; startedAt: number }>();
  private override: Embedder | null | undefined; // undefined = use the caller's provider
  stats = { hits: 0, misses: 0, timeouts: 0, errors: 0 };

  constructor(private capacity = QUERY_CACHE_CAPACITY) {}

  // Tests inject a deterministic embedder (or null = provider off). It also
  // pins the vector space to DEFAULT_SPACE, so a test that pre-loads entries
  // with `set()` addresses the same keys `get()` reads.
  setEmbedder(embedder: Embedder | null | undefined) {
    this.override = embedder;
    this.inflight.clear();
  }

  // The caller passes the shop's provider, resolved from its SearchConfig — so
  // a merchant key set in admin Settings is the only key billed here. `null`
  // (shop stored no key) means the semantic leg is off; there is no
  // environment fallback, by design.
  private resolve(provider: EmbeddingProvider | null): { embed: Embedder | null; space: string } {
    if (this.override !== undefined) return { embed: this.override, space: DEFAULT_SPACE };
    if (!provider) return { embed: null, space: DEFAULT_SPACE };
    return {
      embed: async (text) => (await provider.embed([text], "RETRIEVAL_QUERY"))[0],
      space: provider.modelId,
    };
  }

  get size() {
    return this.lru.size;
  }

  clear() {
    this.lru.clear();
    this.inflight.clear();
    this.stats = { hits: 0, misses: 0, timeouts: 0, errors: 0 };
  }

  peek(query: string, space: string = DEFAULT_SPACE): number[] | undefined {
    return this.lru.get(cacheKey(space, query));
  }

  set(query: string, vector: number[], space: string = DEFAULT_SPACE) {
    const key = cacheKey(space, query);
    this.lru.delete(key); // re-insert → most recent
    this.lru.set(key, vector);
    if (this.lru.size > this.capacity) {
      const oldest = this.lru.keys().next().value;
      if (oldest !== undefined) this.lru.delete(oldest);
    }
  }

  // Bounded lookup. `timeoutMs` 0 = don't wait for a miss at all (still fires
  // the call). Never throws: embedding failures degrade to lexical-only.
  async get(
    query: string,
    timeoutMs: number,
    provider: EmbeddingProvider | null,
  ): Promise<{ vector: number[] | null; status: Exclude<SemanticStatus, "skipped"> }> {
    const { embed, space } = this.resolve(provider);
    const key = cacheKey(space, query);
    const cached = this.lru.get(key);
    if (cached) {
      this.lru.delete(key);
      this.lru.set(key, cached);
      this.stats.hits++;
      return { vector: cached, status: "cached" };
    }
    this.stats.misses++;

    if (!embed) return { vector: null, status: "off" };

    let entry = this.inflight.get(key);
    if (!entry || Date.now() - entry.startedAt > INFLIGHT_MAX_MS) {
      const promise = embed(query).then(
        (vector) => {
          this.set(query, vector, space);
          this.inflight.delete(key);
          return vector;
        },
        (err) => {
          this.inflight.delete(key);
          this.stats.errors++;
          console.error(
            JSON.stringify({
              evt: "query_embed_error",
              q_len: query.length,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err;
        },
      );
      promise.catch(() => {}); // fire-and-cache: no unhandled rejection when nobody awaits
      entry = { promise, startedAt: Date.now() };
      this.inflight.set(key, entry);
    }

    const outcome = await raceWithTimeout(entry.promise, timeoutMs);
    if (outcome.kind === "value") return { vector: outcome.value, status: "live" };
    if (outcome.kind === "timeout") {
      this.stats.timeouts++;
      return { vector: null, status: "timeout" };
    }
    return { vector: null, status: "off" };
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ kind: "value"; value: T } | { kind: "timeout" } | { kind: "error" }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ kind: "value" as const, value }),
        () => ({ kind: "error" as const }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const queryEmbeddings = new QueryEmbeddingCache();
