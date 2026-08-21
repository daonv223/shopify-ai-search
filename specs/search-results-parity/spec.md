# Phase 7 Spec — Horizon-Style Search Results Page

> Phase 6 replaced the type-ahead with our own Horizon-style modal. It left
> the results page alone. This phase does the same job for the results page.
>
> The ranking from Phase 3/4 does not change. The endpoint does not change.
> The modal does not change.
>
> **Reference store:** `<reference-store>.myshopify.com`. A clean store on
> the Horizon theme, with no app installed. It is the source of truth for the
> design.
>
> **Test store:** `<dev-store>.myshopify.com`. The app is installed
> there. It is where we check the result.
>
> Phase 6 lives at `specs/native-dropdown-parity/spec.md`. This spec follows
> its shape and reuses its parts. Read it first.

## 1. Goal

The `/search` page of a store with our app looks like the Horizon search
page, on every theme.

Today the page renders a plain grid. The block sets its own font sizes, its
own square images and its own button. It reads as an app, not as the store.

After this phase the page copies Horizon: the page heading, the search field,
the result count, the product grid, the card, the zero-results state and the
pagination control.

The page takes its font, its text colour and its surface colour from the host
theme, through the same `--ais-*` probe tokens that Phase 6 built. So it
reads as native on a store that does not run Horizon.

We copy the Horizon design. We invent no new design.

## 2. Decisions taken before the capture

### 2.1 Scope — the grid and the header only

We copy the page heading, the search field, the result count, the grid, the
card, the zero-results state and the pagination control.

We do **not** copy the filter row. We do **not** copy the sort control. We do
**not** copy the two grid-density toggles.

Reason: each needs server work that this phase does not budget. A sort
control needs a `sort` parameter on `/apps/search/results` and a sort branch
in `storefront-search.server.ts`. A filter row needs OpenSearch aggregations
on both retrieval legs. Phase 4 open question 1 records the filter cost as 3
to 4 days.

Consequence: our page differs from Horizon by one control row. Acceptance
criterion C1 must judge parity with that row excluded.

Revisit both after v1 ships. Sort is the cheaper of the two, so it comes
first.

### 2.2 Delivery — the app block keeps the Shadow DOM, and we own the markup

The merchant still adds the "AI Search results" app block to the search
template. We still render inside a shadow root. We still write our own
markup.

We rejected two other paths.

| Rejected | Reason |
|---|---|
| Copy Horizon's real class names into the light DOM, so the theme's CSS paints our grid | Perfect on Horizon. Unstyled on Dawn and on every other theme. It repeats the mistake of the Phase 6 first draft. |
| Take over the whole `/search` page from JavaScript, with no app block | It removes one merchant setup step. It also makes one bug hide every result on a full page, and the merchant has no theme-editor switch to turn the block off. |

So this phase changes the CSS and the renderer. It does not change the block
contract, the endpoint or the merchant setup steps.

## 3. The capture — DONE 2026-08-21

`reference/measurements.md` holds the full detail. The four screenshots sit
beside it. That file is the source of truth. This spec quotes it.

**Two limits on the capture. Read them before you trust a number.**

1. **The mobile capture is 500 px wide, not 390 px.** Chrome would not make
   the window narrower. 500 px is below the theme's 750 px breakpoint, so the
   mobile layout is the right one. The exact gutter at 390 px is not
   measured.
2. **The pagination control was not captured.** The reference store holds 13
   products, so every query fits one page. §3.2 C records the decision we took
   without it.

### 3.1 Five things the pre-capture draft got wrong

| Draft assumed | Truth |
|---|---|
| The card media is a fixed ratio, as in the modal | Horizon uses the image's own ratio. 9 of 11 cards were 1:1, 2 were 0.79:1. |
| The heading is fixed | It is `Search results` with a query, and `Search` without one. It never prints the query. |
| The zero-results state shows a sentence and nothing else | It also shows a `Products` heading and a fallback grid of the store's products. |
| The card values carry over from the modal | The price is 12 px here and 14 px in the modal. The field radius is 4 px here and 14 px in the modal. The title does not underline on hover here. It does in the modal. |
| The grid fades in, as the modal does | `animation` is `none` on the grid and on every card. There is nothing to copy. |

