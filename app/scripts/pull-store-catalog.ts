// Pull products from a public Shopify storefront (/products.json) and emit a
// CSV in Shopify's product-import template format (product_template.csv), for
// seeding the dev store with a real Hebrew clothing catalog (spec §5 seeding;
// the L'Occitane Phase 0 corpus stays benchmark-only).
//
// Run from app/:  node --import tsx scripts/pull-store-catalog.ts
import { writeFileSync } from "node:fs";
import path from "node:path";

const STORE = "https://razili.co.il";
const COUNT = 200;
const OUT = path.resolve(import.meta.dirname, "../../seed-products.csv");

interface StoreProduct {
  title: string;
  handle: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string[];
  options: { name: string; values: string[] }[];
  variants: {
    title: string;
    sku?: string;
    price: string;
    compare_at_price?: string | null;
    grams?: number;
    available: boolean;
    taxable?: boolean;
    option1?: string | null;
    option2?: string | null;
    option3?: string | null;
    featured_image?: { src: string } | null;
  }[];
  images: { src: string; alt?: string | null }[];
}

// Exact header of product_template.csv (Shopify's current import format).
const HEADER = [
  "Title", "URL handle", "Description", "Vendor", "Product category", "Type",
  "Tags", "Published on online store", "Status", "SKU", "Barcode",
  "Option1 name", "Option1 value", "Option1 Linked To",
  "Option2 name", "Option2 value", "Option2 Linked To",
  "Option3 name", "Option3 value", "Option3 Linked To",
  "Price", "Compare-at price", "Cost per item", "Charge tax", "Tax code",
  "Unit price total measure", "Unit price total measure unit",
  "Unit price base measure", "Unit price base measure unit",
  "Inventory tracker", "Inventory quantity", "Continue selling when out of stock",
  "Weight value (grams)", "Weight unit for display", "Requires shipping",
  "Fulfillment service", "Product image URL", "Image position", "Image alt text",
  "Variant image URL", "Gift card", "SEO title", "SEO description",
  "Color (product.metafields.shopify.color-pattern)",
  "Google Shopping / Google product category", "Google Shopping / Gender",
  "Google Shopping / Age group", "Google Shopping / Manufacturer part number (MPN)",
  "Google Shopping / Ad group name", "Google Shopping / Ads labels",
  "Google Shopping / Condition", "Google Shopping / Custom product",
  "Google Shopping / Custom label 0", "Google Shopping / Custom label 1",
  "Google Shopping / Custom label 2", "Google Shopping / Custom label 3",
  "Google Shopping / Custom label 4",
] as const;

const esc = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const col = (name: (typeof HEADER)[number]) => HEADER.indexOf(name);

function productRows(p: StoreProduct): string[][] {
  const rows: string[][] = [];
  const optionNames = p.options.map((o) => o.name);
  const stripped = (p.body_html ?? "").replace(/<[^>]+>/g, " ").trim();

  p.variants.forEach((v, i) => {
    const row = new Array<string>(HEADER.length).fill("");
    const first = i === 0;
    row[col("URL handle")] = p.handle;
    if (first) {
      row[col("Title")] = p.title;
      row[col("Description")] = p.body_html ?? "";
      row[col("Vendor")] = p.vendor ?? "";
      row[col("Type")] = p.product_type ?? "";
      row[col("Tags")] = (p.tags ?? []).join(", ");
      row[col("Published on online store")] = "TRUE";
      row[col("Status")] = "Active";
      row[col("Gift card")] = "FALSE";
      if (p.images[0]) {
        row[col("Product image URL")] = p.images[0].src;
        row[col("Image position")] = "1";
        row[col("Image alt text")] = p.images[0].alt ?? "";
      }
    }
    ([1, 2, 3] as const).forEach((n) => {
      const name = optionNames[n - 1];
      const value = v[`option${n}`];
      if (name && value) {
        if (first) row[col(`Option${n} name`)] = name;
        row[col(`Option${n} value`)] = value;
      }
    });
    if (!optionNames.length && first) {
      row[col("Option1 name")] = "Title";
      row[col("Option1 value")] = v.title || "Default Title";
    }
    row[col("SKU")] = v.sku ?? "";
    row[col("Price")] = v.price;
    row[col("Compare-at price")] = v.compare_at_price ?? "";
    row[col("Charge tax")] = v.taxable === false ? "FALSE" : "TRUE";
    row[col("Inventory tracker")] = "shopify";
    row[col("Inventory quantity")] = v.available ? "50" : "0";
    row[col("Continue selling when out of stock")] = "DENY";
    row[col("Weight value (grams)")] = String(v.grams ?? 0);
    row[col("Weight unit for display")] = "g";
    row[col("Requires shipping")] = "TRUE";
    row[col("Fulfillment service")] = "manual";
    row[col("Variant image URL")] = v.featured_image?.src ?? "";
    rows.push(row);
  });

  // Additional images: handle + image columns only.
  p.images.slice(1).forEach((img, i) => {
    const row = new Array<string>(HEADER.length).fill("");
    row[col("URL handle")] = p.handle;
    row[col("Product image URL")] = img.src;
    row[col("Image position")] = String(i + 2);
    row[col("Image alt text")] = img.alt ?? "";
    rows.push(row);
  });

  return stripped ? rows : []; // skip products with no real description
}

async function main() {
  const res = await fetch(`${STORE}/products.json?limit=250`, {
    headers: { "User-Agent": "Mozilla/5.0 (dev-store seeding; one-off fetch)" },
  });
  if (!res.ok) throw new Error(`${STORE} responded ${res.status}`);
  const products: StoreProduct[] = (await res.json()).products;

  const lines = [HEADER.join(",")];
  let taken = 0;
  for (const p of products) {
    if (taken >= COUNT) break;
    const rows = productRows(p);
    if (!rows.length) continue;
    lines.push(...rows.map((r) => r.map(esc).join(",")));
    taken += 1;
  }
  if (taken < COUNT) throw new Error(`only ${taken} usable products (wanted ${COUNT})`);

  writeFileSync(OUT, "﻿" + lines.join("\n") + "\n");
  console.log(`Wrote ${OUT}: ${taken} products, ${lines.length - 1} rows`);
}

main();
