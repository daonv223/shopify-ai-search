import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { startCatalogIngest } from "../services/ingest.server";
import { scheduleEmbeddingBackfill } from "../services/embedding-backfill.server";
import { getSyncStatus } from "../services/sync-status.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const status = await getSyncStatus(session.shop);
  return { status };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "reembed") {
    const shop = await db.shop.findUnique({ where: { id: session.shop } });
    if (!shop) return { ok: false, message: "Shop not found" };
    scheduleEmbeddingBackfill(session.shop, shop.indexAlias);
    return { ok: true, message: "Re-embedding stale products" };
  }

  // Default / "resync": returns null when a sync is already running.
  const runId = await startCatalogIngest(admin.graphql, session.shop);
  return {
    ok: true,
    message: runId !== null ? "Catalog sync started" : "A catalog sync is already running",
  };
};

const STATUS_TONE: Record<string, string> = {
  running: "info",
  success: "success",
  failed: "critical",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function Index() {
  const { status } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const run = status.run;
  const isRunning = run?.status === "running";
  const busy = ["loading", "submitting"].includes(fetcher.state);

  // Poll while a sync is in flight so the progress advances without a reload.
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => revalidator.revalidate(), 2500);
    return () => clearInterval(id);
  }, [isRunning, revalidator]);

  useEffect(() => {
    if (fetcher.data?.message) shopify.toast.show(fetcher.data.message);
  }, [fetcher.data, shopify]);

  const resync = () => fetcher.submit({ intent: "resync" }, { method: "POST" });
  const reembed = () => fetcher.submit({ intent: "reembed" }, { method: "POST" });

  const tone = run ? (STATUS_TONE[run.status] ?? "neutral") : "neutral";
  const indexed = status.indexedCount;
  const total = run?.productCount ?? indexed;

  return (
    <s-page heading="AI Search">
      <s-button
        slot="primary-action"
        onClick={resync}
        {...(busy || isRunning ? { loading: true } : {})}
      >
        {run ? "Re-sync catalog" : "Sync all catalog"}
      </s-button>

      <s-section heading="Sync status">
        {!run ? (
          <s-stack gap="base">
            <s-paragraph>
              No catalog sync has run yet. Press &ldquo;Sync all catalog&rdquo; to index
              every published product. The sync runs in the background as a Shopify bulk
              operation; the app indexes the result when it finishes.
            </s-paragraph>
          </s-stack>
        ) : (
          <s-stack gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={tone as never}>{run.status}</s-badge>
              {isRunning ? <s-spinner size="base" accessibilityLabel="Sync running" /> : null}
            </s-stack>

            <s-table>
              <s-table-body>
                <s-table-row>
                  <s-table-cell>Products indexed</s-table-cell>
                  <s-table-cell>
                    {indexed}
                    {total ? ` / ${total}` : ""}
                  </s-table-cell>
                </s-table-row>
                <s-table-row>
                  <s-table-cell>Awaiting embedding</s-table-cell>
                  <s-table-cell>{status.staleCount}</s-table-cell>
                </s-table-row>
                <s-table-row>
                  <s-table-cell>Started</s-table-cell>
                  <s-table-cell>{formatTime(run.startedAt)}</s-table-cell>
                </s-table-row>
                <s-table-row>
                  <s-table-cell>Finished</s-table-cell>
                  <s-table-cell>{formatTime(run.finishedAt)}</s-table-cell>
                </s-table-row>
              </s-table-body>
            </s-table>

            {run.status === "failed" && run.error ? (
              <s-banner tone="critical" heading="Last sync failed">
                <s-paragraph>{run.error.message}</s-paragraph>
              </s-banner>
            ) : null}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Actions">
        <s-stack gap="base">
          <s-button
            onClick={reembed}
            disabled={status.staleCount === 0 || busy}
            {...(busy ? { loading: true } : {})}
          >
            Re-embed stale ({status.staleCount})
          </s-button>
          <s-paragraph>
            Re-embedding regenerates vectors for products whose text changed since their
            last sync. It runs in the background using your configured embedding provider.
          </s-paragraph>
          <s-link href="/app/settings">Search settings</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