### 3.2 Three decisions the capture forced

**A. The card media ratio — fixed 1:1.**

Horizon writes `aspect-ratio` per card, from the image's own size. We cannot.
`SurfaceHit` carries `image_url` and `image_alt` and no dimensions, and the
OpenSearch mapping indexes neither. To match Horizon we would have to add the
size to the ingest query, to `product-doc.server.ts`, to the mapping, to the
source field list in `search.server.ts` and to `SurfaceHit`, then re-index
every shop.

So v1 fixes the media at **1:1**, with `object-fit: cover`. That is what 9 of
the 11 reference cards showed. A store whose images are all square looks
identical. A store with portrait images gets an even grid where Horizon gets
a ragged one.

Record it as a limit, not a bug. Revisit with the image dimensions if a pilot
merchant asks.

**B. The zero-results fallback grid — out.**

Horizon prints the sentence, then a `Products` heading, then a grid of the
store's products. So a Horizon shopper never reaches a dead end.

Our endpoint returns no such list. A fallback would need a second data
source: a featured collection, or an unfiltered query. Neither is in this
phase.

So v1 prints the sentence alone. §6.1 says what the sentence is. Note the gap
in the spec, and revisit it with the sort work.

**C. The pagination control — a "Load more" button.**

The reference store runs `infinite-scroll="true"`, which is a merchant
setting, not the theme default. The control that replaces it was never on
screen, so we have nothing to copy.

We ship a **"Load more" button**, centred below the grid, styled as the
theme's `.button-secondary` (§5.6). Three reasons: it maps straight onto the
`has_more` field the endpoint already returns; it is reachable by keyboard,
which an infinite scroll is not; and it does not push the theme's footer out
of reach.

Infinite scroll is a follow-up, not a v1 item. Our block sits above the
theme's footer, so an infinite scroll there is a bigger change than it looks.

## 4. Theme adaptation

Phase 6 §3 already built this. This phase reuses it and adds nothing.

`applyTokens(container)` runs on the block container, in the `ResultsBlock`
constructor. It writes the same `--ais-*` tokens that the modal uses.
So the probe, the fallbacks and the token list carry over unchanged.

| Token | Use on the results page |
|---|---|
| `--ais-bg` | The field background |
| `--ais-fg` | The text |
| `--ais-border` | The field border |
| `--ais-radius` | The "Load more" button |
| `--ais-tint` | The image placeholder and the badge |
| `--ais-accent` | Not used. See §5.6. |

Layout values are ours and are fixed. They come from `reference/measurements.md`
and do not change per theme.

### 4.1 One breakpoint, and it is a container query

Horizon switches at **750 px**, with a viewport media query. That is the same
breakpoint the modal uses.

We keep the 750 px number and change the mechanism. Use a **container
query**, not a viewport query. The app block sits inside a theme layout panel
of unknown width. `results.liquid` already ships a `flex: 1 1 100%` rule to
stop the panel collapsing, which proves the point. A viewport query would
give the wrong column count inside a narrow panel.

## 5. The page we build

Every number below comes from `reference/measurements.md`. The section number
in brackets points at it.

```
.ai-results
  h1.ai-heading            the page heading      [§3]
  form.ai-form             the search field      [§4]
  p.ai-count               the count, role=status[§5]
  p.ai-empty               zero results only     [§7]
  div.ai-grid              the product grid      [§6.1]
    a.ai-card × n                                [§6.2]
  button.ai-more           "Load more"           [§3.2 C]
```

### 5.1 The page shell

