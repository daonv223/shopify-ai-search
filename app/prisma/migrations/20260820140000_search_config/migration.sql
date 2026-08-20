-- CreateTable
CREATE TABLE "SearchConfig" (
    "shop" TEXT NOT NULL,
    "embeddingProvider" TEXT NOT NULL DEFAULT 'gemini',
    "embeddingModel" TEXT NOT NULL DEFAULT 'gemini-embedding-001',
    "embeddingApiKey" TEXT,
    "synonyms" JSONB,
    "boosts" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchConfig_pkey" PRIMARY KEY ("shop")
);
