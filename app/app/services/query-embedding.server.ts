// Query-embedding cache + bounded wait (Phase 4 spec §3.1, decided in
// phase4-notes.md "A8"): the storefront surfaces ask for a query vector with a
// deadline. A cache hit answers at once; otherwise the embedding call is
// started (or joined, if the same query is already in flight) and awaited for
// at most `timeoutMs`. On expiry the caller gets `null` and goes lexical-only
// — but the call is NOT aborted: fire-and-cache. It lands in the LRU ~400ms
// later (A8: Gemini floor ~340ms), so the shopper's settled query is warm by
// the time the results page asks, and every repeat is hybrid within budget.
//
// In-process LRU keyed by the normalized query — embeddings are
// shop-independent, so one entry serves every store. Redis is Phase 5.3
// (open question 2) if multi-instance hit rates demand it.
import { defaultEmbeddingProvider } from "./embedding.server";

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

// Normalization is only for cache identity: whitespace and case. Hebrew has
// no case, and final-letter folding belongs to the analyzer, not the key —
// `שמן` and `שמנ` are different queries to embed.
export function normalizeQuery(q: string): string {
  return q.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

class QueryEmbeddingCache {
  private lru = new Map<string, number[]>();
  private inflight = new Map<string, { promise: Promise<number[]>; startedAt: number }>();
  private embedder: Embedder | null | undefined; // undefined = resolve lazily
  stats = { hits: 0, misses: 0, timeouts: 0, errors: 0 };

  constructor(private capacity = QUERY_CACHE_CAPACITY) {}

  // Tests inject a deterministic embedder (or null = provider off). Default:
  // the Gemini provider when GEMINI_API_KEY is set, resolved on first use.
  setEmbedder(embedder: Embedder | null | undefined) {
    this.embedder = embedder;
    this.inflight.clear();
  }

  private resolveEmbedder(): Embedder | null {
    if (this.embedder === undefined) {
      const provider = defaultEmbeddingProvider();
      this.embedder = provider
        ? async (text) => (await provider.embed([text], "RETRIEVAL_QUERY"))[0]
        : null;
    }
    return this.embedder;
  }

  get size() {
    return this.lru.size;
  }

  clear() {
    this.lru.clear();
    this.inflight.clear();
    this.stats = { hits: 0, misses: 0, timeouts: 0, errors: 0 };
  }

  peek(query: string): number[] | undefined {
    return this.lru.get(normalizeQuery(query));
  }

  set(query: string, vector: number[]) {
    const key = normalizeQuery(query);
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
  ): Promise<{ vector: number[] | null; status: Exclude<SemanticStatus, "skipped"> }> {
    const key = normalizeQuery(query);
    const cached = this.lru.get(key);
    if (cached) {
      this.lru.delete(key);
      this.lru.set(key, cached);
      this.stats.hits++;
      return { vector: cached, status: "cached" };
    }
    this.stats.misses++;

    const embedder = this.resolveEmbedder();
    if (!embedder) return { vector: null, status: "off" };

    let entry = this.inflight.get(key);
    if (!entry || Date.now() - entry.startedAt > INFLIGHT_MAX_MS) {
      const promise = embedder(query).then(
        (vector) => {
          this.set(query, vector);
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