| Property | Desktop, from 750 px | Below 750 px |
|---|---|---|
| Content width | the container width, no cap | the container width |
| Inline gutter | 40 px | 16 px |
| Block padding above the heading | 40 px | 28 px |

The grid ignores the gutter below 750 px. It is full bleed. See §5.4.

### 5.2 The heading

An `h1`, not Horizon's `h3` — our block is the page's main content, so the
heading level must be right. Take the type from Horizon.

| Property | Desktop | Below 750 px |
|---|---|---|
| Font size | 48 px | 36 px |
| Line height | 48 px | 36 px |
| Weight | 700 | 700 |
| Margin | 0 | 0 |

**The text depends on the query, and it never prints the query.**

| State | Heading |
|---|---|
| A query is present | `Search results` |
| No query | `Search` |

That kills the `data-heading` block setting and the `resultsFor` subheading
we render today. §8 records both.

### 5.3 The search field

| Property | Desktop | Below 750 px |
|---|---|---|
| Width | 50 % of the content width | 100 % |
| Height | 56 px | 60 px |
| Font size | 14 px | 16 px |
| Padding inline | 54 px | 44.8 px |
| Padding block | 16 px | 16 px |
| Border | 1 px solid `--ais-border` | same |
| Radius | **4 px** | same |
| Background | `--ais-bg` | same |

**The radius is 4 px, not the modal's 14 px.** Do not reuse the modal value.

| Part | Value |
|---|---|
| Magnifier | 24×24, absolute, `inset-inline-start: 16px` |
| Reset control | 24×24, absolute, at the inline end. Show it only when the field holds a value. |

The block reserves about 37 px below the field.

Keep the 16 px font below 750 px. A smaller font makes iOS Safari zoom the
page on focus.

### 5.4 The grid

| Property | Desktop, from 750 px | Below 750 px |
|---|---|---|
| Columns | `repeat(auto-fill, minmax(250px, 1fr))` | `1fr 1fr` |
| Row gap | 24 px | 12 px |
| Column gap | 16 px | 12 px |
| Inline position | inside the gutter | full bleed, outside the gutter |

The desktop rule is the value the reference store resolved. It is a merchant
setting in Horizon. We fix it.

The grid is a `ul`. Each card is an `li`. Do not set `align-items`, so every
card in a row stretches to the tallest.

### 5.5 The card

The card is shared with the modal. §5.7 covers the sharing. The values below
are the results-page values, and four of them differ from the modal.

| Property | Desktop | Below 750 px |
|---|---|---|
| Content | flex column, `gap: 4px`, padding 0 | `padding-inline: 8px` |
| Media | **fixed 1:1**, `object-fit: cover`, radius 0 | same |
| Title | 14 px, weight 400, line height 22.4 px, no clamp | same |
| Price | **12 px**, weight 500, line height 14.4 px | same |
| Hover | **nothing changes.** No underline. | — |

The badge:

| Property | Value |
|---|---|
| Position | absolute, `inset-block-start: 8px`, `inset-inline-end: 8px` |
| Size | font 13 px, weight 400, line height 20.8 px |
| Padding | `4px 10px` |
| Radius | 100 px |
| Background | `--ais-tint`, with **no** backdrop blur |

The modal badge blurs. This one does not.

**No entrance animation.** Horizon has none here. Do not carry the modal's
fade and stagger across.

### 5.6 The count and the "Load more" button

The count is a `<p role="status">`. Its text is the Horizon sentence:
`{{ count }} items`. Font 14 px, weight 400, colour `--ais-fg` at 0.8 alpha.
It sits at the inline **end** on desktop, as Horizon puts it.

Hide the count below 750 px. Horizon hides its whole row there.

The "Load more" button copies the theme's `.button-secondary`:

| Property | Value |
|---|---|
| Font | 14 px, weight 400, line height 22.4 px |
| Padding | `16px 24px` |
| Radius | 14 px, or `--ais-radius` |
| Background | transparent |
| Colour | `--ais-fg` |
| Border | 1 px solid `--ais-border` |

