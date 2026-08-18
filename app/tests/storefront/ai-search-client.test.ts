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

const input = () => document.getElementById("Search-In-Modal") as HTMLInputElement;
const host = () => document.querySelector('[data-ai-search="dropdown"]') as HTMLElement;
const panel = () => host().shadowRoot!.querySelector(".ai-panel") as HTMLElement;
const options = () => Array.from(panel().querySelectorAll('[role="option"]')) as HTMLAnchorElement[];

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
    expect(opts[3].textContent).toContain("שמ");
    expect(panel().getAttribute("dir")).toBe("rtl");
  });

  it("theme listeners on the input never see the input event (native predictive silenced)", () => {
    boot({}, DAWN_HEADER);
    const themeHandler = vi.fn();
    input().addEventListener("input", themeHandler);
    type("שמן");
    expect(themeHandler).not.toHaveBeenCalled();
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

  it("ArrowDown/Up move the active option, Enter navigates to it, Escape closes", async () => {
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

  it("empty response closes the dropdown; a failing endpoint fails closed", async () => {
    boot({}, DAWN_HEADER);
    fetchMock.mockImplementationOnce(() => respond({ hits: [] }));
    type("זזזז");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(host().style.display).toBe("none");
    fetchMock.mockImplementationOnce(() => respond({}, false));
    type("שמן");
    vi.advanceTimersByTime(160);
    await flush();
    await flush();
    expect(host().style.display).toBe("none");
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
