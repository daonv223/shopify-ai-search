import { logEvent, reportError } from "./log.server";
import { drainWebhookEvents } from "./webhook-drain.server";
import { reconcileAllShops } from "./reconcile.server";

// In-process cron (task 5.3), started once at server boot from entry.server.tsx
// — same in-process model as scheduleEmbeddingBackfill. Two jobs:
//   drain     — every minute: process pending WebhookEvent rows (no retry)
//   reconcile — daily: re-list Shopify products, repair ProductSyncState drift
// Each job is single-flight (a slow run never overlaps its next tick).

const DRAIN_INTERVAL_MS = 60_000; // every minute
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

let started = false;

function singleFlight(op: string, job: () => Promise<unknown>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    void job()
      .catch((err) => reportError(op, err))
      .finally(() => {
        running = false;
      });
  };
}

export function startCronJobs(): void {
  // Never run under the test runner; start exactly once per process.
  if (started || process.env.VITEST) return;
  started = true;

  const drain = singleFlight("cron.drain", () => drainWebhookEvents());
  const reconcile = singleFlight("cron.reconcile", () => reconcileAllShops());

  setInterval(drain, DRAIN_INTERVAL_MS).unref();
  setInterval(reconcile, RECONCILE_INTERVAL_MS).unref();

  logEvent({ op: "cron.start", ok: true });
}
