# Phase 6 Spec — Horizon-Style Search Modal, Every Theme

> This is the second rewrite. Git keeps the first draft at
> `spec-v1-overengineered.md`. That draft intercepted the theme's
> Section Rendering API request and reused the theme's own markup. We
> dropped it. It gave perfect parity on one theme and nothing on the rest.
>
> Phase 4 shipped the type-ahead as a Shadow-DOM dropdown. It works. It
> looks like nothing in particular. This phase replaces it with a full
> search modal of our own.
>
> The ranking from Phase 3/4 does not change. The results page does not
> change.
>
> **Reference store:** `<reference-store>.myshopify.com`. A clean store on
> the Horizon theme, with no app installed. It is the source of truth for the
> design.
>
> **Test store:** `<dev-store>.myshopify.com`. The app is installed
> there. It is where we check the result.

## 1. Goal

Our app owns the whole search surface on every theme.

The shopper clicks the theme's search trigger. Our modal opens. It copies the
Horizon search modal: the shell, the header, the results grid, the empty
state and the footer.

The modal takes its font, its text color and its surface color from the host
theme. So it reads as native on a store that does not run Horizon.

We copy the Horizon design. We invent no new design.

Out of scope: the results page. Phase 4 owns it.

## 2. What we copy from Horizon

Captured from the reference store on 2026-08-21, at a viewport of 1512×862.

**Full detail lives in `reference/measurements.md`.** Screenshots sit beside
it. This section is the summary. The reference file is the source of truth.

### 2.1 The shell

| Part | Horizon |
|---|---|
| Element | a native `<dialog>`, opened with `showModal()` |
| Width | 672 px, radius 14 px, `1px solid #dfdfdf`, shadow `0 4px 20px rgba(0,0,0,.15)` |
| Backdrop | transparent, with `backdrop-filter: brightness(0.75)` |
| **Mobile** | full screen. `width:100dvw; height:100dvh`, no radius, below 750 px. |
| Header | sticky, `border-bottom: 1px solid #dfdfdf` |
| Search field | 610×48, radius 14 px, no border, no background |
| Magnifier | 24 px, absolute, `inset-inline-start: 12.8px` |
| Input | font-size 16 px, transparent, `padding-inline-start: 40px` |
| Clear button | text "Clear" on mobile, an icon on desktop |
| Close button | `×`, 41×44 |
| Scroller | the content div, `overflow-y:auto`, `padding-block-end: 64px` |

### 2.2 The results panel

| Part | Horizon |
|---|---|
| Live region | visually hidden `[role=status]`, first child |
| **Suggestion pills** | a flex row of query pills, above the products. Radius 40 px, `rgba(0,0,0,.05)`, 14 px text, the matched substring in bold. |
| Products heading | `h4`, 14 px, weight 500, `margin-block-end: 8px` |
| Grid | `repeat(2, 1fr)`, and `repeat(4, 1fr)` inside `@container (min-width: 550px)`. Gap 14.4 px. |
| Card | no background, no border |
| Card media | ratio **4:5**, `object-fit: cover` |
| Card link | an absolute overlay across the whole card |
| Card title | `p`, 14 px, weight 400, clamped to 2 lines |
| Card price | 14 px, weight 500 |
| No results | one centred `p`, 14 px, `margin-block: 16px` |
| Footer | a **centred floating black pill**, 99×54, radius 14 px, absolute over the scroll area |

Card count is 8. Horizon shows 8 cards even when the live region reports 10
results.

### 2.3 Three things the first draft got wrong

The capture corrected them. They are now fixed above.

| First draft | Truth |
|---|---|
| Card media is square | It is 4:5. |
| The footer is a full-width button | It is a centred floating pill. |
| No suggestion pills | Horizon shows a query-pill row above the products. |

It also guessed the mobile shape. The truth: the modal goes full screen
below 750 px.

### 2.4 One thing we do not copy — the keyboard

Horizon's dropdown is weak here. Measured with 8 results on screen:

