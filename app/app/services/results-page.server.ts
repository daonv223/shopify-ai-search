// Vintage-theme fallback page (Phase 4 spec §3.1/§3.3): the app proxy answers
// `/apps/search?q=` with `application/liquid`, which Shopify renders inside
// the theme layout. Server-renders the results grid for the requested page
// and hands off to the theme-extension JS (task 4.3) via data-* hooks; the
// prev/next links work with no JS at all. Prices go through Liquid's `money`
// filter so the merchant's currency format applies.
//
// Everything interpolated is HTML-escaped AND Liquid-neutralized: a product
// title containing `{{` or `{%` must not become a Liquid tag when Shopify
// renders the body. Escaping every `{` and `}` to numeric entities does both.
import type { ResultsResponse, SurfaceHit } from "./storefront-search.server";

export const PROXY_PATH = "/apps/search";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

const pageHref = (q: string, page: number) =>
  `${PROXY_PATH}?q=${encodeURIComponent(q)}&page=${page}`;

const money = (amount: number | undefined) =>
  amount === undefined || amount === null ? "" : `{{ ${Math.round(amount * 100)} | money }}`;

function price(hit: SurfaceHit): string {
  if (hit.price_min === undefined) return "";
  const range =
    hit.price_max !== undefined && hit.price_max > hit.price_min
      ? `${money(hit.price_min)} – ${money(hit.price_max)}`
      : money(hit.price_min);
  return `<span class="ai-search-price">${range}</span>`;
}

function card(hit: SurfaceHit): string {
  const img = hit.image_url
    ? `<img class="ai-search-image" src="${esc(hit.image_url)}" alt="${esc(hit.image_alt ?? hit.title)}" loading="lazy">`
    : `<span class="ai-search-image ai-search-image--empty" aria-hidden="true"></span>`;
  const badge =
    hit.available === false ? `<span class="ai-search-badge">אזל מהמלאי</span>` : "";
  return `<li class="ai-search-item">
  <a class="ai-search-link" href="${esc(hit.url ?? `/products/${hit.handle}`)}">
    ${img}${badge}
    <span class="ai-search-title">${esc(hit.title)}</span>
    ${price(hit)}
  </a>
</li>`;
}

// Minimal, theme-agnostic styling with logical properties only; the
// extension's stylesheet (task 4.3) supersedes it when loaded.
const STYLE = `<style>
.ai-search-page{direction:rtl;text-align:start;margin-block:1.5rem;padding-inline:1rem;max-width:1200px;margin-inline:auto}
.ai-search-page h1{font-size:1.5rem;margin-block-end:.25rem}
.ai-search-count{opacity:.7;margin-block-end:1rem}
.ai-search-grid{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem}
.ai-search-link{display:block;color:inherit;text-decoration:none;position:relative}
.ai-search-image{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;background:rgba(0,0,0,.05)}
.ai-search-badge{position:absolute;inset-block-start:.5rem;inset-inline-start:.5rem;background:#333;color:#fff;font-size:.75rem;padding:.15rem .5rem}
.ai-search-title{display:block;margin-block-start:.5rem}
.ai-search-price{display:block;opacity:.8}
.ai-search-pager{display:flex;gap:1rem;justify-content:center;margin-block:2rem}
.ai-search-empty,.ai-search-error{margin-block:2rem}
</style>`;

export function renderResultsPage(out: ResultsResponse): string {
  const q = out.query;
  const head = `<h1>תוצאות חיפוש עבור &ldquo;${esc(q)}&rdquo;</h1>`;
  if (!q) {
    return `${STYLE}<div class="ai-search-page" data-ai-search-page data-endpoint="${PROXY_PATH}/results" data-query="" dir="rtl">
<h1>חיפוש</h1>
<form action="${PROXY_PATH}" method="get" class="ai-search-form" role="search">
  <input type="search" name="q" placeholder="חיפוש" autofocus>
</form>
</div>`;
  }
  if (out.hits.length === 0) {
    return `${STYLE}<div class="ai-search-page" data-ai-search-page data-endpoint="${PROXY_PATH}/results" data-query="${esc(q)}" dir="rtl">
${head}
<p class="ai-search-empty">לא נמצאו מוצרים התואמים את החיפוש. נסו מילה אחרת, או <a href="/search?q=${encodeURIComponent(q)}">חפשו בחיפוש הרגיל</a>.</p>
</div>`;
  }
  const pager = [
    out.page > 1 ? `<a class="ai-search-prev" href="${pageHref(q, out.page - 1)}">&rsaquo; הקודם</a>` : "",
    out.has_more ? `<a class="ai-search-next" data-ai-search-more href="${pageHref(q, out.page + 1)}">הבא &lsaquo;</a>` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${STYLE}<div class="ai-search-page" data-ai-search-page data-endpoint="${PROXY_PATH}/results" data-query="${esc(q)}" data-page="${out.page}" data-limit="${out.limit}" data-has-more="${out.has_more}" dir="rtl">
${head}
<p class="ai-search-count">${out.total} מוצרים</p>
<ul class="ai-search-grid" data-ai-search-grid>
${out.hits.map(card).join("\n")}
</ul>
${pager ? `<nav class="ai-search-pager" aria-label="עמודים">${pager}</nav>` : ""}
</div>`;
}

// Never a blank page: on any failure, apologise and hand the shopper to
// native search.
export function renderErrorPage(q: string): string {
  return `${STYLE}<div class="ai-search-page" dir="rtl">
<h1>תוצאות חיפוש</h1>
<p class="ai-search-error">החיפוש אינו זמין כרגע. <a href="/search?q=${encodeURIComponent(q)}">נסו את החיפוש הרגיל</a>.</p>
</div>`;
}
