# Phase 6 Spec — Native Dropdown Parity

> Follows Phase 4 (`specs/storefront-surfaces/spec.md`), which shipped the
> type-ahead as an independent Shadow-DOM dropdown. That dropdown works, but
> it does not look or behave like the theme's own predictive search. This
> phase replaces it. The search *ranking* stays exactly as Phase 3/4 built
> it — only the surface changes.
>
> Evidence for this spec was collected live from the dev store
> `<reference-store>.myshopify.com` (theme **Horizon**, theme-store id
> 2481) on 2026-08-20. Section 2 records what we found.

## 1. Goal

The shopper must not be able to tell that a third-party app serves the
results. The dropdown must use the theme's own shell, the theme's own CSS,
the theme's own keyboard behaviour, and the theme's own empty state.

Non-goal: a new visual design. We copy; we do not invent.

Non-goal: the results *page*. That stays as Phase 4 built it.

## 2. What the native dropdown actually is (measured)

### 2.1 DOM anatomy (Horizon)

```
dialog-component.search-modal
  dialog.search-modal__content.dialog-modal
    predictive-search-component.predictive-search            [role=search]
      form.predictive-search-form
        div.predictive-search-form__header                   sticky, border-bottom 1px #dfdfdf
          div.predictive-search-form__header-inner           radius 14px, 610x48
            label.visually-hidden
            input.search-input#cmdk-input                    [role=combobox] font-size 16px
            input[name="options[prefix]"][hidden]
            span.svg-wrapper.predictive-search__icon > svg   (magnifier, leading)
            button.predictive-search__reset-button           "Clear" — [hidden] while the query is empty
          button.button.predictive-search__close-modal-button  (×)
        div.predictive-search-form__content-wrapper
          div.predictive-search-form__content
            style                                            (section-scoped CSS)
            div#predictive-search-results.predictive-search-dropdown  [role=listbox]
              div.predictive-search-results__inner
                div.visually-hidden[role=status]             live region
                div#predictive-search-products.predictive-search-results__products
                  h4.predictive-search-results__title        "Products"
                  ul.predictive-search-results__list
                     .predictive-search-results__wrapper-products.list-unstyled
                    li.predictive-search-results__card
                       .predictive-search-results__card--product
                      product-component.resource-card__wrapper
                        div.resource-card
                          a.resource-card__link > span.visually-hidden (title)
                          div.resource-card__media > img.resource-card__image
                          div.resource-card__content
                            p.resource-card__title.paragraph
                            div > span.price
                p.predictive-search-results__no-results      (empty state, replaces the block above)
        div.predictive-search-form__footer
          button.button.predictive-search__search-button     "View all"
```

Grid metrics in the 670px-wide modal: `display: grid`, 4 columns of
146.7px, `gap: 14.4px`.

### 2.2 Transport — this is the key finding

Horizon does **not** fetch JSON. On each keystroke it calls the Shopify
**Section Rendering API**:

```
GET /search/suggest
      ?q=<query>
      &resources[limit_scope]=each
      &section_id=predictive-search
```

The response is HTML: one `div.shopify-section` that contains exactly one
`<style>` tag and one `#predictive-search-results` node (~26 KB for a
4-product answer). The theme swaps that node into the open modal. Nothing
else on the page changes.

Dawn and most Online Store 2.0 themes use the same pattern, with a different
`section_id`.

**Consequence:** there is one clean seam. If we control the *response* to
that request, we control the results and change nothing else. The modal,
the header, the "Clear" button, the "View all" footer, focus trapping,
keyboard navigation, ARIA, RTL, and every pixel of CSS stay native, because
they are still the theme's own code running on the theme's own markup.

### 2.3 Why the Phase 4 dropdown cannot match

Three structural reasons, all fatal for parity:

1. **Shadow DOM.** It was chosen so theme CSS could not break us. That same
   boundary blocks the theme CSS we now need.
2. **Event suppression.** Phase 4 calls `stopImmediatePropagation` on the
   theme's `input`/`focus`/key handlers. Horizon binds those handlers
   declaratively (`on:input`, `on:keydown` attributes on `#cmdk-input`), so
   suppression also kills the modal's own behaviour.
3. **Own markup.** We build cards from JSON. Every theme update moves the
   goalposts.