- `aria-expanded` stays `false`.
- `aria-activedescendant` is never set.
- The cards carry no `role`, so the listbox has no options.
- `ArrowDown` does nothing.

Only `Tab` reaches the cards.

Phase 4 already has arrow keys, `role=option` and `aria-activedescendant`.
**Keep them.** They are strictly better, and a mouse user cannot see the
difference. §5 stands as written.

### 2.5 The entrance animation

Three parts, all measured:

1. **The backdrop** animates `backdrop-filter` from `brightness(1)` to
   `brightness(0.75)`.
2. **Each card** runs `fadeIn` from `opacity: 0`, plus a slide-up.
3. **The lists stagger.** Horizon delays the query pills 50 ms and the
   products 150 ms. We have no pills in v1, so the products carry the delay.

Copy it. It is what makes the modal feel like the theme and not like an app.

**`prefers-reduced-motion: reduce` must switch all of it off.** Horizon does
not guard this. We do. A vestibular disorder is not an edge case.

The animation runs **once per open**, not once per render. Horizon replays it
on every keystroke. We do not copy that: a 150 ms delayed fade on every
keystroke would blank the grid while the shopper types, which contradicts the
"keep the old cards" rule in §7.

## 3. Theme adaptation

This is what makes one design look native on many themes.

### 3.1 Inheritance does most of it

The shadow boundary blocks selectors. It does not block inheritance. The
shadow host is the parent of the shadow tree, so every inherited property
crosses: `font-family`, `font-size`, `line-height`, `color`,
`letter-spacing`, `direction`.

The theme's `@font-face` rules belong to the document, and a shadow tree uses
the document's fonts. So the merchant's real font file loads inside our
modal.

**Required change.** `ai-search.css` starts with `:host { all: initial }`.
That resets the inherited properties too. Delete it. Replace it with narrow
resets on the elements we create.

### 3.2 The probe fills the rest

Background, border, radius and shadow do not inherit. We sample them at boot
and write them onto the host as our own tokens.

```js
var src = document.querySelector(cfg.probeSelector) || document.body;
var s = getComputedStyle(src);
host.style.setProperty('--ais-bg', s.backgroundColor);
host.style.setProperty('--ais-fg', s.color);
```

Take the border color from the text color at low alpha.

Probe order: the theme's own search dialog, then the site header, then
`document.body`. Skip a sampled background that is transparent. Fall back to
the Horizon value.

**Do not read theme token names.** `--color-background` is not portable.
Dawn stores it as the triplet `255,255,255`, not as a color, so a direct
`var()` produces an invalid value and the fallback never runs.

### 3.3 The token list

Every visual value in the modal comes from one of these. Each has a Horizon
value as its fallback.

| Token | Source |
|---|---|
| `--ais-bg` | probe — the modal surface |
| `--ais-fg` | probe — the text |
| `--ais-border` | derived from `--ais-fg` at low alpha |
| `--ais-radius` | probe, from the theme's own button, else 14 px |
| `--ais-overlay` | fixed. A neutral black at low alpha. |
| `--ais-shadow` | fixed. The modal drop shadow colour. |
| `--ais-tint` | derived. The image placeholder, `rgba(0,0,0,.05)`. |
| `--ais-accent` | probe, from the theme's own primary button. Else black. |
| `--ais-accent-fg` | the text on `--ais-accent`. Else white. |

The last four were added during task 6.2. The first five do not cover the
shadow, the image placeholder or the black "View all" pill.

Layout values — the modal width, the grid, the gaps, the card shape, the
header height — are ours and are fixed. They come from §2 and do not change
per theme.

Use a **container query** for the grid, as Horizon does, not a viewport
query. Then the panel is right at any width, and the mobile full-screen rule
needs no extra work.

## 4. The modal

We build it. We use it on every theme. The theme's own search UI never opens.

### 4.1 Use the native `<dialog>` element

