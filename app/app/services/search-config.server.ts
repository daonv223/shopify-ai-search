// Per-shop search config (task 5.1): synonyms + per-field boosts applied at
// query time, and the embedding provider/model/key. One `SearchConfig` row per
// shop; missing row or missing fields fall back to the Phase 3 defaults so an
// un-configured shop behaves exactly as before this task.
//
// The API key never leaves the server: the admin loader reads the resolved
// `SearchConfig` shape (which carries `hasApiKey`, not the key), while the
// ingest path reads the raw row through `searchConfigRow`.
import db from "../db.server";
import {
  BOOSTABLE_FIELDS,
  BOOST_MAX,
  BOOST_MIN,
  DEFAULT_BOOSTS,
  type BoostConfig,
  type SynonymGroup,
} from "./search.server";

// The query-time levers (boosts, synonyms) are defined in search.server.ts so
// the pure query logic carries no DB dependency; re-exported here as the config
// layer's public surface.
export {
  BOOSTABLE_FIELDS,
  BOOST_MAX,
  BOOST_MIN,
  DEFAULT_BOOSTS,
  type BoostConfig,
  type BoostField,
  type SynonymGroup,
} from "./search.server";

export const EMBEDDING_PROVIDERS = ["gemini"] as const; // openai deferred (spec §3.1 scope)
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

// Browser-safe shape — no API key, only whether one is set.
export type SearchConfig = {
  embeddingProvider: string;
  embeddingModel: string;
  hasApiKey: boolean;
  synonyms: SynonymGroup[];
  boosts: BoostConfig;
};

// The embedding provider fields, server-only. Carried on QueryConfig so the
// storefront resolves the shop's provider from the same row it already reads.
export type EmbeddingSettings = {
  embeddingProvider: string;
  embeddingModel: string;
  embeddingApiKey: string | null;
};

// Only what the query path needs, in one read.
export type QueryConfig = {
  synonyms: SynonymGroup[];
  boosts: BoostConfig;
  embedding: EmbeddingSettings;
};

type SearchConfigRow = {
  embeddingProvider: string;
  embeddingModel: string;
  embeddingApiKey: string | null;
  synonyms: unknown;
  boosts: unknown;
};

function normalizeBoosts(raw: unknown): BoostConfig {
  const out = { ...DEFAULT_BOOSTS };
  if (raw && typeof raw === "object") {
    for (const field of BOOSTABLE_FIELDS) {
      const v = (raw as Record<string, unknown>)[field];
      if (typeof v === "number" && Number.isFinite(v)) {
        out[field] = Math.min(BOOST_MAX, Math.max(BOOST_MIN, v));
      }
    }
  }
  return out;
}

function normalizeSynonyms(raw: unknown): SynonymGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: SynonymGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const termsRaw = (g as { terms?: unknown }).terms;
    if (!Array.isArray(termsRaw)) continue;
    const terms = termsRaw
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.normalize("NFC").trim())
      .filter(Boolean);
    if (terms.length < 2) continue; // a group needs at least two terms to mean anything
    groups.push({ terms, oneWay: Boolean((g as { oneWay?: unknown }).oneWay) });
  }
  return groups;
}

// Raw row incl. the API key — server-only (ingest / validation path).
export async function searchConfigRow(shop: string): Promise<SearchConfigRow | null> {
  return db.searchConfig.findUnique({
    where: { shop },
    select: {
      embeddingProvider: true,
      embeddingModel: true,
      embeddingApiKey: true,
      synonyms: true,
      boosts: true,
    },
  });
}

// Browser-safe resolved config with defaults merged in.
export async function getSearchConfig(shop: string): Promise<SearchConfig> {
  const row = await searchConfigRow(shop);
  return {
    embeddingProvider: row?.embeddingProvider ?? "gemini",
    embeddingModel: row?.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    hasApiKey: Boolean(row?.embeddingApiKey),
    synonyms: normalizeSynonyms(row?.synonyms),
    boosts: normalizeBoosts(row?.boosts),
  };
}

// Just the query-time levers (synonyms + boosts) — the storefront path reads
// this on every search. Defaults keep an un-configured shop on the Phase 3
// ranking.
export async function getQueryConfig(shop: string): Promise<QueryConfig> {
  const row = await db.searchConfig.findUnique({
    where: { shop },
    select: {
      synonyms: true,
      boosts: true,
      embeddingProvider: true,
      embeddingModel: true,
      embeddingApiKey: true,
    },
  });
  return {
    synonyms: normalizeSynonyms(row?.synonyms),
    boosts: normalizeBoosts(row?.boosts),
    embedding: {
      embeddingProvider: row?.embeddingProvider ?? "gemini",
      embeddingModel: row?.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
      embeddingApiKey: row?.embeddingApiKey ?? null,
    },
  };
}

// Upsert a partial patch. Undefined fields are left untouched; a null API key
// clears the stored key. Values are normalized before persisting.
export async function updateSearchConfig(
  shop: string,
  patch: {
    embeddingProvider?: string;
    embeddingModel?: string;
    embeddingApiKey?: string | null;
    synonyms?: SynonymGroup[];
    boosts?: BoostConfig;
  },
): Promise<void> {
  const data: Record<string, unknown> = {};
  if (patch.embeddingProvider !== undefined) data.embeddingProvider = patch.embeddingProvider;
  if (patch.embeddingModel !== undefined) data.embeddingModel = patch.embeddingModel;
  if (patch.embeddingApiKey !== undefined) data.embeddingApiKey = patch.embeddingApiKey;
  if (patch.synonyms !== undefined) data.synonyms = normalizeSynonyms(patch.synonyms);
  if (patch.boosts !== undefined) data.boosts = normalizeBoosts(patch.boosts);

  await db.searchConfig.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
}