The Phase 4 dropdown is not deleted. It becomes the last rung of the
fallback ladder (§5).

## 3. Design

### 3.1 Decision

**Intercept the transport. Reuse the theme's markup. Write no UI.**

Ranked, in order of what runs:

| Layer | Responsibility |
|---|---|
| **L1 Interceptor** | Patch `window.fetch` and `XMLHttpRequest`. Match the theme's predictive-search request. Answer it ourselves. |
| **L2 Template harvest** | Learn the theme's result markup at runtime from one real native response. Store the card, the title, the empty-state and the container as clonable templates. |
| **L3 Renderer** | Fill harvested templates with our hits and return a synthetic `Response` with the same shape the theme expects. |
| **L4 Fallback** | If L1 or L2 fails, degrade (see §5). |

### 3.2 L1 — Interceptor

Patch once, at embed load, before the theme's modules run. `blocks/embed.liquid`
loads `ai-search.js` with no `defer` so this holds.

Match rule — a request is ours when **all** are true:
- same origin (or a relative path),
- path ends with `/search/suggest` (locale prefixes allowed:
  `/en-il/search/suggest`),
- the query string carries a `section_id` parameter.

On a match:
1. Read `q`. If `q` is empty → pass through untouched (the default state,
   §4.1, is the theme's own "recently viewed / default products" render —
   we have nothing better to offer and must not degrade it).
2. Call `GET {proxy}/suggest?q=…&limit=…` (the Phase 4 endpoint, unchanged).
3. Render HTML (§3.4) and resolve with
   `new Response(html, {status: 200, headers: {'Content-Type': 'text/html'}})`.
4. On any failure — timeout, non-200, unknown template — **pass the original
   request through to Shopify**. A native answer is always better than a
   broken one.

Hard timeout on our own call: `INTERCEPT_TIMEOUT_MS = 700`. Past that we
pass through. Phase 4 measured hybrid-live p95 at 487–512ms
(`specs/storefront-surfaces/phase4-notes.md`), so 700ms clears p95 with
headroom and still stays under the point where a shopper notices a stall.

Never patch twice: guard on `window.__aiSearchFetchPatched`.

### 3.3 L2 — Template harvest

We must never hardcode `resource-card__title`. Themes rename classes.

**Warm-up.** On the first sign that the shopper will search — the modal
opens, or the search input receives focus — we make one real, un-intercepted
request to the theme's own endpoint with the *empty* query (the same request
the theme makes to paint its default state). We parse the returned HTML and
extract:

| Slot | How we find it |
|---|---|
| `container` | the element the theme swaps — the node carrying the `section_id`'s results id (`#predictive-search-results`) |
| `card` | the first repeated list item under the products list |
| `listParent` | the card's parent (`ul`) |
| `groupTitle` | the heading sibling of `listParent` |
| `liveRegion` | the `[role=status]` node |
| `sectionStyle` | the `<style>` tag inside the section |

Inside the harvested `card` we locate the substitution points **by role, not
by class**:

| Point | Rule |
|---|---|
| link | first `a[href]` inside the card |
| image | first `img` inside the card |
| title | the deepest element whose text equals the product title in the source card |
| price | the deepest element whose text matches the shop's money pattern |
| a11y label | any `.visually-hidden` (or `[class*=visually-hidden]`) whose text equals the product title |

The result is a **theme profile** — a small JSON object of CSS paths
relative to the card. Cache it in `sessionStorage` under
`aisearch:profile:{themeId}:{sectionId}`, so the warm-up cost is paid once
per session, not once per page.

If the theme id changes, the cache key changes, so a theme update
self-invalidates.

**Escape hatch.** A merchant-editable "theme profile override" setting on
the app embed accepts a JSON profile. This is how we support a theme whose
markup defeats harvesting, with no app release.

### 3.4 L3 — Renderer

For each hit from `/apps/search/suggest`:

1. `cloneNode(true)` the harvested card.
2. Set link `href` to the product url, preserving the theme's own tracking
   parameters if the template carried any.
3. Set the image `src`. Rebuild `srcset` and `sizes` from the template's own
   width list, so responsive images keep working.
4. Set title text and the `.visually-hidden` label.
5. Set price text using `cfg.moneyFormat` (already published by the embed).
6. Drop any node inside the card that we cannot fill (for example a swatch
   list) rather than leaving stale content from the template product.