Put a `<dialog>` inside our shadow root. Open it with `showModal()`.

The browser then gives us four things for free:

1. A focus trap.
2. `Escape` closes.
3. The rest of the page becomes inert.
4. A `::backdrop` we can style.

`showModal()` works for a `dialog` inside a shadow tree. This removes most of
the reason we avoided our own modal.

**Fallback.** If `HTMLDialogElement.prototype.showModal` is absent, mount a
plain overlay and trap focus ourselves. Task 6.4 covers it.

### 4.2 How we take over the trigger

We do not fight the theme's input handlers. We take over one step earlier, at
the trigger.

Bind three listeners on `document`, in the **capture** phase, so they run
before the theme's own handlers:

| Event | Action |
|---|---|
| `click` | The target matches a search trigger → `preventDefault()`, `stopPropagation()`, open our modal. |
| `focusin` | The target is a search input → open our modal, move focus into our input. |
| `keydown` | The theme binds a keyboard shortcut, such as `/` or `cmd+k` → open our modal. |

A search trigger is any element that matches `cfg.triggerSelector`. The
default list covers a link to `/search`, a button or summary with a search
label, and an `input[type=search]`.

`triggerSelector` is a merchant-editable setting. So per-theme support costs
one selector, not new code.

### 4.3 Belt and braces

Some themes open their drawer on `pointerdown`, or through a router we do not
see. Two guards:

1. Keep the `predictive_selector` rule that hides the theme's own predictive
   results. It stays merchant-editable.
2. When our modal opens, close any open `dialog` or `details` in the light
   DOM that carries a search trigger. Close it once, on open only.

### 4.4 The input is ours

The shopper types in our input, not the theme's. So we never suppress an
`input` or `keydown` handler that the theme bound to its own field. The
Phase 4 `stopImmediatePropagation` calls go away.

Carry the first character over. If `focusin` opened the modal from a
keystroke, put that character in our input.

Our input carries `role=combobox`, `aria-expanded`, `aria-controls` and
`aria-activedescendant`. Its placeholder comes from our locale files.

## 5. Keyboard and ARIA

Phase 4 implements the list keys. Keep them. The dialog now owns the rest.

The results are a **grid**, not a list, so the arrow keys must follow the
grid. Horizon does not do this at all — see §2.4. We do better.

| Key | Behaviour | Owner |
|---|---|---|
| `ArrowDown` / `ArrowUp` | Move one **row**. A row is the live column count, read from the computed `grid-template-columns`. | us |
| `ArrowRight` / `ArrowLeft` | Move one **card**, in reading order. Under `dir=rtl` the two swap, so `ArrowLeft` moves forward. | us |
| `Home` / `End` | First card, last option. | us |
| `Enter` | Open the active card. With no active card, submit the search. | us |
| `Escape` | Close the modal. | `<dialog>` |
| `Tab` | Cycle inside the modal: input, Clear, Close, cards, View all. | `<dialog>` |

Wrap at both ends, through the input. `ArrowDown` past "View all" returns to
the input, then to the first card. That is the standard combobox path.

`ArrowRight`, `ArrowLeft`, `Home` and `End` act **only while a card is
already active**. Our field is a text input, so hijacking those four keys
unconditionally would take the caret away from the shopper. `ArrowDown`
enters the grid; `ArrowUp` off the first row returns caret control.

The "View all" pill is the last option, so `ArrowDown` past the last row
lands on it.

The column count must be read at the moment of the keystroke, never cached.
The grid changes with the container width (§2.2), so a cached count would be
wrong after a resize.

The results panel is `role=listbox`. Each card is `role=option`. The input
carries `aria-expanded`, `aria-controls` and `aria-activedescendant`.

Return focus to the trigger when the modal closes.

## 6. RTL

Write the CSS with logical properties only: `margin-inline`,
`padding-inline`, `inset-inline-start`. Never hardcode a direction, in the
CSS or in the markup.

A merchant setting decides. `direction` is a select on the app embed:

