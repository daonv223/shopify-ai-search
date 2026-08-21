// @vitest-environment jsdom
//
// Theme-extension client (extensions/ai-search/assets/ai-search.js) under
// jsdom (Phase 4 spec §3.2/§3.3): interception of a Dawn-shaped search
// input, debounce + abort, dropdown rendering in Shadow DOM, keyboard,
// the one-shot upgrade re-fetch on `semantic: "timeout"`, the results block
// (render / empty / error → native un-hidden), and proxy-mode form rewrite.
// The script is plain IIFE JS — it is loaded fresh per test by evaluating the
// file against a reset window.
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT = readFileSync(
  path.resolve(import.meta.dirname, "../../extensions/ai-search/assets/ai-search.js"),
  "utf8",
);

type Hit = {
  handle: string;
  title: string;
  url?: string;
  image_url?: string;
  price_min?: number;
  price_max?: number;
  available?: boolean;
};
const hit = (n: number, extra: Partial<Hit> = {}): Hit => ({
  handle: `p${n}`,
  title: `מוצר ${n}`,
  price_min: 10 * n,
  ...extra,
});

let fetchMock: ReturnType<typeof vi.fn>;
let calls: string[];

function respond(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

function boot(config: Record<string, unknown> = {}, html = "") {
  document.body.innerHTML = html;
  (window as unknown as { __aiSearchLoaded?: boolean }).__aiSearchLoaded = false;
  (window as unknown as { AISearchConfig: unknown }).AISearchConfig = {
    enabled: true,
    proxy: "/apps/search",
    cssUrl: "",
    resultsMode: "block",
    maxSuggestions: 6,
    showPrices: true,
    showImages: true,
    minChars: 1,
    searchUrl: "/search",
    moneyFormat: "₪{{amount}}",
    text: {
      showAll: "הצגת כל התוצאות עבור „{{ query }}”",
      noResults: "אין תוצאות",
      loadMore: "עוד",
      loading: "טוען",
      error: "שגיאה.",
      nativeLink: "חיפוש רגיל",
      soldOut: "אזל",
      resultsFor: "תוצאות עבור „{{ query }}”",
      resultsCount: "{{ count }} מוצרים",
      statusResults: "{{ count }} הצעות",
      searchPlaceholder: "חיפוש",
      searchButton: "חפש",
    },
    ...config,
  };
  // eslint-disable-next-line no-new-func
  new Function(SCRIPT)();
}

const DAWN_HEADER = `
  <predictive-search>
    <form action="/search" method="get" role="search" class="search">
      <input id="Search-In-Modal" type="search" name="q" role="combobox">
      <input type="hidden" name="options[prefix]" value="last">
      <div data-predictive-search><div id="predictive-search-results"></div></div>
    </form>
  </predictive-search>`;

// Phase 6 §4.2: the takeover happens at the TRIGGER, not at the field. This
// header carries all three shapes — an icon button, an open <details> drawer
// (the §4.3 guard), and the search field itself — plus the colours the §3.2
// probe samples.
const THEME_HEADER = `
  <header class="header" style="background-color: rgb(20, 20, 20); color: rgb(240, 240, 240)">
    <button id="theme-search-toggle" aria-label="Search">Search</button>
    <details id="theme-search-drawer" open>
      <summary aria-label="Search">S</summary>
      <form action="/search" method="get" role="search">
        <input id="Search-In-Modal" type="search" name="q">
      </form>
    </details>
  </header>
  <button class="button" style="background-color: rgb(255, 0, 0); color: rgb(255, 255, 255); border-radius: 8px">Buy</button>`;

const input = () => document.getElementById("Search-In-Modal") as HTMLInputElement;
const host = () => document.querySelector('[data-ai-search="dropdown"]') as HTMLElement;
const panel = () => host().shadowRoot!.querySelector(".ai-panel") as HTMLElement;
const dialog = () => host().shadowRoot!.querySelector(".ai-modal") as HTMLElement;
const field = () => host().shadowRoot!.querySelector(".ai-modal__input") as HTMLInputElement;
const empty = () => host().shadowRoot!.querySelector(".ai-empty") as HTMLElement | null;
const options = () => Array.from(panel().querySelectorAll('[role="option"]')) as HTMLAnchorElement[];
const toggle = () => document.getElementById("theme-search-toggle") as HTMLButtonElement;
const clickOn = (node: Element) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
  node.dispatchEvent(ev);
  return ev;
};