It is centred below the grid. Horizon's own secondary button has no border.
We add one, because a borderless transparent button on an unknown theme can
vanish.

### 5.7 The card is shared with the modal

`ai-search.js` had two card builders: `modalCard()` built the Horizon-shaped
card, and `card()` built the Phase 4 square card. The results block called
`card()`.

**Delete `card()`. Share one builder.** It is now
`productCard(hit, width, option)`. The markup is the same on both surfaces, so
a second builder is a second thing to keep in step. `option` is the only
behavioural difference: the modal card is a listbox option, the page card is a
plain link.

The CSS must follow. `.ai-modal .ai-card` scoped every card rule to the modal.
Split the rules three ways.

| Rules | New scope |
|---|---|
| The structure: the flex column, the media box, the content gap, the badge position | plain `.ai-card` |
| The modal values: 4:5 media, 14 px price, hover underline, the active-option outline, the badge blur | `.ai-modal .ai-card` |
| The page values: 1:1 media, 12 px price, no hover change | `.ai-results .ai-card` |

The builder takes an image width. Keep the parameter. The page card is larger
than the modal card, so it asks for a larger image: 500, against the modal's
400.

### 5.8 What the count sentence may claim

`results()` returns `total` as an **upper bound**, not an exact number. The
service comment at `storefront-search.server.ts:90` says so: it counts the
fused candidates plus the lexical tail beyond fusion depth, and the two sets
may overlap. `total` is exact only once `has_more` is false.

So `12 items` can be a little high on page one of a large result set.

Three ways out.

| Option | Cost | Result |
|---|---|---|
| A. Print `total` and accept the drift | none | The count can be high on page one. It becomes exact on the last page. |
| B. Print a hedged sentence | one locale string | Honest. It does not match Horizon's wording. |
| C. Make `total` exact | server work: a count query on the lexical leg | Exact, and one more OpenSearch round trip per page. |

**Decided: option A.** The drift is small and it never reads lower than the
truth. Record the limit here so nobody reports it as a bug.

## 6. States

| State | Behaviour |
|---|---|
| No query | The heading reads `Search`. The field is empty, with no reset control. No count. No grid. No button. |
| Loading, page 1 | The heading and the field only. Do not paint an empty grid. |
| Loading, page 2 and later | Keep the cards on screen. Disable the button. |
| Results | The heading, the field, the count, the grid, and the button when `has_more` is true |
| Zero results | §6.1 |
| Error or timeout | §6.2. This is **not** the zero-results state. |

### 6.1 Zero results

Copy Horizon, minus the fallback grid (§3.2 B).

- The heading stays at `Search results`.
- The field keeps the query and keeps the reset control.
- One `<p>`, 14 px, weight 400, `text-align: start`, `margin: 0`.
- The text: `No results found for “{{ query }}”. Check the spelling or use a
  different word or phrase.`
- No count. No grid. No button.

Note the quote marks. Horizon uses straight ones. **We must use typographic
ones**, because Liquid's `t` filter escapes a straight `"` and it prints as
`&quot;`. Phase 6 §8 records the same trap.

### 6.2 The error state stays as it is

Phase 6 §7.2 dropped the separate error state in the modal. The results page
keeps its own, and the two rules differ on purpose.

The modal always has a way out: its footer pill points at the theme's search
URL. The results page **is** the destination. A shopper who reaches a page
that says "no results" for a real query has nowhere else to go.

So `ResultsBlock.prototype.fail` stays as written. It
removes our hide-the-native-section style tag. It brings the theme's own
results back. It prints a link to `/search?q=…&ai=0`.

Restyle it to match the page. Do not change what it does.

### 6.3 The live region

The count element carries `role=status`, as Horizon's does. Horizon announces
the count alone — `11 items` — not the query. Copy that.