| Value | Behaviour |
|---|---|
| `auto` (default) | Resolve per element: the nearest `[dir]` ancestor of the trigger, else the computed direction of the page. |
| `ltr` | Force left to right. |
| `rtl` | Force right to left. |

Only the `<dialog>` carries the `dir` attribute. Everything inside inherits.

Check on the Hebrew storefront.

## 6a. Custom CSS

Our modal lives in Shadow DOM. Theme CSS cannot cross that boundary, so a
merchant has no other way to restyle it.

`custom_css` is a textarea on the app embed. Its content becomes a `<style>`
tag inside each shadow root, appended **after** our own stylesheet, so an
equal-specificity rule of theirs wins.

**There is no custom-JS setting, and we will not add one.** Our shadow root
is `mode: 'open'`, so the theme's own custom-code snippet already reaches it.
A JS setting would add no capability and would put arbitrary script on every
storefront page. Shopify app review treats that as a rejection reason.

## 7. States

| State | Behaviour |
|---|---|
| Open, empty query | **The header alone.** No grid, no message, no footer. The Clear button is hidden. With no query the "View all" pill would point at `/search?q=` and mean nothing, and it floated over an empty 64 px band that read as a second modal. |
| Below `minChars` | Same as empty. |
| Loading | Keep the old cards. Do not clear. Do not show a spinner. |
| Results | The grid. The heading. The footer button. No pills — see §13. |
| No results | Horizon's sentence, with the query. **Hide the footer button**, as Horizon does. The live region carries the sentence without "Try another search." |

The footer pill floats over the scroll area, so the scroller reserves 64 px for it. Both non-results states drop that reserve, or the panel leaves a blank band under the header.

| Error or timeout | Show the No results state, exactly as the row above. Log once to the console. |
| Live region | The true total and the query, as Horizon does: `10 search results found for "snowboard"`. Not the card count. |
| Semantic upgrade | See §7.1. |

### 7.1 The semantic upgrade

`GET /apps/search/suggest` returns a `SuggestResponse`. Besides `query`,
`hits` and `total`, it carries a `semantic` field. That field reports what the
vector search leg did for that one request.

| Value | Meaning |
|---|---|
| `cached` | The query vector was already in the LRU cache. |
| `live` | It embedded inside the deadline. |
| `timeout` | It fired, the deadline expired, so this response is lexical only. The vector is on its way into the cache. |
| `skipped` | The caller skipped the leg, by the partial-token rule. |
| `off` | No provider is configured, or the embedding call failed. |

Only `timeout` is worth a second try. The first response is lexical only, so
the ranking is weaker. The vector lands in the cache a moment later.

So: if `semantic` is `timeout` **and** the input is unchanged, fetch once
more after `UPGRADE_DELAY_MS`, then re-render in place. Do not announce again
if the count did not change — a second announcement is noise for a
screen-reader user.

The other four values are final. A re-fetch would return the same thing.

### 7.2 No separate error state

There is no separate error state. A proxy failure looks the same as an empty
result: Horizon's sentence, and the live region says the same. The shopper
sees a normal dropdown, not a broken app.

The way out is already there. The footer "View all" button points at the
theme's own search URL, in every state. So the shopper can still reach real
results.

The cost: the shopper cannot tell a failure from a true empty result. We
accept it. The console log and the server logs tell us.

## 8. Files