function type(value: string) {
  const el = input();
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const key = (k: string) => {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  input().dispatchEvent(ev);
  return ev;
};
// The same keystroke, but on OUR field inside the shadow root — which is where
// the shopper actually types once the modal is open (§4.4).
const mkey = (k: string) => {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, composed: true });
  field().dispatchEvent(ev);
  return ev;
};

// jsdom lays nothing out, so getComputedStyle(grid).gridTemplateColumns is
// always "". The client's column helper is split in two for exactly that: a
// pure parser (parseGridColumns) plus Dropdown.columns(), which does nothing
// but read the computed value, parse it, and fall back to 1 column. This stub
// drives that seam — `get` returns the resolved track list a real engine would
// report for the current container width, and it is a function so a test can
// change the answer between two keystrokes.
function stubGridColumns(get: () => string) {
  const real = window.getComputedStyle.bind(window);
  vi.stubGlobal("getComputedStyle", (node: Element, pseudo?: string | null) => {
    if (node instanceof HTMLElement && node.classList.contains("ai-products__grid")) {
      return { gridTemplateColumns: get(), getPropertyValue: () => get() } as unknown as CSSStyleDeclaration;
    }
    return real(node, pseudo ?? undefined);
  });
}
const track = (n: number) => new Array(n).fill("146.7px").join(" ");