Announce once per query, not once per page. A "Load more" click must not
re-announce the total. It has not changed.

### 6.4 The search field must not open the modal

**The capture answered this.** Horizon's results-page field is a plain inline
form. It submits to `/search`. It does not open the search modal.

Two changes follow, and the second is the one that bites.

1. Drop the `attachDropdown(input)` call in the field builder. Phase 6 turned
   that function into a modal binder.
2. **Flag our own block host, or the modal opens anyway.** The Phase 6
   takeover binds a capture-phase `focusin` on `document` and opens the modal
   for any element that matches a search trigger. `focusin` composes, so
   `composedPath()` reaches our field inside the shadow root. The `isOurs()`
   guard skips a path that carries `__aiSearchModal`, and the modal host sets
   that flag. **The results block host did not.** Set it, or every click on
   our own field opens the modal over the page.

## 7. RTL and custom CSS

Both carry over from Phase 6 with no change.

Write the CSS with logical properties only: `margin-inline`, `padding-inline`,
`inset-inline-start`. Never hardcode a direction.

`pageDir(container)` resolves the direction. The `direction` app-embed setting
drives it. See §9.2 — the block used to defeat that setting.

The `custom_css` setting must reach this shadow root too. Check it. The
merchant has no other way to restyle a shadow tree.

Check the result on the Hebrew storefront.

## 8. Files

| File | Change |
|---|---|
| `app/extensions/ai-search/assets/ai-search.css` | The main work. Rewrite section 9, `.ai-results` and below, from §5. Split the card rules three ways per §5.7. Add the 750 px container query. Delete the `max-width: 480px` media query, which the container query replaces. |
| `app/extensions/ai-search/assets/ai-search.js` | Delete `card()`. Point `ResultsBlock` at `modalCard()`. Rebuild `ResultsBlock.prototype.render` to §5. Make the heading depend on the query per §5.2. Drop the `resultsFor` subheading. Resolve §6.4, both parts. |
| `app/extensions/ai-search/blocks/results.liquid` | Remove the `heading` setting — §5.2 makes it dead. Keep `page_size`, `show_search_form`, `show_count` and `hide_native_selector`. Keep the block contract otherwise. |
| `app/extensions/ai-search/locales/*.json` | Add the Horizon strings: the two headings, the count sentence, the zero-results sentence, the reset label. English and Hebrew. **No straight `"` or `'`** — Liquid escapes them and they print as `&quot;`. Use `“ ”` and `„ ”`. Drop `results_for`. |
| `app/app/routes/proxy.search_.results.tsx` | No change. |
| `app/app/services/storefront-search.server.ts` | No change. §3.2 A and §5.8 both need none. |
| `app/extensions/ai-search/locales/*.schema.json` | Drop the `results.heading` labels with the setting. |
| `app/tests/storefront/ai-search-client.test.ts` | Update every assertion that names `card()`, the `heading` setting, the `resultsFor` subheading or the Phase 4 grid classes. |

The vintage-theme proxy page at `proxy.search.tsx` renders its own light-DOM
markup, through `results-page.server.ts` and `enhanceProxyPage`. **It is out
of scope.** It serves a theme generation that cannot run Horizon anyway.
Leave it as it is.

## 9. Tasks