Then:
- Append cards to a cloned, emptied `listParent`.
- Set the live region text. Reuse the theme's own sentence shape by
  substituting the count and the query into the harvested string.
- If zero hits: clone the harvested empty-state node instead of the products
  block and substitute the query. If the harvest did not capture an empty
  state (the warm-up query had results), fall back to our own `<p>` using
  the products-block class prefix.
- Re-emit the harvested `<style>` tag verbatim.
- Serialize the container into the same `div.shopify-section` wrapper.

Card count: `min(cfg.maxSuggestions, columns × rows)` where `columns` is read
off the harvested list's computed `grid-template-columns`. Horizon at 670px
gives 4 — so 4 or 8, never 5, which would leave a ragged row the native
dropdown never shows.

### 3.5 What we deliberately do not touch

- The modal open/close, focus trap and `Escape`.
- The "Clear" reset button.
- The "View all" footer button and where it navigates.
- `ArrowUp` / `ArrowDown` / `Enter` / `Tab` inside the listbox.
- `aria-expanded`, `aria-activedescendant`, `aria-owns`.
- RTL. The theme already flips under `dir=rtl`; our cloned nodes inherit it.
- The debounce. The theme owns the keystroke timing; we only answer what it
  asks for. **Delete** the Phase 4 150ms debounce for this path.

This is the whole point: every row above is a bug we no longer have to fix.

## 4. States to match

### 4.1 Default (empty query) — reference image 1

Pass through to the theme. We add nothing. The theme shows "Products" and
its own default/recently-viewed set.

*Open question, deferred:* an AI "trending / recommended" default state is a
Phase 7 idea. Not in scope here.

### 4.2 No results — reference image 2

The theme's sentence, our ranking's verdict:

> No results found for "fasdfa". Try another search.

Rendered from the harvested `p.predictive-search-results__no-results`. The
`[role=status]` live region carries the same text.

### 4.3 With results — reference image 3

Grid of cards, "Products" heading above, "View all" button in the footer.
Card = image, title, price. Identical to native because it *is* the theme's
card node.

### 4.4 Loading

The theme's own behaviour: keep the previous results visible until the new
HTML lands. We add no spinner. If Phase 4's spinner exists on this path,
remove it.

### 4.5 Semantic upgrade (cold embedding cache)

Phase 4 returns `semantic: "timeout"` when the query vector was not ready in
time, then re-fetches ~600ms later. Keep this, adapted:

- The first answer is lexical-only and is rendered normally.
- If the response says `timeout` **and** the input value is unchanged, fetch
  once more after `UPGRADE_DELAY_MS` and re-render the container in place.
- Do not touch the live region on the upgrade render if the count did not
  change — a second announcement is noise for a screen-reader user.

## 5. Fallback ladder

Each rung is tried in order. Each rung is strictly better than the one
below it.

| # | Condition | Behaviour |
|---|---|---|
| 1 | Interception + harvest both work | Native shell, AI results. **Target.** |
| 2 | Interception works, harvest failed | Pass through to Shopify. Native shell, **native ranking**. Log a diagnostic; surface it in the admin (§7). |
| 3 | Theme does not use section rendering (no matching request in 5s after modal open) | Mount the Phase 4 Shadow-DOM dropdown, exactly as today. |
| 4 | App embed disabled or JS error at boot | Theme is completely untouched. |

Rung 2 is the important one. **A merchant would rather have native ranking
than a broken dropdown.** We must never fail visibly.

## 6. Files

| File | Change |
|---|---|
| `app/extensions/ai-search/assets/ai-search.js` | New `interceptor` + `harvest` + `render` modules. Existing `Dropdown` demoted to rung 3; its auto-attach becomes conditional. |
| `app/extensions/ai-search/blocks/embed.liquid` | Publish `Shopify.theme.id`, the detected `section_id`, and the new `theme_profile` override setting. Remove the blanket `display:none` on native predictive elements — we now *use* them. Keep it only for rung 3. |
| `app/extensions/ai-search/locales/*.json` | Fewer strings: the theme now owns most copy. Keep only the rung-3 set. |
| `app/extensions/ai-search/assets/ai-search.css` | Shrink to rung-3 only. |
| `app/app/services/storefront-search.server.ts` | No change to ranking. Add `image.width`/`height` and `compare_at_price` to `SurfaceHit` if absent — the theme's card templates use them. |
| `app/app/routes/proxy.search.suggest.tsx` | No contract change. |