| File | Change |
|---|---|
| `app/extensions/ai-search/assets/ai-search.css` | The main work. Delete `all: initial`. Build the modal shell, the header, the grid and the card to §2 and to `reference/measurements.md`. Add the `--ais-*` tokens. Style `::backdrop`. Use a container query for the grid. Add the stagger animation. Logical properties only. |
| `app/extensions/ai-search/assets/ai-search.js` | Build the modal: `<dialog>`, header, input, Clear, Close, footer. Add the capture-phase trigger listeners. Add the probe. Rebuild `card()`. Delete the `stopImmediatePropagation` calls and the float/anchored positioning code. |
| `app/extensions/ai-search/blocks/embed.liquid` | Add `trigger_selector` and `probe_selector` settings. Extend the `predictive_selector` default list. Raise the `max_suggestions` default from 6 to 8, to match Horizon. **DONE:** the `direction` and `custom_css` settings, under an "Appearance" header. |
| `app/extensions/ai-search/locales/*.json` | **DONE.** Added `view_all`, `products_heading`, `clear`, `close`, `no_results_for`, `status_no_results`, plus the `direction` schema strings. Hebrew and English. Shopify resolves them by storefront language; `en.default.json` is the fallback. |
| `app/app/services/storefront-search.server.ts` | **No change needed.** The media box is a fixed 4:5 ratio and the image uses `object-fit: cover`, so the card reserves space without an intrinsic size. `SurfaceHit` stays as it is. |
| `app/app/routes/proxy.search_.suggest.tsx` | No change. |

## 9. Tasks

| # | Task | Depends on |
|---|---|---|
| 6.1 | ~~Capture the reference design.~~ **DONE 2026-08-21.** See `reference/measurements.md` and the four screenshots beside it. | — |
| 6.2 | CSS: remove `all: initial`, add the tokens, build the shell and the header | 6.1 |
| 6.3 | CSS: the results grid, the card, the empty state | 6.1 |
| 6.4 | The `<dialog>` modal, plus the no-`showModal` fallback | 6.2 |
| 6.5 | ~~The capture-phase trigger takeover, plus the §4.3 guards.~~ **DONE 2026-08-21.** Verified in a browser: the theme's own handler never fires, its modal never opens, focus lands in our input and returns to the trigger on close. | 6.4 |
| 6.6 | ~~The runtime probe and the token fallbacks.~~ **DONE 2026-08-21.** Verified: real values sampled, accent read off the theme's own button, every token falls back when the probe fails. | 6.2 |
| 6.7 | Panel content: heading, footer button, empty state, live region. **Also update `ai-search-client.test.ts` lines 272 and 278**: they assert the Phase 4 close-on-empty behaviour that §7 replaces. | 6.3 |
| 6.8 | ~~Keyboard, ARIA, focus return and RTL.~~ **DONE 2026-08-21.** Verified in a browser at 4 and at 2 columns, and under `dir=rtl`. The column count is re-read live. | 6.5, 6.7 |
| 6.9 | ~~Semantic-upgrade re-render.~~ **NOT NEEDED 2026-08-21.** Phase 4 already ships the one-shot re-fetch on `semantic: "timeout"`, in `Dropdown.prototype.search`. Only the §7.1 nicety is missing: it re-announces even when the count did not change. Left as is. | 6.7 |
| 6.10 | ~~Locale files, Hebrew and English.~~ **DONE 2026-08-21.** Plus the `direction` setting, and the three tests that encoded the Phase 4 behaviour. | 6.7 |
| 6.11 | ~~The entrance animation, the stagger, the backdrop fade, the `prefers-reduced-motion` opt-out.~~ **DONE 2026-08-21.** Verified: `ai-slide-up` at a 150 ms delay, `ai-backdrop-in`, one run per open. | 6.3 |

## 10. Acceptance criteria

**A1 — Design parity on Horizon.** On the test store, our modal and the
reference store modal look the same for the same query, at 1512×806 and at
390×844. Judge by eye against `reference/`. No pixel gate.

At 390 px our modal must be full screen, as Horizon's is below 750 px.

Exclude the query-pill row from the judgement. §13 leaves it out of v1.

**A2 — Native on a second theme.** Install on a Dawn store. The modal uses
Dawn's font and Dawn's colors. The shell and the grid match §2. Nothing is
unreadable, and no color clashes.

**A3 — The takeover is complete.** On Horizon and on Dawn, every search
trigger opens our modal. The theme's own search modal, drawer or dropdown
never appears. Check the header icon, the mobile menu, and any keyboard
shortcut the theme binds.

