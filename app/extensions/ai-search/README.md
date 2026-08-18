# AI Search — theme app extension

Storefront half of the Hebrew AI Search app (Phase 4, `specs/storefront-surfaces/`).
Two theme-editor pieces, one script:

| Piece | Where the merchant finds it | What it does |
|---|---|---|
| **App embed "AI Search"** (`blocks/embed.liquid`) | Theme editor → *Theme settings* → *App embeds* | Loads `ai-search.js`/`.css` on every page; intercepts the theme's search inputs and forms; replaces the native predictive dropdown with ours; hides native results / rewrites the search form depending on the results mode. |
| **App block "AI Search results"** (`blocks/results.liquid`) | Theme editor → *Search* template → *Add section* → **Apps** → *AI Search results* | Renders our results grid for `?q=` on the search page and hides the theme's own results section while it's present. |

Both talk to the app proxy at `/apps/search/*` (`suggest`, `results`, and the
Liquid results page) — same origin as the storefront, no keys in the browser.

## Merchant setup

### Online Store 2.0 themes (Dawn and friends) — recommended

1. **Enable the embed.** Online Store → Themes → Customize → *Theme settings*
   (bottom-left) → *App embeds* → turn on **AI Search** → Save.
   Type in the header search box: the AI dropdown replaces the theme's own.
2. **Add the results block.** In the customizer, open the **Search** template
   (page dropdown at the top → Search). *Add section* → **Apps** →
   *AI Search results*. Drag the new section to the top of the page. Save.
   The theme's own "Search results" section is hidden automatically while our
   block is on the page (you may also hide it with the eye icon).
3. Search for something and press Enter — the results page is now ours.

Embed settings: enable/disable, max suggestions (3–8), minimum characters,
show prices / images, **Results page** mode (leave on *App block* for OS 2.0
themes), and selector overrides for unusual themes (search input, search
form, native predictive dropdown, native results section).

Block settings: heading, products per page, show a search box above the
grid, show the result count, native-results selector override.

### Themes without app blocks (vintage / Online Store 1.0)

1. Enable the embed as above.
2. In the embed settings set **Results page** to *Search page from the app*.
   The embed rewrites the theme's search forms to submit to `/apps/search`,
   which renders our results page inside your theme's layout (header, footer,
   fonts) — RTL, paginated (prev/next links work even without JavaScript,
   "load more" when it's on).
3. Optionally hide the theme's own `/search` results section via the
   *Native results section selector* setting if shoppers can still reach it.

## Behaviour notes

- **Type-ahead** answers in ~50 ms server-side; on the very first sighting of
  a query it is keyword-based, and ~0.6 s later the dropdown quietly upgrades
  to the semantic ranking (the app tells the script via `semantic:
  "timeout"`). Repeats of a query and the results page are semantic at once.
- **Empty state**: queries with no lexical match and no semantic anchor
  (`זזזז`) show "no products" rather than random neighbours.
- **Never blank**: if the endpoint fails, the results block un-hides the
  theme's native results and links to them (`/search?q=…&ai=0` always shows
  native results); the dropdown simply doesn't open, and the form still submits.
- **RTL / isolation**: dropdown and grid render inside Shadow DOM with
  `dir="rtl"` and logical CSS properties; theme CSS cannot break them and
  they cannot break the theme. Fonts/colours can be tuned with the CSS custom
  properties `--ai-search-font`, `--ai-search-color`, `--ai-search-bg`,
  `--ai-search-border`, `--ai-search-hover`, `--ai-search-button-bg`,
  `--ai-search-button-color`, `--ai-search-max-width` set on `html`/`body`.
- **Accessibility**: `role="combobox"`/`listbox`/`option`, ArrowUp/Down +
  Enter, Escape (closes the dropdown, not the theme's search modal),
  click-outside; a polite live region announces the count and the active
  suggestion (ARIA id references cannot cross the shadow boundary).
- **Multi-currency**: prices are shop-currency (`shop.money_format`); Markets
  pricing is not applied (Phase 4 non-goal).

## Selectors the defaults cover (Dawn)

- Inputs: `form[action*="/search"] input[name="q"]` (header modal
  `#Search-In-Modal`, search page `#Search-In-Template`).
- Native predictive dropdown hidden: `predictive-search .predictive-search`,
  `[data-predictive-search]`, `#predictive-search-results`.
- Native results section hidden while the block is present:
  `.shopify-section:has(> .template-search)` and equivalents.
Override any of these in the embed / block settings for other themes.

## Development

`shopify app dev` serves the extension to the dev store; assets are plain
JS/CSS (no build). Storefront strings live in `locales/*.json`
(`ai_search.*`), editor labels under `embed.*` / `results.*`.
