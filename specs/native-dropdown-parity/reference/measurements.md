# Horizon Search Modal — Measured Reference

Source: `<reference-store>.myshopify.com`, Horizon theme, draft, no app
installed. Captured 2026-08-21 at a viewport of 1512×862. Root font size
16 px.

Screenshots in this folder:

| File | State |
|---|---|
| `01-default-empty-1512.jpg` | Modal open, empty query |
| `02-results-1512.jpg` | Query `snow`, 8 cards |
| `03-no-results-1512.jpg` | Query `fasdfa` |
| `04-results-hover-1512.jpg` | Query `snowboard`, one card hovered |

## 1. Shell

The modal is a native `<dialog>`, opened with `showModal()`.

| Property | Value |
|---|---|
| Element | `dialog.search-modal__content.dialog-modal` |
| Width | `672px` (`--normal-content-width: 42rem`) |
| Max height | `calc(100% - 34px)` |
| Measured size | 672 × 615 |
| Background | `rgb(255,255,255)` |
| Border | `1px solid rgb(223,223,223)` |
| Radius | `14px` (`--style-border-radius-popover`) |
| Shadow | `rgba(0,0,0,0.15) 0 4px 20px` |
| Overflow | `hidden` |
| Top margin | `calc(50dvh - var(--modal-max-height)/2 - 2rem)` |

**Backdrop.** `dialog::backdrop`, `background: transparent`,
`backdrop-filter: brightness(0.75)`. It animates from `brightness(1)`.

**Mobile.** At `max-width: 749px` the modal is full screen:

```css
.dialog-modal { max-width:100%; max-height:100%; height:100dvh; width:100dvw; padding: var(--padding-md); }
```

So there is no radius and no centering on a phone. The v1 spec guessed this
wrong.

## 2. Header

| Part | Value |
|---|---|
| `.predictive-search-form__header` | 670 × 53, `padding: 4px 4px 0`, `border-bottom: 1px solid rgb(223,223,223)`, `position: sticky` |
| `.predictive-search-form__header-inner` | 610 × 48, `border-radius: 14px`, no border, no background |
| Magnifier `.predictive-search__icon` | 24 × 24, `position: absolute`, `inset-inline-start: 12.8px`, `color: rgba(0,0,0,0.6)` |
| `input.search-input` | 561 × 48, `font-size: 16px`, `line-height: 25.6px`, `padding: 11.2px 0 11.2px 40px`, transparent background, no border |
| Clear button | 44 × 44, text `Clear`, `font-size: 14px`, unstyled. Text on mobile, icon on desktop, swapped by a media query. |
| Close button | 41 × 44, `×` icon, `margin-inline-start: 11.2px`, `border-radius: 14px`, transparent |

Copy: placeholder `Search`, label `Search`, clear `Clear`, close
`Close dialog`.

## 3. Content

`.predictive-search-form__content-wrapper` — `max-height: 560.3px`,
`overflow-y: hidden`, `position: relative`.

`.predictive-search-form__content` — **this is the scroller**.
`overflow-y: auto`, `max-height: 560.3px`, `padding-block-end: 64px`. The
padding leaves room for the floating footer button.

`.predictive-search-results__inner` — `padding-block: 1rem`,
`container-type: inline-size`. The grid below uses a **container query**, not
a viewport query.

## 4. DOM shape

```
dialog.search-modal__content.dialog-modal
  h2.visually-hidden#search-modal-heading
  predictive-search-component.predictive-search        [role=search]
    form.predictive-search-form                        [role=search]
      div.predictive-search-form__header               sticky
        div.predictive-search-form__header-inner
          label.visually-hidden
          input.search-input#cmdk-input                [role=combobox][type=search][name=q]
          input[type=hidden][name="options[prefix]"]
          span.svg-wrapper.predictive-search__icon > svg
          button.predictive-search__reset-button       "Clear"
        button.predictive-search__close-modal-button   "×"
      div.predictive-search-form__content-wrapper
        div.predictive-search-form__content            scroller
          style                                        section CSS, ~20 KB
          div#predictive-search-results
             .predictive-search-dropdown               [role=listbox]
            div.predictive-search-results__inner
              div.visually-hidden                      [role=status]
              ul.predictive-search-results__wrapper-queries   suggestion pills
                li.predictive-search-results__card--query
                  a.pills__pill.predictive-search-results__pill
              div#predictive-search-products
                h4.predictive-search-results__title    "Products"
                ul.predictive-search-results__wrapper-products
                  li.predictive-search-results__card--product
              p.predictive-search-results__no-results  empty state
      div.predictive-search-form__footer
        button.predictive-search__search-button        "View all"
```