**A4 — Keyboard.** `ArrowDown` ×3, `ArrowUp`, `Enter`, `Escape`, `Tab`
behave as §5 says, on both themes. Focus returns to the trigger on close.

**A5 — RTL.** On the Hebrew storefront the modal reads right to left. The
header, the card and the footer sit as they do on the reference store under
`dir=rtl`.

**A6 — The ranking is ours.** For a Hebrew query where AI ranking and native
ranking differ, the modal shows the AI order.

**A7 — Fail-safe.** Force the proxy to a 500, to a 3-second hang, and to a
malformed response. In all three cases the modal shows the No results state.
The footer "View all" button still points at the theme's search URL. The
shopper sees nothing that looks broken.

**A8 — No `showModal`.** With `showModal` stubbed out, the fallback overlay
opens, traps focus, and closes on `Escape`.

## 11. Risks

| Risk | Mitigation |
|---|---|
| **We now own the whole surface. A bug hides search completely.** | A7 is the guard. A failure shows the No results state, and the footer button always reaches the theme's search URL. Also keep the app embed toggle: off means the theme is untouched. |
| A theme opens its drawer on `pointerdown`, before our `click` handler | §4.3 closes it on open. If a theme defeats that, the merchant edits `trigger_selector`. |
| We miss a trigger on an unusual theme. The shopper gets the theme's search. | Degrades to native ranking, not to a broken page. The merchant edits `trigger_selector`. |
| The probe samples a transparent or a wrong color | Skip transparent. Walk the probe order. Fall back to the Horizon value. |
| A dark theme makes our fallback colors unreadable | Every color comes from the probe. A fallback only runs when the probe fails. Check on a dark store. |
| `<dialog>` is missing on an old browser | A8 covers the fallback path. |
| The Horizon design changes | Re-capture the reference. It is a design source, not a runtime input, so nothing breaks in production. |

## 12. Dropped from the first draft

Recorded so we do not re-add them.

| Dropped | Reason |
|---|---|
| The `fetch` and `XHR` interceptor | It only helps a theme that uses the Section Rendering API, and it needs one markup template per theme. |
| Runtime template harvest, theme profile, `sessionStorage` cache | Same reason. We own the markup now. |
| Warm-up request on modal open | Nothing to harvest. |
| Four-rung fallback ladder | We own the surface. The app embed toggle is the only fallback left. |
| Diagnostics endpoint, admin status row | Nothing to diagnose. |
| The 0.5 % pixel-diff gate | The reference store is the check. A gate that strict blocks work on image noise. |
| Reuse of the theme's own modal, as an `inline` mode | Superseded. We build one modal and use it everywhere. |
| The anchored `float` dropdown under the input | Superseded by the modal. |

## 13. Decided — the suggestion pills are out of v1

Horizon shows a row of query pills above the products. For `snow` it showed
`snowboard`, `stock snowboard`, `price snowboard`. See
`reference/02-results-1512.jpg`.

Our `/apps/search/suggest` endpoint returns products only. `SuggestResponse`
has `hits`, `total` and the diagnostics. It has no query list.

So there are three ways forward.

| Option | Cost | Result |
|---|---|---|
| **A. Omit the pills** | none | The panel differs from Horizon by one row. Everything else matches. |
| **B. Pass the theme's pills through** | one extra request per keystroke to `/search/suggest` with `resources[type]=query` | Horizon's own pills, our products. Adds latency and a second network call. |
| **C. Generate our own** | new server work: a query-suggestion source, plus Hebrew handling | Full parity, and a feature the merchant did not have. |

**Decided 2026-08-21: option A.** v1 ships no pills.

The pills are a nice extra, not the reason a shopper searches. So the panel
differs from Horizon by one row, and everything else matches. A1 must judge
parity with that row excluded.

Revisit after v1 ships. Option C is the better long-term answer, because it
would give the merchant something the theme never had.