// Fake timers are on: flush microtasks/promise chains via the timer API.
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  fetchMock = vi.fn((url: string) => {
    calls.push(url);
    return respond({ query: "x", hits: [hit(1), hit(2, { available: false }), hit(3)], total: 3, gated: false, semantic: "cached", took_ms: 5 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { ...window.location, assign: vi.fn(), search: "" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("type-ahead interception on a Dawn-shaped search input", () => {
  it("attaches a combobox, debounces 150ms, calls /apps/search/suggest with q and limit", async () => {
    boot({}, DAWN_HEADER);
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    type("ש");
    type("שמ");
    vi.advanceTimersByTime(100);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe("/apps/search/suggest?q=%D7%A9%D7%9E&limit=6");
    await flush();
    await flush();
    expect(host().style.display).toBe("block");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    const opts = options();
    expect(opts).toHaveLength(4); // 3 hits + "show all"
    expect(opts[0].getAttribute("href")).toBe("/products/p1");
    expect(opts[0].textContent).toContain("מוצר 1");
    expect(opts[0].textContent).toContain("₪10.00");
    expect(opts[1].textContent).toContain("אזל");
    expect(opts[3].getAttribute("href")).toBe("/search?q=%D7%A9%D7%9E");
    // Phase 6: Horizon's footer button is a fixed label. The query rides the
    // href, not the text. The label follows the storefront language and falls
    // back to English.
    expect(opts[3].textContent).toBe("View all");
  });

  it("text direction follows the merchant setting, and is never hardcoded", async () => {
    boot({}, DAWN_HEADER);
    type("שמ");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(panel().hasAttribute("dir")).toBe(false);
    expect(dialog().getAttribute("dir")).toBe("ltr");
  });

  it("direction: rtl forces the modal right to left", async () => {
    boot({ direction: "rtl" }, DAWN_HEADER);
    type("שמ");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(dialog().getAttribute("dir")).toBe("rtl");
  });

  it("merchant custom CSS lands inside the shadow root, after our own sheet", () => {
    // Theme CSS cannot cross the shadow boundary, so this setting is the only
    // way a merchant can restyle the modal.
    boot({ customCss: ".ai-modal { direction: rtl; }" }, DAWN_HEADER);
    const sheets = Array.from(host().shadowRoot!.children);
    const custom = host().shadowRoot!.querySelector('style[data-ai-search="custom"]');
    expect(custom).not.toBeNull();
    expect(custom!.textContent).toBe(".ai-modal { direction: rtl; }");
    // last, so an equal-specificity rule of theirs wins
    expect(sheets.indexOf(custom as Element)).toBeLessThan(sheets.length);
    expect(sheets.filter((n) => n.tagName === "LINK").every((n) => sheets.indexOf(n) < sheets.indexOf(custom as Element))).toBe(true);
  });

  it("no custom CSS setting means no extra style tag", () => {
    boot({}, DAWN_HEADER);
    expect(host().shadowRoot!.querySelector('style[data-ai-search="custom"]')).toBeNull();
  });

  it("the theme's own search handler never runs — we take the trigger, not the field", () => {
    // REPLACES the Phase 4 contract this test used to encode ("theme listeners
    // on the input never see the input event"). Phase 6 §4.4 removed the
    // capture-phase stopImmediatePropagation on the theme's field: the shopper
    // types in OUR input, so there is nothing to suppress. The takeover now
    // happens one step earlier, at the trigger (§4.2) — preventDefault +
    // stopPropagation in the capture phase on `document`, so the theme's own
    // search UI is never asked to open at all.
    boot({}, THEME_HEADER);
    const themeOpensItsDrawer = vi.fn();
    toggle().addEventListener("click", themeOpensItsDrawer); // direct handler
    document.addEventListener("click", themeOpensItsDrawer); // delegated handler
    const ev = clickOn(toggle());
    expect(themeOpensItsDrawer).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    document.removeEventListener("click", themeOpensItsDrawer);

    // …and the theme's own field handlers are no longer silenced (§4.4).
    const themeFieldHandler = vi.fn();
    input().addEventListener("input", themeFieldHandler);
    type("שמן");
    expect(themeFieldHandler).toHaveBeenCalled();
  });

  it("aborts the in-flight request when the shopper keeps typing", async () => {
    boot({}, DAWN_HEADER);
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      return new Promise(() => {}); // never resolves
    });
    type("שמ");
    vi.advanceTimersByTime(160);
    type("שמן");
    vi.advanceTimersByTime(160);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("ArrowDown/Up fall back to a one-card walk when the grid is not measurable, Enter navigates, Escape closes", async () => {
    // Spec §5: ArrowDown/Up move one ROW, and a row is the live column count.
    // With no measurable grid-template-columns the count degrades to 1, so the
    // keys behave exactly as the Phase 4 flat list did — degrade, never break.
    // The real 4- and 2-column rows are covered in the §5 grid suite below.
    boot({}, DAWN_HEADER);
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    key("ArrowDown");
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    key("ArrowDown");
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    key("ArrowUp");
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    const enter = key("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect((window.location.assign as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("/products/p1");
    key("Escape");
    expect(host().style.display).toBe("none");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("Enter with no active option lets the form submit (no preventDefault) and closes", async () => {
    boot({}, DAWN_HEADER);
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    const enter = key("Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(host().style.display).toBe("none");
  });

  it("click outside closes; click on the input does not", async () => {
    boot({}, DAWN_HEADER);
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    input().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    expect(host().style.display).toBe("block");
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    expect(host().style.display).toBe("none");
  });

  it("re-fetches once ~600ms after a semantic:timeout answer if the query is unchanged, and swaps in the hybrid list", async () => {
    boot({}, DAWN_HEADER);
    fetchMock
      .mockImplementationOnce((url: string) => {
        calls.push(url);
        return respond({ hits: [hit(9)], semantic: "timeout" });
      })
      .mockImplementationOnce((url: string) => {
        calls.push(url);
        return respond({ hits: [hit(1), hit(2)], semantic: "cached" });
      });
    input().focus();
    type("שמנים");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(options()[0].textContent).toContain("מוצר 9");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(650);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[1]).toBe(calls[0]);
    await flush();
    await flush();
    expect(options()[0].textContent).toContain("מוצר 1");
    // and only once
    vi.advanceTimersByTime(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not upgrade when the shopper typed on in the meantime", async () => {
    boot({}, DAWN_HEADER);
    fetchMock.mockImplementation((url: string) => {
      calls.push(url);
      return respond({ hits: [hit(9)], semantic: "timeout" });
    });
    input().focus();
    type("שמנ");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    type("שמני");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    vi.advanceTimersByTime(700);
    // 2 typed fetches + 1 upgrade for the latest query only
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(calls[2]).toBe(calls[1]);
  });

  it("an empty answer and a failed answer both show the No-results state", async () => {
    // Phase 6 spec section 7 replaces the Phase 4 silent close. We own the
    // whole search surface now, so a blank modal would look broken. A failure
    // must be indistinguishable from a true empty result.
    boot({}, DAWN_HEADER);
    fetchMock.mockImplementationOnce(() => respond({ hits: [] }));
    type("זזזז");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(host().style.display).toBe("block");
    expect(panel().getAttribute("data-state")).toBe("empty");
    expect(empty()).not.toBeNull();
    fetchMock.mockImplementationOnce(() => respond({}, false));
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(host().style.display).toBe("block");
    expect(panel().getAttribute("data-state")).toBe("empty");
  });

  it("respects minChars and the maxSuggestions cap", async () => {
    boot({ minChars: 2, maxSuggestions: 2 }, DAWN_HEADER);
    type("ש");
    vi.advanceTimersByTime(200);
    expect(fetchMock).not.toHaveBeenCalled();
    type("שמ");
    vi.advanceTimersByTime(200);
    expect(calls[0]).toContain("limit=2");
    await flush();
    await flush();
    expect(options()).toHaveLength(3); // 2 + show all
  });
});

describe("grid keyboard, ARIA and RTL (spec §5/§6, task 6.8)", () => {
  // 8 cards + the "View all" pill = 9 options. At 4 columns that is two rows
  // of four and then the pill; at 2 columns, four rows of two and the pill.
  const EIGHT = { hits: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => hit(n)), total: 20, semantic: "cached" };

  async function openWithEight(config: Record<string, unknown> = {}) {
    boot({ maxSuggestions: 8, ...config }, DAWN_HEADER);
    fetchMock.mockImplementation(() => respond(EIGHT));
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(options()).toHaveLength(9);
  }
  const activeIndex = () => options().findIndex((o) => o.getAttribute("aria-selected") === "true");

  it("ArrowDown/ArrowUp move one row of four at 4 columns", async () => {
    await openWithEight();
    stubGridColumns(() => track(4));
    mkey("ArrowDown");
    expect(activeIndex()).toBe(0);
    mkey("ArrowDown");
    expect(activeIndex()).toBe(4); // one row, not one card
    mkey("ArrowUp");
    expect(activeIndex()).toBe(0);
    mkey("ArrowUp");
    expect(activeIndex()).toBe(-1); // back to the input, where the query is
  });

  it("ArrowDown/ArrowUp move one row of two at 2 columns", async () => {
    await openWithEight();
    stubGridColumns(() => track(2));
    mkey("ArrowDown");
    expect(activeIndex()).toBe(0);
    mkey("ArrowDown");
    expect(activeIndex()).toBe(2);
    mkey("ArrowDown");
    expect(activeIndex()).toBe(4);
    mkey("ArrowUp");
    expect(activeIndex()).toBe(2);
  });

  it("the specified form, repeat(4, 1fr), parses as four columns too", async () => {
    await openWithEight();
    stubGridColumns(() => "repeat(4, 1fr)");
    mkey("ArrowDown");
    mkey("ArrowDown");
    expect(activeIndex()).toBe(4);
  });

  it("the column count is re-read at every keystroke, never cached", async () => {
    // §5: the grid is a CONTAINER query, so the count follows the panel width.
    // A count cached at 4 would jump 4 -> 8 -> "View all" here; re-reading it
    // gives 4 -> 6, one row of two.
    await openWithEight();
    let cols = 4;
    stubGridColumns(() => track(cols));
    mkey("ArrowDown");
    mkey("ArrowDown");
    expect(activeIndex()).toBe(4);
    cols = 2; // the panel narrowed under the shopper's hands
    mkey("ArrowDown");
    expect(activeIndex()).toBe(6);
  });

  it("ArrowRight moves forward one card and ArrowLeft back, under ltr", async () => {
    await openWithEight();
    stubGridColumns(() => track(4));
    expect(dialog().getAttribute("dir")).toBe("ltr");
    mkey("ArrowDown");
    expect(activeIndex()).toBe(0);
    mkey("ArrowRight");
    expect(activeIndex()).toBe(1);
    mkey("ArrowRight");
    expect(activeIndex()).toBe(2);
    mkey("ArrowLeft");
    expect(activeIndex()).toBe(1);
  });

  it("ArrowLeft moves forward and ArrowRight back under dir=rtl", async () => {
    await openWithEight({ direction: "rtl" });
    stubGridColumns(() => track(4));
    expect(dialog().getAttribute("dir")).toBe("rtl");
    mkey("ArrowDown");
    expect(activeIndex()).toBe(0);
    mkey("ArrowLeft"); // reading order: forward
    expect(activeIndex()).toBe(1);
    mkey("ArrowLeft");
    expect(activeIndex()).toBe(2);
    mkey("ArrowRight"); // back
    expect(activeIndex()).toBe(1);
  });

  it("ArrowRight/Left, Home and End leave the caret alone while no card is active", async () => {
    // Our field is a text input. Hijacking these keys before the shopper has
    // entered the grid would take away the only way to edit the query.
    await openWithEight();
    stubGridColumns(() => track(4));
    expect(mkey("ArrowRight").defaultPrevented).toBe(false);
    expect(mkey("Home").defaultPrevented).toBe(false);
    expect(mkey("End").defaultPrevented).toBe(false);
    expect(activeIndex()).toBe(-1);
  });

  it("Home goes to the first card, End to the last option", async () => {
    await openWithEight();
    stubGridColumns(() => track(4));
    mkey("ArrowDown");
    mkey("ArrowDown");
    expect(activeIndex()).toBe(4);
    expect(mkey("End").defaultPrevented).toBe(true);
    expect(activeIndex()).toBe(8); // the "View all" pill
    expect(options()[8].classList.contains("ai-viewall")).toBe(true);
    expect(mkey("Home").defaultPrevented).toBe(true);
    expect(activeIndex()).toBe(0);
  });

  it("wraps at both ends: past the last row lands on View all, and round again", async () => {
    await openWithEight();
    stubGridColumns(() => track(4));
    mkey("ArrowDown"); // 0
    mkey("ArrowDown"); // 4 — the second and last row
    mkey("ArrowDown");
    expect(activeIndex()).toBe(8); // View all is the last option
    mkey("ArrowDown");
    expect(activeIndex()).toBe(-1); // wrap through the input
    mkey("ArrowDown");
    expect(activeIndex()).toBe(0); // …and round to the first card again

    mkey("ArrowUp");
    expect(activeIndex()).toBe(-1);
    mkey("ArrowUp");
    expect(activeIndex()).toBe(8); // wrap the other way, onto View all
    mkey("ArrowUp");
    expect(activeIndex()).toBe(7); // …then the last card
  });

  it("Enter opens the active card; with none active it submits the search", async () => {
    await openWithEight();
    stubGridColumns(() => track(4));
    mkey("ArrowDown");
    mkey("ArrowRight");
    const enter = mkey("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(window.location.assign as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("/products/p2");
    // No active card: we never preventDefault, so our own <form> submits.
    mkey("ArrowUp");
    expect(activeIndex()).toBe(-1);
    expect(mkey("Enter").defaultPrevented).toBe(false);
  });

  it("aria-expanded is true exactly while options are showing", async () => {
    await openWithEight();
    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    // No results: the footer leaves the listbox too, so there are no options.
    fetchMock.mockImplementation(() => respond({ hits: [] }));
    type("זזזז");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(options()).toHaveLength(0);
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    // Blank query: header and footer only — still no options showing.
    type("");
    vi.advanceTimersByTime(160);
    await flush();
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("aria-activedescendant points at the active option and is removed when none is", async () => {
    await openWithEight();
    stubGridColumns(() => track(4));
    expect(field().hasAttribute("aria-activedescendant")).toBe(false);
    mkey("ArrowDown");
    expect(field().getAttribute("aria-activedescendant")).toBe(options()[0].id);
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0].id);
    expect(options()[0].id).toBeTruthy();
    mkey("End");
    expect(field().getAttribute("aria-activedescendant")).toBe(options()[8].id);
    mkey("ArrowDown"); // off the end, back to the input
    expect(field().hasAttribute("aria-activedescendant")).toBe(false);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("aria-controls points at the listbox", async () => {
    await openWithEight();
    const listbox = panel();
    expect(listbox.getAttribute("role")).toBe("listbox");
    expect(listbox.id).toBeTruthy();
    expect(field().getAttribute("aria-controls")).toBe(listbox.id);
    expect(input().getAttribute("aria-controls")).toBe(listbox.id);
  });
});

describe("entrance animation (spec §2.5, task 6.11)", () => {
  it("marks the panel for the one-shot card animation on the first render only", async () => {
    boot({}, DAWN_HEADER);
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(panel().classList.contains("ai-enter")).toBe(true);
    // Typing on must not replay it — §7 keeps the old cards on screen, and a
    // grid that blinks on every keystroke is unusable.
    type("שמנים");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(panel().classList.contains("ai-enter")).toBe(false);
  });

  it("re-arms after the modal closes and opens again", async () => {
    boot({}, DAWN_HEADER);
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    key("Escape");
    expect(panel().classList.contains("ai-enter")).toBe(false);
    input().focus();
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(panel().classList.contains("ai-enter")).toBe(true);
  });
});

// The stylesheet is a <link> in the shadow root, so jsdom never applies it.
// These two contracts are checked against the source text instead: a
// prefers-reduced-motion escape hatch that really covers everything (§2.5) and
// logical properties only (§6). Both are invisible to any DOM assertion.
describe("stylesheet contract (spec §2.5/§6, tasks 6.8/6.11)", () => {
  const CSS = readFileSync(
    path.resolve(import.meta.dirname, "../../extensions/ai-search/assets/ai-search.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("prefers-reduced-motion: reduce switches off every animation we add", () => {
    const guard = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS);
    expect(guard).not.toBeNull();
    const guarded = guard![1];
    const animated = CSS.replace(guard![0], "").match(/[^{}]+\{[^{}]*\banimation:[^{}]*\}/g) ?? [];
    expect(animated.length).toBeGreaterThan(0);
    for (const rule of animated) {
      for (const selector of rule.slice(0, rule.indexOf("{")).split(",")) {
        expect(guarded).toContain(selector.trim());
      }
    }
  });

  it("uses logical properties only — never a hardcoded side", () => {
    expect(CSS).not.toMatch(
      /(^|[\s;{])(left|right|top|bottom|margin-left|margin-right|padding-left|padding-right|border-left|border-right)\s*:/,
    );
  });
});

describe("trigger takeover (spec §4.2/§4.3/§4.4)", () => {
  it("a click on a search trigger opens our modal and puts focus in our input", () => {
    boot({}, THEME_HEADER);
    const ev = clickOn(toggle());
    expect(ev.defaultPrevented).toBe(true);
    expect(host().style.display).toBe("block");
    expect(host().shadowRoot!.activeElement).toBe(field());
    expect(panel().getAttribute("data-state")).toBe("blank");
  });

  it("the blank state shows the header alone — no dangling View all pill", () => {
    // §7. With no query the pill would point at /search?q= and mean nothing,
    // and it floated over an empty 64px band that read as a second modal.
    boot({}, THEME_HEADER);
    clickOn(toggle());
    const pill = host().shadowRoot!.querySelector(".ai-viewall") as HTMLElement;
    expect(panel().getAttribute("data-state")).toBe("blank");
    // out of the listbox, so ArrowDown cannot land on it
    expect(pill.hasAttribute("role")).toBe(false);
    expect(options()).toHaveLength(0);
  });

  it("the default trigger list also covers a plain link to /search", () => {
    boot({}, `${THEME_HEADER}<a id="menu-search" href="/search">Search</a>`);
    const link = document.getElementById("menu-search")!;
    const ev = clickOn(link);
    expect(ev.defaultPrevented).toBe(true);
    expect(host().style.display).toBe("block");
  });

  it("a merchant trigger_selector replaces the default list", () => {
    boot({ triggerSelector: "#odd-one" }, `${THEME_HEADER}<span id="odd-one">?</span>`);
    // the built-in trigger no longer matches
    expect(clickOn(toggle()).defaultPrevented).toBe(false);
    expect(host().style.display).toBe("none");
    expect(clickOn(document.getElementById("odd-one")!).defaultPrevented).toBe(true);
    expect(host().style.display).toBe("block");
  });

  it("focusing the theme's search field opens our modal, carries the text and moves focus", () => {
    boot({}, THEME_HEADER);
    input().value = "שמן";
    input().focus();
    expect(host().style.display).toBe("block");
    expect(field().value).toBe("שמן");
    expect(host().shadowRoot!.activeElement).toBe(field());
  });

  it("a keystroke on a non-field trigger opens the modal and carries the first character (§4.4)", () => {
    boot({}, THEME_HEADER);
    toggle().focus();
    const ev = new KeyboardEvent("keydown", { key: "ש", bubbles: true, cancelable: true });
    toggle().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(host().style.display).toBe("block");
    expect(field().value).toBe("ש");
    vi.advanceTimersByTime(160);
    expect(calls[0]).toContain(`q=${encodeURIComponent("ש")}`);
  });

  it("the theme's own '/' shortcut opens our modal instead, with an empty query", () => {
    boot({}, THEME_HEADER);
    const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(host().style.display).toBe("block");
    expect(field().value).toBe("");
  });

  it("opening closes an open <details> drawer that holds a search trigger (§4.3)", () => {
    boot({}, THEME_HEADER);
    const drawer = document.getElementById("theme-search-drawer") as HTMLDetailsElement;
    expect(drawer.hasAttribute("open")).toBe(true);
    clickOn(toggle());
    expect(drawer.hasAttribute("open")).toBe(false);
  });

  it("an open <details> without a search trigger is left alone", () => {
    boot({}, `${THEME_HEADER}<details id="cart-drawer" open><summary>Cart</summary></details>`);
    clickOn(toggle());
    expect((document.getElementById("cart-drawer") as HTMLDetailsElement).hasAttribute("open")).toBe(true);
  });

  it("focus returns to the trigger when the modal closes (§5)", () => {
    boot({}, THEME_HEADER);
    clickOn(toggle());
    expect(host().style.display).toBe("block");
    field().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true }),
    );
    expect(host().style.display).toBe("none");
    expect(document.activeElement).toBe(toggle());
  });

  it("the focus return does not re-open the modal", () => {
    boot({}, THEME_HEADER);
    input().focus();
    expect(host().style.display).toBe("block");
    field().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true }),
    );
    expect(host().style.display).toBe("none");
    expect(document.activeElement).toBe(input());
  });
});

describe("runtime style probe (spec §3.2/§3.3)", () => {
  it("samples resolved theme colours onto the shadow host as --ais-* tokens", () => {
    boot({}, THEME_HEADER);
    const h = host();
    // Never a theme token name (--color-background is a bare triplet on Dawn):
    // only resolved getComputedStyle values.
    expect(h.style.getPropertyValue("--ais-bg")).toBe("rgb(20, 20, 20)");
    expect(h.style.getPropertyValue("--ais-fg")).toBe("rgb(240, 240, 240)");
    // border derives from the sampled foreground at low alpha
    expect(h.style.getPropertyValue("--ais-border")).toBe("rgba(240, 240, 240, 0.14)");
    // accent from the theme's own primary button
    expect(h.style.getPropertyValue("--ais-accent")).toBe("rgb(255, 0, 0)");
    expect(h.style.getPropertyValue("--ais-accent-fg")).toBe("rgb(255, 255, 255)");
    expect(h.style.getPropertyValue("--ais-radius")).toBe("8px");
  });

  it("skips a transparent background and walks on to the next probe source", () => {
    boot(
      { probeSelector: "#ghost" },
      `<div id="ghost" style="background-color: transparent; color: rgb(1, 2, 3)"></div>${THEME_HEADER}`,
    );
    expect(host().style.getPropertyValue("--ais-bg")).toBe("rgb(20, 20, 20)");
    expect(host().style.getPropertyValue("--ais-fg")).toBe("rgb(240, 240, 240)");
  });

  it("a probe that finds nothing leaves every token unset, so the CSS Horizon fallback runs", () => {
    boot({ probeSelector: "#nothing-here" }, DAWN_HEADER);
    const h = host();
    expect(h.style.getPropertyValue("--ais-bg")).toBe("");
    expect(h.style.getPropertyValue("--ais-accent")).toBe("");
    // fg still resolves from the walk, and the border derives from it
    expect(h.style.getPropertyValue("--ais-border")).toBe("rgba(0, 0, 0, 0.14)");
  });
});

describe("results block (block mode)", () => {
  const BLOCK = `
    <style id="ai-search-hide-native">.native{display:none!important}</style>
    <div class="native shopify-section">NATIVE RESULTS</div>
    <div data-ai-search-results data-endpoint="/apps/search/results" data-limit="2" data-heading="תוצאות" data-native-style="ai-search-hide-native"></div>`;
  const block = () => document.querySelector("[data-ai-search-results]") as HTMLElement;
  const wrap = () => block().shadowRoot!.querySelector(".ai-results") as HTMLElement;

  it("renders the grid for ?q=, paginates with load more, shows the count", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn(), search: "?q=%D7%A9%D7%9E%D7%A0%D7%99%D7%9D" });
    fetchMock
      .mockImplementationOnce((url: string) => {
        calls.push(url);
        return respond({ hits: [hit(1), hit(2)], total: 5, has_more: true, semantic: "cached" });
      })
      .mockImplementationOnce((url: string) => {
        calls.push(url);
        return respond({ hits: [hit(3)], total: 5, has_more: false });
      });
    boot({}, BLOCK);
    expect(calls[0]).toBe("/apps/search/results?q=%D7%A9%D7%9E%D7%A0%D7%99%D7%9D&page=1&limit=2");
    await flush();
    await flush();
    expect(wrap().querySelectorAll(".ai-grid .ai-card")).toHaveLength(2);
    expect(wrap().querySelector(".ai-count")!.textContent).toBe("5 מוצרים");
    expect(wrap().querySelector(".ai-subheading")!.textContent).toContain("שמנים");
    const more = wrap().querySelector(".ai-more") as HTMLButtonElement;
    expect(more.style.display).toBe("");
    more.click();
    expect(calls[1]).toContain("page=2");
    await flush();
    await flush();
    expect(wrap().querySelectorAll(".ai-grid .ai-card")).toHaveLength(3);
    expect(more.style.display).toBe("none");
    // native stays hidden
    expect(document.getElementById("ai-search-hide-native")).not.toBeNull();
    // the block's own search box is intercepted too
    const inner = wrap().querySelector("input.ai-input") as HTMLInputElement;
    expect(inner.getAttribute("role")).toBe("combobox");
  });

  it("empty state", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn(), search: "?q=zzzz" });
    fetchMock.mockImplementationOnce(() => respond({ hits: [], total: 0, has_more: false }));
    boot({}, BLOCK);
    await flush();
    await flush();
    expect(wrap().querySelector(".ai-status")!.textContent).toBe("אין תוצאות");
    expect(wrap().querySelectorAll(".ai-card")).toHaveLength(0);
  });

  it("endpoint failure: native results un-hidden and linked, never blank", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn(), search: "?q=%D7%A9%D7%9E%D7%9F" });
    fetchMock.mockImplementationOnce(() => respond({}, false));
    boot({}, BLOCK);
    await flush();
    await flush();
    expect(document.getElementById("ai-search-hide-native")).toBeNull();
    const link = wrap().querySelector(".ai-status a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/search?q=%D7%A9%D7%9E%D7%9F&ai=0");
    expect(wrap().querySelector(".ai-status")!.textContent).toContain("שגיאה");
  });

  it("?ai=0 leaves the native results alone and does not render the block", () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn(), search: "?q=x&ai=0" });
    boot({}, BLOCK);
    expect(document.getElementById("ai-search-hide-native")).toBeNull();
    expect(block().shadowRoot).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a stray hide-style on a page without the block is removed", () => {
    boot({}, `<style id="ai-search-hide-native">.x{display:none}</style><div class="x">NATIVE</div>`);
    expect(document.getElementById("ai-search-hide-native")).toBeNull();
  });
});

