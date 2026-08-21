# Horizon Search Results Page — Measured Reference

Source: `<reference-store>.myshopify.com`, Horizon theme, draft, no app
installed. Captured 2026-08-21. Root font size 16 px. Theme font
`Inter, sans-serif`. Page direction `ltr`.

Screenshots in this folder:

| File | State |
|---|---|
| `01-results-1512.jpg` | `/search?q=snow`, 11 results, viewport 1512×862 |
| `02-results-500.jpg` | The same query, viewport 500×844 |
| `03-no-results-1512.jpg` | `/search?q=fasdfa`, 0 results |
| `04-grid-end-1512.jpg` | The end of the grid, scrolled |

**Two capture limits. Read them before you trust a number.**

1. **The mobile capture is 500 px wide, not 390 px.** Chrome would not make
   the window narrower. 500 px is below the theme's 750 px breakpoint, so the
   mobile layout is the right one. The gutter and the column widths at 390 px
   are not measured.
2. **The pagination control was not captured.** The reference store holds 13
   products, so every query fits one page. §8 records what we do know.

## 1. Page structure

Two Shopify sections, not one.

```
main#MainContent
  section 1 — the search header
    div.section.section--page-width           grid: 40px 1432px 40px
      div.search-page__header                 padding: 40px 0 0
        div.text-block.h2 > h3                the page heading
        form.search-page-input__parent
          search-page-input-component         the field, icon and reset
        p (zero results only)                 .search-results__no-results
  section 2 — the results list
    results-list.section.product-grid-container
      div.collection-wrapper.grid
        div.facets-block-wrapper--horizontal  filters, count, sort, view
        ul.product-grid > li.product-grid__item
```

`results-list` carries `infinite-scroll="true"` on this store.

## 2. Page width

| Viewport | Grid columns of the section | Content width | Gutter |
|---|---|---|---|
| 1512 | `40px 1432px 40px` | 1432 | 40 |
| 500 | `16px 468px 16px` | 468 | 16 |

The content sits in the middle track. It has no `max-width` and no
`margin-inline` of its own.

**The product grid ignores the gutter on mobile.** At 500 px it is 500 wide
at x=0, full bleed. At 1512 px it is 1432 wide at x=40, in the gutter.

## 3. The page heading

| Property | 1512 | 500 |
|---|---|---|
| Tag | `h3` inside `div.text-block.h2` | same |
| Font size | 48 px | 36 px |
| Line height | 48 px | 36 px |
| Weight | 700 | 700 |
| Colour | `rgb(0,0,0)` | same |
| Margin | 0 | 0 |
| Block padding above | 40 px, on `.search-page__header` | 28 px |

**The text changes with the query.**

| URL | Heading |
|---|---|
| `/search?q=snow` | `Search results` |
| `/search?q=fasdfa` | `Search results` |
| `/search` | `Search` |

The heading never prints the query. The `<title>` tag does:
`Search: 11 results found for "snow" – <reference-store>`.

## 4. The search field

`search-page-input-component`, `position: relative`, `display: flex`.

| Property | 1512 | 500 |
|---|---|---|
| Component width | 716 (`max-width: 50%`) | 468 (`max-width: 100%`) |
| Height | 56.4 | 59.6 |
| Font size | 14 px | 16 px |
| Line height | 22.4 px | 22.4 px |
| Padding inline | 54 px | 44.8 px |
| Padding block | 16 px | 16 px |
| Border | `1px solid rgb(223,223,223)` | same |
| Radius | **4 px** | same |
| Background | `rgb(255,255,255)` | same |
| Text colour | `rgb(51,51,51)` | same |

**The radius is 4 px here, not the 14 px the modal uses.** The theme's
`--style-border-radius-popover` is 14 px and applies to the modal only.

| Part | Value |
|---|---|
| Magnifier `.search__icon` | 24×24, `position: absolute`, `inset-inline-start: 16px`, colour `rgb(0,0,0)` |
| Reset `.search__reset-button` | 24×24, `position: absolute`, at the inline end. An `<a>`, not a button. |