| # | Task | Depends on |
|---|---|---|
| 7.1 | ~~Capture the reference results page.~~ **DONE 2026-08-21.** See `reference/measurements.md` and the four screenshots beside it. §5 is rewritten from it. §3.1 lists what the draft got wrong. §3.2 records the three decisions it forced. | — |
| 7.2 | ~~CSS: split the card rules three ways per §5.7.~~ **DONE 2026-08-21.** Verified in a browser: the modal still measures 672 px wide, 4-column 14.4 px grid, 4:5 media, 2 px content gap, 2-line clamp at 18.2 px, 14 px price, badge at the inline start with a 40 px radius and a blur. C10 holds. | 7.1 |
| 7.3 | ~~CSS: the page shell, the heading, the field, the count and the grid container query.~~ **DONE 2026-08-21.** Measured against Horizon at both breakpoints — see §9.1. | 7.1 |
| 7.4 | ~~JS: delete `card()`, share one builder, rebuild `render()`.~~ **DONE 2026-08-21.** `card()` is gone. `modalCard()` is now `productCard(hit, width, option)`; `option` is the only behavioural difference between the two surfaces. | 7.2 |
| 7.5 | ~~The "Load more" button.~~ **DONE 2026-08-21.** | 7.3, 7.4 |
| 7.6 | ~~The states of §6.~~ **DONE 2026-08-21.** The count is the live region and announces once. The zero-results sentence and the loading line share one slot. The error line is a separate `role=alert`, so a failure is still announced once the count stops carrying it. | 7.4 |
| 7.7 | ~~§6.4 — drop `attachDropdown`, and set `__aiSearchModal` on the block host.~~ **DONE 2026-08-21.** Both parts, with a test for each. | 7.4 |
| 7.8 | ~~Locale strings, English and Hebrew.~~ **DONE 2026-08-21.** Added `search_results`, `search_heading`, `items_count`, `page_no_results`. Dropped `results_for`, `results_count`, `search_button` and the `heading` block setting. | 7.6 |
| 7.9 | ~~RTL check and `custom_css` check.~~ **DONE 2026-08-21.** See §9.2 — it found and fixed a real defect. | 7.5, 7.6, 7.7 |
| 7.10 | ~~Update `ai-search-client.test.ts`.~~ **DONE 2026-08-21.** 62 pass. | 7.4, 7.5, 7.6, 7.7 |

### 9.1 How the build was checked

`shopify app dev` needs a store password, so the live-store run is still open
(C1, C2, C6 on a real theme). Everything else was checked in Chrome against a
local harness: the real `ai-search.css` and `ai-search.js`, a stubbed config
and a stubbed `fetch`.

Every desktop value matched the reference exactly: heading 48/48/700, field
716×56 at 50 %, input padding-inline 54 px with a 4 px radius, magnifier at
16 px, grid 5×273.6 with a 24/16 gap, media 1:1 at 274, badge at the inline
end with a 100 px radius and no blur, price 12/14.4/500.

Every narrow value matched too: top padding 28 px, heading 36/36, gutter
16 px, field full width, input 16 px, count hidden, grid 244+244 with a 12 px
gap and full bleed, card content 8 px inline padding.

**The container query was proved, not assumed.** The panel was set to 500 px
while the viewport stayed at 1512 px. The layout switched. A viewport media
query would not have.

### 9.2 What the RTL check found

`results.liquid` hardcoded `dir="rtl"` on the block container. `pageDir()`
resolves `direction: auto` from the nearest `[dir]` ancestor, and `closest()`
matches the element itself. So the block was **always** right to left, and the
Phase 6 `direction` setting could never reach it. An English store would have
rendered backwards.

The attribute is gone. `pageDir()` now resolves from the page, as it does for
the modal. Verified: with `dir=rtl` on an ancestor the field sits at the right
edge, the magnifier and the reset control swap, the badge moves to the card's
inline end, and the count aligns to the end.

`custom_css` needed no work. `shadow()` already appends the merchant's style
tag to every shadow root it builds, and the results block calls it.

## 10. Acceptance criteria

**Status 2026-08-21.** C3, C4, C5, C7, C8 and C10 pass against the local
harness — see §9.1 and §9.2. C1, C2, C6 and C9 need a live store, and
`shopify app dev` needs a store password. They are the only ones left.

**C1 — Design parity on Horizon.** On the test store, our results page and
the reference store results page look the same for the same query, at
1512×862 and below 750 px. Judge by eye against `reference/`. No pixel gate.

