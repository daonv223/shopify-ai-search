import { createHash } from "node:crypto";

// Normalized product shape both ingest paths produce: the Shopify bulk
// operation / webhook re-fetch, and the local dataset loader used for testing.
export interface ProductInput {
  id: string; // numeric product id as string (no gid prefix)
  handle: string;
  title: string;
  productType: string;
  vendor: string;
  tags: string[];
  body: string; // plain text, HTML already stripped
  url?: string;
  imageUrl?: string;
  imageAlt?: string;
  categoryName?: string;
  options: { name: string; values: string[] }[];
  variants: {
    title: string;
    sku?: string;
    barcode?: string;
    price?: number;
    available?: boolean;
    selectedOptions: { name: string; value: string }[];
  }[];
  metafields: { namespace: string; key: string; value: string }[];
  updatedAt?: string;
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&quot;|&#39;|&lt;|&gt;/g, (e) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim();
}

// Benchmark parity (03_index_opensearch.py): Gemini caps input tokens;
// titles/tags carry most of the retrieval signal.
const BODY_CHARS = 1500;

// The text that becomes the product's embedding — title first, then type,
// tags, body. MUST stay identical to the Phase 0 benchmark composition; the
// content hash below is defined over it, so changing this re-embeds every
// product on the next sync.
export function composeEmbeddingInput(p: ProductInput): string {
  const parts = [
    p.title,
    p.productType,
    p.tags.join(" "),
    p.body.slice(0, BODY_CHARS),
  ];
  return parts.filter(Boolean).join("\n");
}

// Changed-text detection (spec §3.3): hash of the embedding input. Non-text
// updates (price, inventory) leave it unchanged and must not re-embed.
export function contentHash(p: ProductInput): string {
  return createHash("sha256").update(composeEmbeddingInput(p), "utf8").digest("hex");
}

const METAFIELD_VALUE_CHARS = 1000; // guard against JSON blobs bloating the doc

export function toSearchDoc(p: ProductInput): Record<string, unknown> {
  const prices = p.variants.map((v) => v.price).filter((x): x is number => x != null);
  const optionFacets = [
    ...p.options.flatMap((o) => o.values.map((v) => `${o.name}::${v}`)),
    ...p.variants.flatMap((v) => v.selectedOptions.map((o) => `${o.name}::${o.value}`)),
  ];
  return {
    product_id: p.id,
    handle: p.handle,
    url: p.url,
    image_url: p.imageUrl,
    image_alt: p.imageAlt,
    title: p.title,
    body: p.body,
    tags: p.tags,
    product_type: p.productType,
    vendor: p.vendor,
    variant_titles: p.variants.map((v) => v.title).filter((t) => t && t !== "Default Title"),
    option_values: [...new Set(p.options.flatMap((o) => o.values))],
    metafield_text: p.metafields.map((m) => m.value.slice(0, METAFIELD_VALUE_CHARS)),
    category_name: p.categoryName,
    sku: p.variants.map((v) => v.sku).filter(Boolean),
    barcode: p.variants.map((v) => v.barcode).filter(Boolean),
    option_facets: [...new Set(optionFacets)],
    price_min: prices.length ? Math.min(...prices) : undefined,
    price_max: prices.length ? Math.max(...prices) : undefined,
    available: p.variants.some((v) => v.available),
    updated_at: p.updatedAt,
  };
}