describe("proxy mode (vintage themes)", () => {
  it("rewrites search forms to /apps/search and keeps the original action", () => {
    boot({ resultsMode: "proxy" }, DAWN_HEADER);
    const form = document.querySelector("form")!;
    expect(form.getAttribute("action")).toBe("/apps/search");
    expect(form.getAttribute("data-ai-search-original-action")).toBe("/search");
  });

  it("the dropdown's show-all row follows the rewritten form", async () => {
    boot({ resultsMode: "proxy" }, DAWN_HEADER);
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    const all = options()[options().length - 1];
    expect(all.getAttribute("href")).toBe("/apps/search?q=%D7%A9%D7%9E%D7%9F");
  });

  it("enhances the server-rendered page: load more fetches page 2 and appends cards", async () => {
    fetchMock.mockImplementationOnce((url: string) => {
      calls.push(url);
      return respond({ hits: [hit(7, { image_url: "https://cdn/x.jpg?v=1", price_min: 5, price_max: 9 })], has_more: false });
    });
    boot(
      { resultsMode: "proxy" },
      `<div data-ai-search-page data-endpoint="/apps/search/results" data-query="שמן" data-page="1" data-limit="24" data-has-more="true">
         <ul data-ai-search-grid><li class="ai-search-item">a</li></ul>
         <a data-ai-search-more href="/apps/search?q=שמן&page=2">הבא</a>
       </div>`,
    );
    const more = document.querySelector("[data-ai-search-more]") as HTMLAnchorElement;
    more.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(calls[0]).toBe("/apps/search/results?q=%D7%A9%D7%9E%D7%9F&page=2&limit=24");
    await flush();
    await flush();
    const items = document.querySelectorAll("[data-ai-search-grid] .ai-search-item");
    expect(items).toHaveLength(2);
    expect(items[1].querySelector("img")!.getAttribute("src")).toBe("https://cdn/x.jpg?v=1&width=400");
    expect(items[1].querySelector(".ai-search-price")!.textContent).toBe("₪5.00 – ₪9.00");
    expect(more.style.display).toBe("none");
  });
});

describe("money formatting", () => {
  it.each([
    ["₪{{amount}}", 1234.5, "₪1,234.50"],
    ["{{amount_no_decimals}} ₪", 1234.5, "1,235 ₪"],
    ["{{amount_with_comma_separator}} €", 1234.5, "1.234,50 €"],
    ["<span class=money>₪{{amount}}</span>", 3, "₪3.00"],
  ])("%s", async (format, amount, expected) => {
    fetchMock.mockImplementationOnce(() => respond({ hits: [hit(1, { price_min: amount })] }));
    boot({ moneyFormat: format }, DAWN_HEADER);
    type("א");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(options()[0].querySelector(".ai-price")!.textContent).toBe(expected);
  });
});