The reset control shows only when the field holds a value.

The field block, `.search-page-input__parent`, is 93 tall at 1512. So it
reserves about 37 px below the field.

## 5. The filter, count and sort row

`.facets-block-wrapper--horizontal`, `margin-block-end: 8px`, no border.
Inside it `.facets--horizontal` is `display: flex; align-items: center;
padding: 8px 0`, 60 tall.

The form inside is 44 tall and lays out as a flex row, `gap: 20px`.

| Part | Position | Value |
|---|---|---|
| `.facets__filters-wrapper` | inline start | 157×44 at 1512. Holds `Availability` and `Price`, each a dropdown with a chevron. |
| `.products-count-wrapper` | pushed to the inline end | 51×44, font 14 px, weight 400, colour `rgba(0,0,0,0.8)`. Text `11 items`. |
| `.sorting-filter__horizontal` | after the count | Label `Sort` plus a chevron |
| View toggles | last | Two icon buttons. They switch the grid density. |

**The whole row is `display: none` below 750 px.** Mobile shows a different
control instead: an icon plus the label `Filter` at the inline start, and the
two view toggles at the inline end. See `02-results-500.jpg`.

**The count element is the live region.** It is a `<span role="status">` and
its text is `11 items`. Horizon does not say the query here.

**The whole row disappears on zero results.** See §7.

## 6. The grid and the card

### 6.1 The grid

The CSS rule, read from the theme stylesheet:

```css
.product-grid { grid-template-columns: 1fr 1fr; }
@media screen and (min-width: 750px) {
  .product-grid { grid-template-columns: var(--product-grid-columns-desktop); }
}
@media screen and (max-width: 749px) {
  [product-grid-view="mobile-single"], .product-grid-mobile--large { grid-template-columns: 1fr; }
}
```

On this store `--product-grid-columns-desktop` resolves to
`repeat(auto-fill, minmax(250px, 1fr))`. It is a merchant setting.

| Viewport | Columns | Column width | Gap |
|---|---|---|---|
| 1512 | 5 | 273.6 | `24px 16px` (row, column) |
| 500 | 2 | 244 | `12px` |

The breakpoint is **750 px**. That is the same breakpoint the modal uses.

The grid is a `ul`. Each card is an `li.product-grid__item`. There is no
`align-items`, so every card in a row stretches to the tallest.

### 6.2 The card

```
li.product-grid__item
  product-card.product-card
    a.product-card__link              an absolute overlay across the card
    div.product-card__content         flex column, gap 4px
      div.card-gallery
        div.product-media-container   the media box
          img.product-media__image
        div.product-badges--top-right
      a.contents > div.text-block > p the title
      product-price > div > span.price
```

| Property | 1512 | 500 |
|---|---|---|
| `.product-card__content` | flex column, `gap: 4px`, `padding: 0` | `padding: 0 8px` |
| Media box | 274×274 | 244×244 |
| Media radius | 0 | 0 |
| `object-fit` | `cover` | `cover` |
| Title | `<p>`, 14 px, weight 400, line height 22.4 px, colour black, no clamp | same |
| Price | `<span class="price">`, 12 px, weight 500, line height 14.4 px | same |

**The media ratio is not fixed. Horizon uses the image's own ratio.**
`aspect-ratio` is written per card. Across the 11 cards:

| Cards | `aspect-ratio` | Media box |
|---|---|---|
| 9 of 11 | `1 / 1` | 274×274 |
| 2 of 11 | `0.7925 / 1` | 274×346 |

So a portrait image makes a taller card, and the row stretches. This is the
theme's "adapt to image" media setting. A square-image store looks like a
fixed 1:1 grid.

### 6.3 The sold-out badge

