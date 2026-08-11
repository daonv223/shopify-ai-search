import { EMBED_DIM } from "./opensearch.server";

// Embedding provider interface (spec §2.4 / §3.2). Gemini is the v1 default;
// nothing outside this module knows the provider — everything else depends on
// the interface, so an OpenAI implementation can slot in later.

export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface EmbeddingProvider {
  // Contract: returned vectors are unit-normalized, so the index's
  // faiss `innerproduct` space is exactly cosine (benchmark parity —
  // 03_index_opensearch.py normalized every vector before indexing; the
  // Gemini API does NOT pre-normalize 3072-dim output).
  embed(texts: string[], taskType: EmbedTaskType): Promise<number[][]>;
}

// Port of the benchmark's EmbeddingClient (benchmark/part2_retrieval/common.py):
// same model, batch endpoint, batch size, and retry policy.
const MODEL = "models/gemini-embedding-001";
const EMBED_API = `https://generativelanguage.googleapis.com/v1beta/${MODEL}:batchEmbedContents`;
const EMBED_BATCH = 50;
const ATTEMPTS = 5;

function unitNormalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  constructor(private apiKey: string) {}

  async embed(texts: string[], taskType: EmbedTaskType): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const chunk = texts.slice(i, i + EMBED_BATCH);
      const body = await this.post({
        requests: chunk.map((text) => ({
          model: MODEL,
          content: { parts: [{ text }] },
          taskType,
        })),
      });
      const embeddings = body.embeddings ?? [];
      if (embeddings.length !== chunk.length) {
        throw new Error(`Gemini returned ${embeddings.length} embeddings for ${chunk.length} requests`);
      }
      for (const emb of embeddings) {
        if (emb.values.length !== EMBED_DIM) {
          throw new Error(`Gemini returned unexpected dimension ${emb.values.length}`);
        }
        vectors.push(unitNormalize(emb.values));
      }
    }
    return vectors;
  }

  // Basic retry with exponential backoff on 429/5xx and network errors; hard
  // rate limits and cost guards are Phase 5.3.
  private async post(body: unknown): Promise<{ embeddings?: { values: number[] }[] }> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(EMBED_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (attempt >= ATTEMPTS) throw err;
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (res.ok) return res.json();
      const detail = (await res.text()).slice(0, 300);
      if ((res.status === 429 || res.status >= 500) && attempt < ATTEMPTS) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw new Error(`Gemini API error ${res.status}: ${detail}`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// null when GEMINI_API_KEY is unset — dev setups without the key keep working
// (the backfill sweep logs and skips; query embedding throws).
export function defaultEmbeddingProvider(): EmbeddingProvider | null {
  const key = process.env.GEMINI_API_KEY;
  return key ? new GeminiEmbeddingProvider(key) : null;
}

// Query-side embedding for task 3.3's kNN leg.
export async function embedQuery(text: string): Promise<number[]> {
  const provider = defaultEmbeddingProvider();
  if (!provider) throw new Error("GEMINI_API_KEY not set — cannot embed query");
  const [vector] = await provider.embed([text], "RETRIEVAL_QUERY");
  return vector;
}