The removal of the blanket `display:none` is a behaviour change for existing
merchants. It must ship together with the interceptor, never before.

## 7. Diagnostics

The merchant must be able to see which rung is active. Add to the app's
admin settings page a "Storefront status" row that reports the last rung
observed, plus the harvested theme profile.

The storefront writes the rung and the profile to
`sessionStorage['aisearch:diag']`, and posts it to the app once per session
(`POST {proxy}/diag`, deduplicated per shop + theme id + day). No shopper
data — theme id, section id, rung, and which harvest slots failed.

## 8. Tasks

| # | Task | Depends on |
|---|---|---|
| 6.1 | Theme-detection + fetch/XHR interceptor with pass-through on every failure path | — |
| 6.2 | Harvest module + theme profile + `sessionStorage` cache | 6.1 |
| 6.3 | Renderer: cards, empty state, live region, `srcset` rebuild, money format | 6.2 |
| 6.4 | Fallback ladder + demote the Phase 4 dropdown to rung 3 | 6.1–6.3 |
| 6.5 | Semantic-upgrade re-render on the intercepted path | 6.3 |
| 6.6 | Diagnostics endpoint + admin "Storefront status" row | 6.4 |
| 6.7 | Parity test harness (§9) | 6.3 |

## 9. Acceptance criteria

**A1 — Visual parity.** On Horizon at 1512×806 and at 390×844, screenshot the
native dropdown and the intercepted dropdown for the same query with the same
product set. Pixel diff of the modal region **≤ 0.5%** of pixels, excluding
the product images themselves.

**A2 — Behaviour parity.** Scripted keyboard run — open modal, type,
`ArrowDown` ×3, `ArrowUp`, `Enter`, `Escape`, `Tab` — produces the same
focus order and the same `aria-activedescendant` sequence on both paths.

**A3 — Ranking is ours.** For a Hebrew query in the frozen corpus where AI
ranking and native ranking are known to differ, the dropdown shows the AI
order. This is what proves the interception did something.

**A4 — Fail-safe.** With the proxy forced to 500, to a 3s hang, and to
malformed JSON, the dropdown still shows native results in every case. No
console error visible to the shopper. Three separate cases, all must pass.

**A5 — Latency.** Time from keystroke to painted results on the intercepted
path is **not worse than native + 250ms** at p95, measured on the dev store.

**A6 — No results.** The sentence, the font, and the vertical position match
reference image 2.

**A7 — Second theme.** The same build works on Dawn with no code change —
harvest only. If it needs code, the harvest rules in §3.3 are wrong and must
be fixed before ship.

**A8 — RTL.** On a Hebrew storefront, the intercepted dropdown reads
right-to-left with the same layout as the theme's own.

## 10. Risks

| Risk | Mitigation |
|---|---|
| A theme fetches predictive search through a wrapper we do not patch (a bundled `axios`, a service worker) | Detection window in rung 3: if no matching request appears within 5s of modal open, fall back. |
| Card templates carry per-product JS state (quick-add, variant pickers) that our substitution leaves stale | §3.4 rule 6 — drop nodes we cannot fill. Assert in the parity test that no cloned card retains the template product's handle. |
| Shopify changes the Section Rendering API | Rung 2 covers it: pass-through, native ranking, merchant sees a diagnostic. |
| Harvest picks the wrong node on an unusual theme | Merchant-editable profile override (§3.3) ships in the same release, so support can fix a store without a release. |
| `sessionStorage` unavailable (private mode, ITP) | Harvest per page load instead of per session. One extra request; acceptable. |

## 11. Open decisions

1. **Warm-up cost.** One extra request per session on modal open. Alternative:
   harvest lazily from the *first* real keystroke response by letting the
   first keystroke pass through. That is free, but the first query of every
   session then shows native ranking. Recommendation: **pay the warm-up
   request**; correctness of the first query matters more.
2. **AI default state** (§4.1) — deferred to Phase 7.
3. Whether rung 3 (the Phase 4 Shadow-DOM dropdown) is worth keeping at all
   once A7 passes on Dawn. Decide after 6.7.