| Property | Value |
|---|---|
| Wrapper | `.product-badges--top-right`, `position: absolute`, `inset-block-start: 8px`, `inset-inline-end: 8px` |
| Badge | 71×29, font 13 px, weight 400, line height 20.8 px |
| Padding | `4px 10px` |
| Radius | **100 px** |
| Background | `rgb(238,241,234)` — a theme colour setting, not a fixed value |
| Colour | `rgb(0,0,0)` |
| Text | `Sold out` |

A `Sale` badge uses the same shape with another colour.

### 6.4 Hover

The only hover rules that touch the card:

```css
.product-card:hover { z-index: var(--layer-raised); }
product-card:is(:hover, :focus-within) .quick-add__button { opacity: 1; }
```

So hover reveals the quick-add button and nothing else. **The title does not
underline.** The modal card does underline — see the Phase 6 reference §7.

The card carries `transition: opacity 0.125s ease-in-out, transform 0.125s
ease-in-out`.

### 6.5 No entrance animation

`animation` is `none` on the grid and on every card. Horizon does not fade or
stagger the results page. The modal does. There is nothing to copy here.

## 7. The zero-results state

`/search?q=fasdfa`. See `03-no-results-1512.jpg`.

What stays:

- The heading, still `Search results`.
- The field, with `fasdfa` still in it, and the reset control.

What appears:

- One `<p>` inside `p.search-results__no-results`, 545×22, font 14 px, weight
  400, colour black, `margin: 0`, `text-align: start`.
- The text: `No results found for "fasdfa". Check the spelling or use a
  different word or phrase.`

What disappears:

- The whole filter, count and sort row.

**What Horizon adds — a fallback grid.** Below the sentence it prints
`h4.main-collection-grid__title` with the text `Products`, then a grid of the
store's products. Measured: font 24 px, weight 700, line height 24 px,
`margin: 0 0 31.92px`.

So a Horizon shopper never sees an empty page. Our endpoint returns no such
list, so this is a decision for the spec, not a measurement.

## 8. The empty-query state

`/search`, no `q`.

| Part | Value |
|---|---|
| Heading | `Search`, not `Search results` |
| Field | Empty. No reset control. |
| Message | None |
| Filter row | Absent |
| Grid | The `Products` heading and the fallback grid, as in §7 |

## 9. Pagination — not captured

`results-list` carries `infinite-scroll="true"`. The store holds 13 products
and the largest query returns 11, so no second page exists to trigger it.

Facts we do have:

- Horizon exposes infinite scroll as a section setting, so a merchant can
  turn it off. The control that replaces it was not seen.
- The DOM held no `.pagination` element, no `[class*=load-more]` element and
  no `<a rel="next">` on any page we opened.
- `04-grid-end-1512.jpg` shows the grid running straight into the footer,
  with no control between them.

If the build needs the exact control, re-capture on a store with more than
one page of products.

## 10. Button styles, for a control we build ourselves

Measured from `.button-secondary` on the same page.

| Property | Value |
|---|---|
| Size | 147×54 |
| Font | 14 px, weight 400, line height 22.4 px |
| Padding | `16px 24px` |
| Radius | 14 px |
| Background | transparent |
| Colour | `rgb(0,0,0)` |
| Border | none |

`--style-border-radius-popover` is 14 px.

## 11. Summary of the differences from the modal

The modal reference is `specs/native-dropdown-parity/reference/measurements.md`.
Do not assume a value carries across.

| Part | Modal | Results page |
|---|---|---|
| Card media ratio | fixed 4:5 | the image's own ratio, mostly 1:1 |
| Title on hover | underline | no change |
| Price weight and size | 14 px / 500 | 12 px / 500 |
| Badge background | `--ais-tint` with a blur | a theme colour setting, no blur |
| Field radius | 14 px | 4 px |
| Grid | container query at 550 px, 2 then 4 columns | media query at 750 px, 2 then `auto-fill minmax(250px, 1fr)` |
| Entrance animation | fade and stagger | none |
| Live region | the query and the total | the count alone, `11 items` |
