// Sync-status read model for the embedded admin (task 5.1). One query bundle:
// the latest SyncRun for the shop plus ProductSyncState counts. Returns
// primitives (ISO strings) so the loader payload is trivially serializable and
// the component formats for display.
import db from "../db.server";
import { serializeError, type ErrorDetail } from "./log.server";

export type SyncStatus = {
  run: {
    id: string;
    status: string; // running | success | failed
    productCount: number | null;
    error: ErrorDetail | null;
    startedAt: string; // ISO
    finishedAt: string | null; // ISO
  } | null;
  indexedCount: number; // ProductSyncState rows tracked for the shop
  staleCount: number; // rows still awaiting an embedding
};

function toErrorDetail(raw: unknown): ErrorDetail | null {
  if (!raw) return null;
  if (typeof raw === "object" && "message" in (raw as object)) {
    return raw as ErrorDetail;
  }
  return serializeError(raw);
}

export async function getSyncStatus(shop: string): Promise<SyncStatus> {
  const [run, indexedCount, staleCount] = await Promise.all([
    db.syncRun.findFirst({ where: { shop }, orderBy: { startedAt: "desc" } }),
    db.productSyncState.count({ where: { shop } }),
    db.productSyncState.count({ where: { shop, embeddingStale: true } }),
  ]);
  return {
    run: run
      ? {
          id: run.id,
          status: run.status,
          productCount: run.productCount,
          error: toErrorDetail(run.error),
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
        }
      : null,
    indexedCount,
    staleCount,
  };
}