Exclude four things from the judgement, because §2.1 and §3.2 leave them out:
the filter row, the sort control, the grid-density toggles, and the
zero-results fallback grid. Expect an even 1:1 grid where the reference store
shows two taller cards (§3.2 A).

**C2 — Native on a second theme.** Install on a Dawn store. The page uses
Dawn's font and Dawn's colours. The grid and the card match §5. Nothing is
unreadable, and no colour clashes.

**C3 — The card is one design.** The modal card and the page card come from
`modalCard()`. The three CSS scopes of §5.7 hold: the shared rules move both
surfaces, the modal rules move only the modal, the page rules move only the
page.

**C4 — Pagination.** Page two loads. The cards from page one stay on screen.
The button disappears when `has_more` is false. The live region does not
re-announce the total. The button is reachable by `Tab`.

**C5 — Heading, count and zero results.** A query with hits shows `Search
results` and `{{ n }} items`. A query with no hits shows `Search results` and
the §6.1 sentence, with no grid and no button. An empty `q` shows `Search`,
the field, and nothing else. No straight quote prints as `&quot;`.

**C6 — The field does not open the modal.** Click our results-page field on
Horizon and on Dawn. The modal must not open. The form submits to `/search`.

**C7 — Fail-safe.** Force the proxy to a 500, to a 3-second hang, and to a
malformed response. In all three cases the theme's own results section comes
back, and the page prints the link to `/search?q=…&ai=0`. The page is never
blank.

**C8 — RTL.** On the Hebrew storefront the page reads right to left. The
heading, the field, the count, the card badge and the button sit at the right
inline edge.

**C9 — The ranking is ours.** For a Hebrew query where AI ranking and native
ranking differ, the page shows the AI order. This is Phase 4 test B6, re-run.

**C10 — The modal is unchanged.** Run the Phase 6 A1 check again after 7.2.
The card CSS split must not move a pixel in the modal.

## 11. Risks

| Risk | Mitigation |
|---|---|
| 7.2 splits the card CSS and breaks the modal | C10 is the guard. Run the Phase 6 A1 check after 7.2, before anything else. |
| The `focusin` takeover opens the modal over our own results page | §6.4 part 2. C6 is the guard. It is easy to miss, because dropping `attachDropdown` alone does not fix it. |
| The app block sits in a narrow theme panel, so the grid gets the wrong column count | §4.1. Use a container query, never a viewport query. |
| A portrait-image store looks even where Horizon looks ragged | §3.2 A. Accepted, and recorded as a limit. |
| A zero-results page is a dead end, where Horizon offers a fallback grid | §3.2 B. Accepted for v1. The error path still links to native search. |
| `total` is an upper bound, so the count reads high on page one | §5.8 option A. Recorded, not fixed. |
| Our "Load more" button is not what Horizon shows | §3.2 C. The reference store ran infinite scroll, so there was nothing to copy. The choice is ours and the reasons are written down. |
| A merchant never adds the app block, so the page stays native | Unchanged from Phase 4. The Phase 5.1 admin covers the setup steps. |
| The Horizon design changes | Re-capture the reference. It is a design source, not a runtime input, so nothing breaks in production. |

## 12. Out of scope

| Left out | Where it goes |
|---|---|
| The filter row | Phase 4 open question 1. Confirm with the first pilot merchant. |
| The sort control | The cheaper of the two. Take it first, after v1 ships. |
| The grid-density toggles | A theme convenience. It needs no server work, so it is cheap to add later. |
| The zero-results fallback grid | §3.2 B. It needs a second data source. |
| Infinite scroll | §3.2 C. It is a bigger change than it looks, because our block sits above the theme's footer. |
| Per-image aspect ratios | §3.2 A. It needs image dimensions in the index and a re-index. |
| The vintage-theme proxy page | It cannot run Horizon. §8 leaves it as it is. |
| Collection and article results | Products only, as in Phase 4. |
| Search analytics on the page | Phase 5. |