Card:

```
li.predictive-search-results__card--product
  product-component.resource-card__wrapper
    div.resource-card
      a.resource-card__link > span.visually-hidden     absolute, inset:0, z-index:1
      div.resource-card__media > img.resource-card__image
      div.resource-card__content
        p.resource-card__title.paragraph
        div > span.price
```

The link is an absolute overlay across the whole card. The title stays a
`<p>`.

## 5. Suggestion pills — the v1 spec missed these

Above the products, Horizon shows a row of query suggestions. For `snow` it
showed `snowboard`, `stock snowboard`, `price snowboard`.

| Part | Value |
|---|---|
| List | `display: flex`, `gap: 4.8px`, `padding: 1px 20px 11.2px`, `margin-block-end: 16px` |
| Pill `a.pills__pill` | 98 × 34, `border-radius: 40px`, `background: rgba(0,0,0,0.05)`, `padding: 6px 12px`, `font-size: 14px` |

The matched substring is bold inside the pill.

## 6. Products grid

| Part | Value |
|---|---|
| `#predictive-search-products` | `padding-inline: 20px` |
| Grid | `grid-template-columns: repeat(2, 1fr)` |
| Grid, wide | `@container (min-width: 550px) { repeat(4, 1fr) }` |
| Gap | `0.9rem` = `14.4px` |
| Measured column | 146.7 px at a 630 px list width |
| Card count | 8, even when the status line said 10 results |

Because the breakpoint is a **container** query, the grid follows the panel
width, not the viewport. Our panel can copy this and behave right at any
width.

## 7. Card

| Part | Value |
|---|---|
| Card | 147 × 252, no background, no border |
| Media | 146.7 × 183.4. Ratio **0.8 = 4:5**, not square. The v1 spec said square. |
| Image | `object-fit: cover`, fills the media box |
| Content | `display: flex`, column, `gap: 2px` |
| Title | `p`, `font-size: 14px`, `line-height: 18.2px`, `font-weight: 400`, `-webkit-line-clamp: 2`, `overflow: hidden` |
| Price | `span`, `font-size: 14px`, `line-height: 22.4px`, `font-weight: 500` |
| Heading | `h4`, `font-size: 14px`, `font-weight: 500`, `line-height: 14px`, `margin: 0 0 8px` |

## 8. No results

| Part | Value |
|---|---|
| Element | `p.predictive-search-results__no-results` |
| Text | `No results found for "fasdfa". Try another search.` |
| Style | `font-size: 14px`, `line-height: 22.4px`, `text-align: center`, `margin-block: 16px` |
| Modal height | shrinks to 141 px |
| Footer | `display: none` — **the "View all" button disappears** |
| Live region | `No results found for "fasdfa"` — no "Try another search." |

## 9. Footer

| Part | Value |
|---|---|
| `.predictive-search-form__footer` | `position: absolute`, at the modal bottom, 670 × 78, `padding: 8px 0 16px`, transparent |
| Button | 99 × 54, `background: rgb(0,0,0)`, `color: white`, `border-radius: 14px`, `padding: 16px 24px`, `font-size: 14px` |

It is a centered floating pill over the scrolled content, not a full-width
bar. The v1 spec said full-width. Wrong.

## 10. Live region

`div.visually-hidden[role=status]` sits first inside
`.predictive-search-results__inner`.

- With results: `10 search results found for "snowboard"`
- With none: `No results found for "fasdfa"`

The count is the true total, not the number of cards shown.

## 11. Animation

Cards enter with `search-element-slide-up`, at
`--animation-speed-medium` with a bounce timing function. The lists are
staggered: queries at 50 ms, then 150 ms, then 200 ms. Each
`.resource-card` also runs a `fadeIn` from `opacity: 0`.

## 12. Keyboard and ARIA — Horizon is weak here

Measured, with 8 results on screen:

| Attribute | Value |
|---|---|
| `aria-expanded` on the input | `false`, even with results |
| `aria-activedescendant` | never set |
| `aria-autocomplete` | `list` |
| `aria-owns` / `aria-controls` | `predictive-search-results` |
| Card `role` | none. The cards are not options. |
| `ArrowDown` | does nothing. Focus stays in the input. |

The card links are in the tab order, so a keyboard user can reach them with
`Tab`. There is no arrow-key navigation.

**Do not copy this.** Phase 4 already has arrow keys, `role=option` and
`aria-activedescendant`. Keep them. They are strictly better, and a mouse
user cannot see the difference.
