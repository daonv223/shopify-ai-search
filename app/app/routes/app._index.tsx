import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { startCatalogIngest } from "../services/ingest.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // Returns null when a sync is already running (one bulk op per shop).
  const runId = await startCatalogIngest(admin.graphql, session.shop);
  return { started: runId !== null };
};

export default function Index() {
  const fetcher = useFetcher<typeof action>();

  const shopify = useAppBridge();
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data == null) return;
    shopify.toast.show(
      fetcher.data.started
        ? "Catalog sync started"
        : "A catalog sync is already running",
    );
  }, [fetcher.data, shopify]);

  const syncCatalog = () => fetcher.submit({}, { method: "POST" });

  return (
    <s-page heading="AI Search">
      <s-button
        slot="primary-action"
        onClick={syncCatalog}
        {...(isLoading ? { loading: true } : {})}
      >
        Sync All Catalog
      </s-button>

      <s-section heading="Catalog sync">
        <s-paragraph>
          Press &ldquo;Sync All Catalog&rdquo; to run a full ingest of every
          active product into the search index. The sync
          runs in the background — Shopify processes the catalog as a bulk
          operation and the app indexes the result when it finishes.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
