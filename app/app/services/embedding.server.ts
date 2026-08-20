import { EMBED_DIM } from "./opensearch.server";
import { searchConfigRow } from "./search-config.server";

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
export const DEFAULT_GEMINI_MODEL = "gemini-embedding-001";
const EMBED_BATCH = 50;
const ATTEMPTS = 5;

// The Gemini API names the model `models/<id>`; the admin stores the bare id.
function geminiModelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function unitNormalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private endpoint: string;

  constructor(
    private apiKey: string,
    model: string = DEFAULT_GEMINI_MODEL,
  ) {
    this.model = geminiModelPath(model);
    this.endpoint = `https://generativelanguage.googleapis.com/v1beta/${this.model}:batchEmbedContents`;
  }

  async embed(texts: string[], taskType: EmbedTaskType): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const chunk = texts.slice(i, i + EMBED_BATCH);
      const body = await this.post({
        requests: chunk.map((text) => ({
          model: this.model,
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
        res = await fetch(this.endpoint, {
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

// Per-shop provider (task 5.1). Uses the shop's stored key/model when set,
// else falls back to the process default (GEMINI_API_KEY). The doc-embedding
// backfill resolves through here so a merchant can bring their own key. The
// query cache stays on the process default — vectors are shop-independent
// (same model → same vector), so per-shop keys there add no value in v1.
export async function embeddingProviderForShop(shop: string): Promise<EmbeddingProvider | null> {
  const row = await searchConfigRow(shop);
  if (row?.embeddingApiKey) {
    return new GeminiEmbeddingProvider(row.embeddingApiKey, row.embeddingModel || DEFAULT_GEMINI_MODEL);
  }
  return defaultEmbeddingProvider();
}

// Validate a provider/model/key by embedding one probe vector (spec §3.1:
// "validate the key with a one-vector test call before saving"). Returns a
// flat ok/error the admin action can surface without leaking the key.
export async function validateEmbeddingKey(
  provider: string,
  model: string,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  if (provider !== "gemini") {
    return { ok: false, error: `provider ${provider} is not supported yet` };
  }
  try {
    const [vector] = await new GeminiEmbeddingProvider(apiKey, model).embed(["בדיקה"], "RETRIEVAL_QUERY");
    if (!vector || vector.length !== EMBED_DIM) {
      return { ok: false, error: `unexpected embedding dimension ${vector?.length ?? 0}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Query-side embedding for task 3.3's kNN leg.
export async function embedQuery(text: string): Promise<number[]> {
  const provider = defaultEmbeddingProvider();
  if (!provider) throw new Error("GEMINI_API_KEY not set — cannot embed query");
  const [vector] = await provider.embed([text], "RETRIEVAL_QUERY");
  return vector;
}
