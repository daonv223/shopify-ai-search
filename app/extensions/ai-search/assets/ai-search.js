/*
 * AI Search — storefront client (theme app extension, Phase 4 spec §3.2/§3.3).
 *
 * Loaded by the app embed on every page (window.AISearchConfig is written by
 * blocks/embed.liquid). Plain ES2019, no build step, no dependencies.
 *
 *  1. Search modal (Phase 6): document-level CAPTURE listeners for click,
 *     focusin and keydown take over every search trigger (cfg.triggerSelector)
 *     before the theme's own handler runs, and open our <dialog> inside a
 *     Shadow DOM host. The shopper types in OUR input, so we never suppress
 *     the theme's own field handlers (§4.4). A boot-time probe samples the
 *     theme's colours into --ais-* tokens on the host (§3.2). Debounce 150ms,
 *     AbortController per keystroke, GRID keyboard navigation (§5: Arrow
 *     Down/Up move one row of the live column count, Right/Left one card in
 *     reading order and swap under rtl, Home/End, Enter), Escape,
 *     click-outside, ARIA combobox + live region. A response with
 *     semantic:"timeout" (cold embedding cache — phase4-notes.md) triggers ONE
 *     upgrade re-fetch ~600ms later if the query is unchanged, swapping in the
 *     hybrid ranking.
 *  2. Results (block mode): renders [data-ai-search-results] from
 *     /apps/search/results — RTL grid, load more, empty state; on error it
 *     un-hides the theme's native results and links to them.
 *  3. Results (proxy mode): rewrites the theme's search forms to /apps/search
 *     and enhances the server-rendered page ([data-ai-search-page]) with
 *     fetch-based "load more".
 */
(function () {
  'use strict';

  var cfg = window.AISearchConfig;
  if (!cfg || !cfg.enabled || window.__aiSearchLoaded) return;
  window.__aiSearchLoaded = true;

  // One document, one live run. window.__aiSearchLoaded already stops a plain
  // double-load, but a re-evaluated script (a theme that injects the asset
  // twice, a test harness) would otherwise leave the previous run's
  // capture-phase listeners on `document` for ever — and, now that §4.4 has us
  // no longer calling stopImmediatePropagation, both runs would answer every
  // event. Each run stamps the document; every document-level listener and the
  // MutationObserver below stand down once the stamp moves on.
  var RUN = Number(document.__aiSearchRun || 0) + 1;
  document.__aiSearchRun = RUN;
  function stale() {
    return document.__aiSearchRun !== RUN;
  }

  var PROXY = cfg.proxy || '/apps/search';
  var TEXT = cfg.text || {};
  var DEBOUNCE_MS = 150;
  var UPGRADE_DELAY_MS = 600;
  var INPUT_SELECTOR = cfg.inputSelector || 'form[action*="/search"] input[name="q"]';
  var FORM_SELECTOR = cfg.formSelector || 'form[action*="/search"]';
  // Phase 6 §4.2 — a "search trigger" is anything that opens search on the
  // theme: a link or button to /search, a button or <summary> labelled
  // "search", or a search field. Merchant-editable, so per-theme support costs
  // one selector and no new code.
  var TRIGGER_SELECTOR =
    cfg.triggerSelector ||
    [
      'a[href*="/search"]',
      'button[formaction*="/search"]',
      'button[name="search"]',
      'button[aria-label*="search" i]',
      'a[aria-label*="search" i]',
      'summary[aria-label*="search" i]',
      '[role="button"][aria-label*="search" i]',
      '.header__icon--search',
      '[data-ai-search-trigger]',
      'input[type="search"]',
      'input[name="q"]',
    ].join(', ');
  // Phase 6 §3.2 — probe order. The merchant setting overrides step one only.
  var PROBE_DIALOG =
    cfg.probeSelector ||
    'dialog[class*="search" i], .search-modal__content, .search-modal, predictive-search, [id*="search-modal" i]';
  var PROBE_HEADER = 'header, .header, #shopify-section-header, [role="banner"]';
  // The theme's own primary button — the source for --ais-accent.
  var PROBE_BUTTON =
    '.button--primary, .btn--primary, button.button, a.button, .shopify-payment-button__button, button[type="submit"]';
  // Horizon shows 8 cards even when the live region reports more (Phase 6
  // reference/measurements.md §6). The merchant setting may ask for fewer.
  var MAX_CARDS = 8;
  var CARD_LIMIT = Math.min(cfg.maxSuggestions || MAX_CARDS, MAX_CARDS);

  // Text direction. The merchant sets it in the theme editor: "auto" (the
  // default) follows the storefront, "ltr" or "rtl" force one direction.
  // "auto" resolves per element from the page, never from a hardcoded value.
  function pageDir(node) {
    var d = String(cfg.direction || 'auto').toLowerCase();
    if (d === 'ltr' || d === 'rtl') return d;
    var probe = node || document.body || document.documentElement;
    var explicit = probe.closest && probe.closest('[dir]');
    if (explicit) {
      var v = String(explicit.getAttribute('dir') || '').toLowerCase();
      if (v === 'ltr' || v === 'rtl') return v;
    }
    if (window.getComputedStyle) {
      var cs = window.getComputedStyle(probe);
      if (cs && cs.direction) return cs.direction;
    }
    return 'ltr';
  }
  // Phase 6 §5 — the results are a GRID, not a list, so ArrowDown/Up move one
  // ROW and a row is the live column count. The grid is driven by a CONTAINER
  // query (repeat(2,1fr), then repeat(4,1fr) at @container min-width:550px),
  // so the count follows the panel width and a cached value goes stale the
  // moment the panel is resized. We therefore read it at every keystroke.
  //
  // parseGridColumns() is the pure half: it takes whatever the engine reports
  // for `grid-template-columns` and returns a track count. Browsers report a
  // resolved track list ("146.7px 146.7px 146.7px 146.7px"); a few report the
  // specified value ("repeat(4, 1fr)"). Both are handled. Anything we cannot
  // read returns 0, and the caller degrades to a single column — which makes
  // ArrowDown/Up behave exactly like the old flat list rather than break.
  function parseGridColumns(value) {
    if (!value) return 0;
    var v = String(value).trim().toLowerCase();
    if (!v || v === 'none' || v === 'auto' || v === 'initial') return 0;
    var rep = /repeat\(\s*(\d+)\s*,/.exec(v);
    if (rep) return Number(rep[1]) || 0;
    // Drop [line-names], then collapse every function call — minmax(0, 1fr),
    // fit-content(20%) — to one token so the whitespace split cannot see
    // inside it.
    v = v.replace(/\[[^\]]*\]/g, ' ');
    while (/[a-z-]+\([^()]*\)/.test(v)) v = v.replace(/[a-z-]+\([^()]*\)/g, 'x');
    v = v.trim();
    if (!v) return 0;
    return v.split(/\s+/).length;
  }

  // <dialog>.showModal() gives us a focus trap, Escape, inertness and a
  // ::backdrop for free. Where it is missing we mount a plain overlay and do
  // the trapping ourselves (Phase 6 spec §4.1, task 6.4).
  var HAS_SHOW_MODAL =
    typeof HTMLDialogElement !== 'undefined' &&
    HTMLDialogElement.prototype &&
    typeof HTMLDialogElement.prototype.showModal === 'function';
  var FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  // ---------- small helpers ----------

  // Liquid's `t` filter HTML-escapes every translation, so a straight quote in
  // a locale file reaches us as &quot;. We always write through textContent,
  // so decoding here is safe and cannot inject markup. Locale files should
  // still prefer typographic quotes; this only stops the class of bug.
  var ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' };
  function decode(text) {
    if (text.indexOf('&') < 0) return text;
    return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, function (whole, name) {
      if (name.charAt(0) === '#') {
        var code =
          name.charAt(1) === 'x' || name.charAt(1) === 'X'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCharCode(code) : whole;
      }
      var hit = ENTITIES[name.toLowerCase()];
      return hit === undefined ? whole : hit;
    });
  }

  function t(key, vars) {
    var s = decode(TEXT[key] || '');
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.replace(new RegExp('\\{\\{\\s*' + k + '\\s*\\}\\}', 'g'), String(vars[k]));
      });
    }
    return s;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) return;
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Shopify money format ("₪{{amount}}", "{{amount_no_decimals}} ₪", …) on a
  // major-unit amount from the index. Falls back to Intl if the format is odd.
  function formatMoney(amount) {
    if (amount === null || amount === undefined || isNaN(amount)) return '';
    var format = cfg.moneyFormat || '{{amount}}';
    var cents = Math.round(Number(amount) * 100);
    var m = /\{\{\s*(\w+)\s*\}\}/.exec(format);
    if (!m) return String(amount);
    var value;
    switch (m[1]) {
      case 'amount_no_decimals':
        value = num(cents, 0, ',', '.');
        break;
      case 'amount_with_comma_separator':
        value = num(cents, 2, '.', ',');
        break;
      case 'amount_no_decimals_with_comma_separator':
        value = num(cents, 0, '.', ',');
        break;
      case 'amount_with_apostrophe_separator':
        value = num(cents, 2, "'", '.');
        break;
      case 'amount_no_decimals_with_space_separator':
        value = num(cents, 0, ' ', '.');
        break;
      case 'amount_with_space_separator':
        value = num(cents, 2, ' ', ',');
        break;
      default:
        value = num(cents, 2, ',', '.');
    }
    return format.replace(m[0], value).replace(/<[^>]*>/g, '');
  }
  function num(cents, precision, thousands, decimal) {
    var n = (cents / 100).toFixed(precision);
    var parts = n.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
    return parts.length > 1 ? parts[0] + decimal + parts[1] : parts[0];
  }

  function priceText(hit) {
    if (!cfg.showPrices || hit.price_min === undefined || hit.price_min === null) return '';
    var min = formatMoney(hit.price_min);
    if (hit.price_max !== undefined && hit.price_max !== null && hit.price_max > hit.price_min) {
      return min + ' – ' + formatMoney(hit.price_max);
    }
    return min;
  }

  function productUrl(hit) {
    return hit.url || '/products/' + encodeURIComponent(hit.handle);
  }

  function imageUrl(hit, width) {
    if (!hit.image_url) return '';
    return hit.image_url + (hit.image_url.indexOf('?') >= 0 ? '&' : '?') + 'width=' + width;
  }

  function fetchJSON(url, signal) {
    return fetch(url, { signal: signal, credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(
      function (res) {
        if (!res.ok) throw new Error('AI Search: HTTP ' + res.status);
        return res.json();
      },
    );
  }

  function proxyUrl(path, params) {
    var qs = Object.keys(params)
      .filter(function (k) {
        return params[k] !== undefined && params[k] !== null && params[k] !== '';
      })
      .map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      })
      .join('&');
    return PROXY + path + (qs ? '?' + qs : '');
  }

  function shadow(host) {
    var root = host.attachShadow({ mode: 'open' });
    if (cfg.cssUrl) root.appendChild(el('link', { rel: 'stylesheet', href: cfg.cssUrl }));
    // Theme CSS cannot cross the shadow boundary, so a merchant has no other
    // way to restyle the modal. The "Custom CSS" setting lands here, after
    // our own sheet, so an equal-specificity rule of theirs wins.
    if (cfg.customCss) {
      var style = document.createElement('style');
      style.setAttribute('data-ai-search', 'custom');
      style.textContent = String(cfg.customCss);
      root.appendChild(style);
    }
    return root;
  }

  // ---------- the runtime style probe (6.6, spec §3.2/§3.3) ----------
  //
  // Background, border, radius and shadow do not inherit across the shadow
  // boundary, so we sample them from the host theme once at boot and write
  // them onto every shadow host as --ais-* custom properties. Custom
  // properties DO inherit into a shadow tree, so the whole modal picks them up.
  //
  // We read RESOLVED values with getComputedStyle only. We never read a theme
  // token name: --color-background is not portable (Dawn stores it as the
  // triplet "255,255,255", so var(--color-background) yields an invalid value
  // and the CSS fallback never runs).
  //
  // Every token stays optional. ai-search.css carries the measured Horizon
  // value as the var() fallback, so a failed probe degrades to Horizon.

  function isTransparent(color) {
    if (!color) return true;
    var c = String(color).replace(/\s+/g, '').toLowerCase();
    if (c === 'transparent' || c === 'none') return true;
    // rgba(r,g,b,0) — any fully transparent colour
    var m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) {
      var parts = m[1].split(',');
      if (parts.length > 3 && Number(parts[3]) === 0) return true;
    }
    return false;
  }

  // rgb(17, 17, 17) -> rgba(17, 17, 17, alpha). Returns '' for any colour
  // syntax we cannot take apart (color(), oklch(), a named colour): the
  // caller then leaves the token unset and the CSS fallback runs.
  function atAlpha(color, alpha) {
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(String(color || ''));
    if (!m) return '';
    return 'rgba(' + m[1] + ', ' + m[2] + ', ' + m[3] + ', ' + alpha + ')';
  }

  function probeList(selector) {
    var out = [];
    if (!selector) return out;
    var found;
    try {
      found = document.querySelectorAll(selector);
    } catch (err) {
      return out; // a merchant typo must never take the modal down
    }
    for (var i = 0; i < found.length; i++) out.push(found[i]);
    return out;
  }

  var TOKENS = null;
  function themeTokens() {
    if (TOKENS) return TOKENS;
    TOKENS = {};
    if (!window.getComputedStyle) return TOKENS;
    // Order: the theme's own search dialog (or the merchant override), then
    // the site header, then document.body.
    var order = probeList(PROBE_DIALOG).concat(probeList(PROBE_HEADER));
    if (document.body) order.push(document.body);
    var fg = '';
    for (var i = 0; i < order.length; i++) {
      var s = window.getComputedStyle(order[i]);
      if (!s) continue;
      if (!fg && s.color) fg = s.color;
      // Skip a transparent background and walk on to the next source.
      if (isTransparent(s.backgroundColor)) continue;
      TOKENS['--ais-bg'] = s.backgroundColor;
      if (s.color) fg = s.color;
      break;
    }
    if (fg) {
      TOKENS['--ais-fg'] = fg;
      var border = atAlpha(fg, 0.14);
      if (border) TOKENS['--ais-border'] = border;
      var tint = atAlpha(fg, 0.06);
      if (tint) TOKENS['--ais-tint'] = tint;
    }
    // The theme's own primary button gives the "View all" pill and the radius.
    var buttons = probeList(PROBE_BUTTON);
    for (var j = 0; j < buttons.length; j++) {
      var b = window.getComputedStyle(buttons[j]);
      if (!b || isTransparent(b.backgroundColor)) continue;
      TOKENS['--ais-accent'] = b.backgroundColor;
      if (b.color) TOKENS['--ais-accent-fg'] = b.color;
      if (b.borderRadius && parseFloat(b.borderRadius) > 0) {
        TOKENS['--ais-radius'] = b.borderRadius;
      }
      break;
    }
    return TOKENS;
  }

  function applyTokens(host) {
    if (!host || !host.style || !host.style.setProperty) return;
    var map = themeTokens();
    Object.keys(map).forEach(function (name) {
      host.style.setProperty(name, map[name]);
    });
  }

  // A static-markup icon. createElement() cannot build SVG (wrong namespace),
  // so we hand the parser a fixed literal — no interpolation, ever.
  function magnifier() {
    var span = el('span', { class: 'ai-modal__icon', 'aria-hidden': 'true' });
    span.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round"><circle cx="11" cy="11" r="6.5"></circle>' +
      '<path d="M16 16l4.5 4.5"></path></svg>';
    return span;
  }

  // The product card. ONE builder, TWO surfaces — Phase 7 §5.7.
  //
  // Horizon lays the link over the card as an absolute overlay. We make the
  // card itself the <a>, because in the modal it is also our role=option and
  // the card holds nothing else clickable.
  //
  // The markup is identical on both surfaces. Six VALUES differ, and every one
  // of them lives in CSS, not here: the media ratio, the badge edge, the badge
  // blur, the title clamp, the price size and the hover rule. See section 5 of
  // ai-search.css.
  //
  // `option` is the only behavioural difference. The modal card is a listbox
  // option; the results-page card is a plain link.
  function productCard(hit, width, option) {
    var img =
      cfg.showImages && hit.image_url
        ? el('img', {
            class: 'ai-img',
            src: imageUrl(hit, width),
            alt: hit.image_alt || hit.title,
            loading: 'lazy',
          })
        : el('span', { class: 'ai-img ai-img--empty', 'aria-hidden': 'true' });
    var price = priceText(hit);
    return el('a', { class: option ? 'ai-card ai-option' : 'ai-card', href: productUrl(hit) }, [
      el('span', { class: 'ai-card__media' }, [
        img,
        hit.available === false ? el('span', { class: 'ai-badge', text: t('soldOut') }) : null,
      ]),
      el('span', { class: 'ai-card__content' }, [
        el('span', { class: 'ai-title', text: hit.title }),
        price ? el('span', { class: 'ai-price', text: price }) : null,
      ]),
    ]);
  }

  // ---------- 1. the search modal ----------
  //
  // Phase 6: one <dialog> per trigger, inside our own shadow root. The shell,
  // the header, the results grid and the floating footer copy Horizon —
  // specs/native-dropdown-parity/reference/measurements.md.
  //
  // The trigger takeover is document-level and capture-phase (6.5, §4.2). A
  // Dropdown is bound to one trigger: a theme search input keeps the combobox
  // ARIA, everything else (a header icon, a <summary>, a /search link) shares
  // the first instance and only supplies the focus-return target.

  var openDropdown = null; // only one open at a time
  var uid = 0;
  var instances = [];
  var closingNow = false; // focus return must not re-trigger the takeover

  function Dropdown(trigger) {
    this.trigger = trigger;
    this.isField = isTextField(trigger);
    this.form = (this.isField && trigger.form) || (trigger.closest && trigger.closest('form')) || null;
    this.id = 'ai-search-list-' + ++uid;
    this.host = el('div', { class: 'ai-search-host', 'data-ai-search': 'dropdown' });
    // Zero-size anchor: the dialog is either in the browser's top layer or, in
    // the fallback, a fixed overlay of its own. Nothing here takes space or
    // swallows a click.
    this.host.style.cssText =
      'display:none;position:fixed;inset-block-start:0;inset-inline-start:0;z-index:2147483000;';
    // 6.6 — sampled theme colours, written as --ais-* on the host. They
    // inherit into the shadow tree; a missing one falls back in the CSS.
    applyTokens(this.host);
    this.host.__aiSearchModal = true; // lets the capture handlers skip our own UI
    this.root = shadow(this.host);
    this.native = HAS_SHOW_MODAL;
    this.hits = [];
    this.active = -1;
    this.query = '';
    this.controller = null;
    this.timer = null;
    this.upgradeTimer = null;
    this.opener = null;
    this.closing = false;
    this.entered = false;
    this.build();
    document.body.appendChild(this.host);
    this.bind();
    instances.push(this);
  }

  // dialog > [status] > form > (header, panel > (scroll, footer))
  Dropdown.prototype.build = function () {
    var placeholder = t('searchPlaceholder') || 'Search';

    this.field = el('input', {
      type: 'search',
      name: 'q',
      class: 'ai-modal__input',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': this.id,
      'aria-label': placeholder,
      placeholder: placeholder,
    });
    this.clear = el('button', {
      type: 'button',
      class: 'ai-modal__clear',
      text: t('clear') || 'Clear',
      hidden: true,
    });
    this.closeBtn = el('button', {
      type: 'button',
      class: 'ai-modal__close',
      'aria-label': t('close') || 'Close',
      text: '×',
    });

    this.header = el('div', { class: 'ai-modal__header' }, [
      el('div', { class: 'ai-modal__field' }, [magnifier(), this.field, this.clear]),
      this.closeBtn,
    ]);

    this.status = el('div', { class: 'ai-visually-hidden', role: 'status', 'aria-live': 'polite' });
    this.inner = el('div', { class: 'ai-results-inner' });
    this.scroll = el('div', { class: 'ai-scroll' }, [this.inner]);
    this.viewAll = el('a', {
      class: 'ai-viewall ai-option',
      role: 'option',
      id: this.id + '-opt-all',
      'data-index': '0',
      'aria-selected': 'false',
      href: this.resultsHref(''),
    });
    this.footer = el('div', { class: 'ai-footer' }, [this.viewAll]);
    this.panel = el('div', {
      class: 'ai-panel',
      role: 'listbox',
      id: this.id,
      'data-state': 'blank',
    });
    this.panel.appendChild(this.scroll);
    this.panel.appendChild(this.footer);

    this.searchForm = el(
      'form',
      { class: 'ai-modal__form', role: 'search', method: 'get', action: cfg.searchUrl || '/search' },
      [this.header, this.panel],
    );
    this.dialog = el('dialog', { class: 'ai-modal', dir: pageDir(this.trigger), 'aria-label': placeholder }, [
      this.status,
      this.searchForm,
    ]);
    this.overlay = el('div', { class: 'ai-overlay' }, [this.dialog]);
    this.root.appendChild(this.overlay);
  };

  Dropdown.prototype.bind = function () {
    var self = this;
    var input = this.trigger;
    if (this.isField) {
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('role', 'combobox');

      // §4.4 — the shopper types in OUR input, so we no longer suppress the
      // theme's own field handlers. The Phase 4 stopImmediatePropagation calls
      // on `input`, `focus` and `keyup` are gone; the theme's predictive
      // dropdown is handled by the §4.3 predictive_selector rule instead.
      //
      // These two stay as a mirror, not as a silencer: they cover the narrow
      // case where text reaches the theme's field anyway (autofill, a theme
      // that re-focuses its own input, a synthetic event).
      input.addEventListener(
        'input',
        function () {
          self.field.value = input.value;
          self.onInput();
        },
        true,
      );
      input.addEventListener(
        'keydown',
        function (e) {
          self.onKeydown(e);
        },
        true,
      );
    }

    // ---- our own field owns the typing from here on ----
    this.field.addEventListener('input', function () {
      self.onInput();
    });
    this.field.addEventListener('keydown', function (e) {
      self.onKeydown(e);
    });
    this.clear.addEventListener('click', function () {
      self.field.value = '';
      self.query = '';
      self.abort();
      clearTimeout(self.timer);
      clearTimeout(self.upgradeTimer);
      self.showBlank();
      self.focusField();
    });
    this.closeBtn.addEventListener('click', function (e) {
      e.preventDefault();
      self.close();
    });
    // A click on the ::backdrop lands on the dialog itself; in the fallback it
    // lands on our overlay.
    this.dialog.addEventListener('mousedown', function (e) {
      if (e.target === self.dialog) self.close();
    });
    this.overlay.addEventListener('mousedown', function (e) {
      if (e.target === self.overlay) self.close();
    });
    this.dialog.addEventListener('cancel', function () {
      self.close();
    });
    this.dialog.addEventListener('close', function () {
      self.close();
    });

    this.panel.addEventListener('mousedown', function (e) {
      // keep the caret in our field while clicking a card
      if (e.target.closest && e.target.closest('a')) return;
      e.preventDefault();
    });
    this.panel.addEventListener('mousemove', function (e) {
      var opt = e.target.closest && e.target.closest('[role="option"]');
      if (opt) self.setActive(Number(opt.getAttribute('data-index')), false);
    });
  };

  Dropdown.prototype.value = function () {
    return this.field.value.replace(/\s+/g, ' ').trim();
  };

  Dropdown.prototype.announce = function (message) {
    var node = this.status;
    node.textContent = '';
    setTimeout(function () {
      node.textContent = message;
    }, 50);
  };

  Dropdown.prototype.onInput = function () {
    var self = this;
    var q = this.value();
    clearTimeout(this.timer);
    clearTimeout(this.upgradeTimer);
    this.open();
    this.syncClear();
    // Below minChars, and on an empty query: header and footer only. The modal
    // stays open — spec §7.
    if (q.length < (cfg.minChars || 1)) {
      this.abort();
      this.query = q;
      this.showBlank();
      return;
    }
    this.timer = setTimeout(function () {
      self.search(q, false);
    }, DEBOUNCE_MS);
  };

  Dropdown.prototype.syncClear = function () {
    if (this.field.value) this.clear.removeAttribute('hidden');
    else this.clear.setAttribute('hidden', '');
  };

  Dropdown.prototype.abort = function () {
    if (this.controller) this.controller.abort();
    this.controller = null;
  };

  Dropdown.prototype.search = function (q, isUpgrade) {
    var self = this;
    this.abort();
    var controller = new AbortController();
    this.controller = controller;
    this.query = q;
    fetchJSON(proxyUrl('/suggest', { q: q, limit: CARD_LIMIT }), controller.signal)
      .then(function (body) {
        if (controller !== self.controller) return; // superseded
        self.controller = null;
        if (self.value() !== q) return; // typed on
        self.render(body);
        if (!isUpgrade && body.semantic === 'timeout') {
          // Cold embedding cache: the vector is landing in the server's LRU
          // behind this answer — ask once more for the hybrid ranking.
          clearTimeout(self.upgradeTimer);
          self.upgradeTimer = setTimeout(function () {
            if (self.value() === q && self.isOpen()) self.search(q, true);
          }, UPGRADE_DELAY_MS);
        }
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (controller !== self.controller) return; // superseded
        self.controller = null;
        if (self.value() !== q) return; // typed on
        // §7: there is no separate error state. A proxy failure looks exactly
        // like an empty result, so the shopper never sees a broken app. The
        // footer "View all" still reaches the theme's search page.
        if (window.console && !self.loggedError) {
          self.loggedError = true;
          window.console.warn('AI Search: suggest failed', err);
        }
        self.renderEmpty();
      });
  };

  // Horizon's search URL, in every state — the way out when we have nothing.
  Dropdown.prototype.searchBase = function () {
    return (this.form && this.form.getAttribute('action')) || cfg.searchUrl || '/search';
  };

  Dropdown.prototype.resultsHref = function (q) {
    var base = this.searchBase();
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'q=' + encodeURIComponent(q || '');
  };

  // ---- panel states (6.7): blank | results | empty ----

  Dropdown.prototype.setState = function (state) {
    this.panel.setAttribute('data-state', state);
    this.inner.textContent = '';
    this.hits = [];
    this.active = -1;
    this.field.removeAttribute('aria-activedescendant');
    if (this.isField) this.trigger.removeAttribute('aria-activedescendant');
    // 6.11 — the entrance animation is a one-shot per open. Every re-render
    // starts without the class; render() puts it back only on the first one.
    this.panel.classList.remove('ai-enter');
    this.viewAll.setAttribute('href', this.resultsHref(this.query));
    this.viewAll.setAttribute('data-index', '0');
    this.viewAll.setAttribute('aria-selected', 'false');
    this.viewAll.classList.remove('is-active');
    // The footer is hidden in both non-results states, so the pill must leave
    // the listbox too — an arrow key must not land on an invisible option,
    // and in the blank state its href is /search?q= and means nothing.
    if (state === 'results') this.viewAll.setAttribute('role', 'option');
    else this.viewAll.removeAttribute('role');
    // 6.10 adds a dedicated "View all" string; until then reuse Phase 4's.
    this.viewAll.textContent = t('viewAll') || 'View all';
    this.searchForm.setAttribute('action', this.searchBase());
  };

  // Open with an empty (or too-short) query: header and footer only.
  Dropdown.prototype.showBlank = function () {
    this.setState('blank');
    this.setExpanded(false);
  };

  // No results — and, per §7, a failed or malformed answer too.
  Dropdown.prototype.renderEmpty = function () {
    var q = this.query;
    this.setState('empty');
    this.setExpanded(false);
    this.inner.appendChild(
      el('p', {
        class: 'ai-empty',
        dir: 'auto',
        text: t('noResultsFor', { query: q }) || t('noResults'),
      }),
    );
    // Horizon's live region drops the "Try another search." tail.
    this.announce(t('statusNoResults', { query: q }) || t('statusResults', { count: 0 }));
  };

  Dropdown.prototype.render = function (body) {
    var self = this;
    var hits = (body.hits || []).slice(0, CARD_LIMIT);
    this.query = this.value();
    if (!hits.length) {
      this.renderEmpty();
      return;
    }
    this.setState('results');
    this.hits = hits;
    var grid = el('div', { class: 'ai-products__grid' });
    hits.forEach(function (hit, i) {
      var a = productCard(hit, 400, true);
      a.setAttribute('role', 'option');
      a.setAttribute('id', self.id + '-opt-' + i);
      a.setAttribute('data-index', String(i));
      a.setAttribute('aria-selected', 'false');
      grid.appendChild(a);
    });
    this.inner.appendChild(
      el('div', { class: 'ai-products' }, [
        el('h4', { class: 'ai-products__title', text: t('productsHeading') || 'Products' }),
        grid,
      ]),
    );
    this.viewAll.setAttribute('data-index', String(hits.length));
    this.setExpanded(true);
    // 6.11 — the cards fade in and slide up, staggered behind the (absent)
    // query pills. Once per open: replaying it on every keystroke would blink
    // the whole grid, and §7 says a re-query must not clear what is on screen.
    if (!this.entered) {
      this.entered = true;
      this.panel.classList.add('ai-enter');
    }
    this.scroll.scrollTop = 0;
    // The count is the true total, not the number of cards — measurements §10.
    // Horizon announces the true total and the query, not the card count:
    // `10 search results found for "snowboard"` (reference/measurements.md §10).
    this.announce(
      t('statusResults', {
        count: body.total === undefined ? hits.length : body.total,
        query: this.query,
      }),
    );
  };

  // ---- open / close (6.4) ----

  Dropdown.prototype.open = function () {
    if (this.isOpen()) return;
    if (openDropdown && openDropdown !== this) openDropdown.close();
    openDropdown = this;
    // The focus-return target (§5). openFrom() records the real trigger; a
    // programmatic open falls back to our own field's trigger, never to
    // document.activeElement — that is usually <body>, which would also make
    // every outside click look like a click on the trigger.
    if (!this.opener && this.isField) this.opener = this.trigger;
    this.host.style.display = 'block';
    // aria-controls always points at the listbox; aria-expanded stays owned by
    // the panel state (setExpanded), because an open modal with a blank panel
    // is showing no options at all.
    if (this.isField) this.trigger.setAttribute('aria-controls', this.id);
    this.entered = false; // 6.11 — the entrance animation runs once per open
    if (this.native && this.dialog.showModal) {
      try {
        if (!this.dialog.open) this.dialog.showModal();
      } catch (err) {
        this.native = false;
      }
    }
    if (!this.native) this.openFallback();
    // §4.3 guard 2 — belt and braces for a theme that opens its drawer on
    // pointerdown or through a router we never see. Once, on open only: we are
    // already marked open above, so the focus churn this causes cannot
    // re-enter the takeover.
    closeThemeContainers();
    watchThemeContainers(true);
    this.syncClear();
    this.focusField();
  };

  // §4.2/§4.4 — a trigger opened us. Seed our field from the trigger (its
  // current text, or the character that opened the modal), then let §7 pick
  // the panel state.
  Dropdown.prototype.openFrom = function (trigger, seed) {
    this.opener = trigger || document.activeElement;
    if (seed !== undefined && seed !== null) this.field.value = seed;
    this.open();
    this.focusField();
    if (this.value()) this.onInput();
    else this.showBlank();
    this.syncClear();
  };

  // No HTMLDialogElement.prototype.showModal: mount a plain overlay and trap
  // focus ourselves (spec §4.1, acceptance A8).
  Dropdown.prototype.openFallback = function () {
    var self = this;
    this.dialog.setAttribute('open', '');
    this.overlay.classList.add('is-fallback');
    if (!this.trap) {
      this.trap = function (e) {
        if (e.key !== 'Tab') return;
        var items = self.dialog.querySelectorAll(FOCUSABLE);
        if (!items.length) return;
        var first = items[0];
        var last = items[items.length - 1];
        var current = self.root.activeElement || document.activeElement;
        if (e.shiftKey && current === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && current === last) {
          e.preventDefault();
          first.focus();
        }
      };
    }
    this.dialog.addEventListener('keydown', this.trap);
  };

  Dropdown.prototype.focusField = function () {
    try {
      this.field.focus();
    } catch (err) {
      /* jsdom / detached host */
    }
  };

  Dropdown.prototype.close = function () {
    if (!this.isOpen()) return;
    this.closing = true; // native focus return must not re-trigger the trigger
    closingNow = true;
    watchThemeContainers(false);
    clearTimeout(this.upgradeTimer);
    // Set this first: dialog.close() fires a synchronous "close" event that
    // calls us again, and isOpen() is the recursion guard.
    this.host.style.display = 'none';
    this.setExpanded(false);
    this.field.removeAttribute('aria-activedescendant');
    this.panel.classList.remove('ai-enter');
    this.entered = false;
    this.active = -1;
    if (this.native && this.dialog.close) {
      try {
        if (this.dialog.open) this.dialog.close();
      } catch (err) {
        /* already closed */
      }
    } else {
      this.dialog.removeAttribute('open');
      this.overlay.classList.remove('is-fallback');
      if (this.trap) this.dialog.removeEventListener('keydown', this.trap);
    }
    // §5 — focus returns to the trigger that opened us. showModal() restores
    // it for us in a real browser, but only to whatever had focus before, and
    // the fallback path does nothing at all. Do it explicitly, from the
    // trigger we recorded, and guard the takeover while we do (closingNow).
    var back = this.opener || (this.isField ? this.trigger : null);
    this.opener = null;
    if (back && typeof back.focus === 'function' && back.isConnected !== false) {
      try {
        back.focus();
      } catch (err) {
        /* gone */
      }
    }
    if (openDropdown === this) openDropdown = null;
    this.closing = false;
    closingNow = false;
  };

  Dropdown.prototype.isOpen = function () {
    return this.host.style.display !== 'none';
  };

  Dropdown.prototype.options = function () {
    return this.panel.querySelectorAll('[role="option"]');
  };

  // The product cards, in DOM order. options() is cards-then-"View all",
  // because the grid sits in the scroller and the footer comes after it.
  Dropdown.prototype.cardCount = function () {
    return this.panel.querySelectorAll('.ai-card[role="option"]').length;
  };

  // §5 — the live column count, re-read at every keystroke, never cached.
  // A missing or unmeasurable grid degrades to 1, which turns ArrowDown/Up
  // back into the flat one-card-at-a-time walk.
  Dropdown.prototype.columns = function () {
    var grid = this.panel.querySelector('.ai-products__grid');
    if (!grid || !window.getComputedStyle) return 1;
    var cs;
    try {
      cs = window.getComputedStyle(grid);
    } catch (err) {
      return 1;
    }
    if (!cs) return 1;
    var raw = cs.gridTemplateColumns;
    if (!raw && cs.getPropertyValue) raw = cs.getPropertyValue('grid-template-columns');
    var n = parseGridColumns(raw);
    return n > 0 ? n : 1;
  };

  // §5/§6 — reading order depends on the RESOLVED direction of the dialog,
  // never on a config guess. The dir attribute on the dialog is the value that
  // actually applied (pageDir() already resolved "auto" against the page, and
  // §6 puts dir on the dialog and nowhere else). Custom CSS can still force
  // rtl on top of it, so a computed direction of "rtl" wins.
  Dropdown.prototype.isRtl = function () {
    if (window.getComputedStyle) {
      var cs;
      try {
        cs = window.getComputedStyle(this.dialog);
      } catch (err) {
        cs = null;
      }
      if (cs && String(cs.direction).toLowerCase() === 'rtl') return true;
    }
    var attr = String(this.dialog.getAttribute('dir') || '').toLowerCase();
    if (attr === 'rtl' || attr === 'ltr') return attr === 'rtl';
    return false;
  };

  // aria-expanded is true exactly when options are showing — so the blank and
  // the no-results states are both false. The theme's own field is a combobox
  // too (we set the role in bind()), so it mirrors ours.
  Dropdown.prototype.setExpanded = function (on) {
    this.field.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (this.isField) {
      this.trigger.setAttribute('aria-expanded', on ? 'true' : 'false');
      this.trigger.setAttribute('aria-controls', this.id);
      if (!on) this.trigger.removeAttribute('aria-activedescendant');
    }
  };

  // §5 — ArrowDown/ArrowUp move one ROW. The "View all" pill is the last
  // option and its own last row, so a step down past the final row of cards
  // lands on it. A step past either outer edge returns to -1, the input, which
  // is where the shopper edits the query; the next step wraps round again.
  Dropdown.prototype.moveRow = function (delta) {
    var opts = this.options();
    if (!opts.length) return;
    var last = opts.length - 1;
    var cards = this.cardCount();
    var i = this.active;
    var next;
    if (i < 0) {
      next = delta > 0 ? 0 : last;
    } else if (i >= cards) {
      // On "View all" (or any trailing non-card option).
      next = delta > 0 ? -1 : cards ? cards - 1 : -1;
    } else {
      next = i + delta * this.columns();
      if (next >= cards) next = last >= cards ? last : -1;
      else if (next < 0) next = -1;
    }
    this.setActive(next, true);
  };

  Dropdown.prototype.setActive = function (index, scroll) {
    var opts = this.options();
    if (!opts.length) return;
    if (index < -1) index = opts.length - 1;
    if (index >= opts.length) index = -1;
    this.active = index;
    for (var i = 0; i < opts.length; i++) {
      var on = i === index;
      opts[i].setAttribute('aria-selected', on ? 'true' : 'false');
      opts[i].classList.toggle('is-active', on);
      if (on && scroll && opts[i].scrollIntoView) opts[i].scrollIntoView({ block: 'nearest' });
    }
    // Our input and our options now share a shadow root, so
    // aria-activedescendant finally works — Phase 4 had to announce instead.
    // It points at the active option's id, and it is REMOVED when none is
    // active. The theme's own field is a combobox too, so it mirrors.
    if (index >= 0) {
      this.field.setAttribute('aria-activedescendant', opts[index].id);
      if (this.isField) this.trigger.setAttribute('aria-activedescendant', opts[index].id);
    } else {
      this.field.removeAttribute('aria-activedescendant');
      if (this.isField) this.trigger.removeAttribute('aria-activedescendant');
    }
  };

  // §4.4 — stopPropagation, never stopImmediatePropagation. We keep the key
  // away from the theme's document-level handlers but we no longer suppress a
  // handler the theme bound to its own field.
  Dropdown.prototype.onKeydown = function (e) {
    var open = this.isOpen();
    var mine = e.target === this.field;
    switch (e.key) {
      case 'ArrowDown':
        if (!open && this.hits.length) this.open();
        e.preventDefault();
        e.stopPropagation();
        this.moveRow(1);
        return;
      case 'ArrowUp':
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        this.moveRow(-1);
        return;
      // §5 — one CARD in reading order. Under dir=rtl the two keys swap, so
      // ArrowLeft moves forward. They only take the key once the grid already
      // has an active card: before that the arrows still move the caret, which
      // is the only way the shopper can edit the query they just typed.
      case 'ArrowRight':
      case 'ArrowLeft':
        if (!open || this.active < 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.setActive(this.active + ((e.key === 'ArrowRight') !== this.isRtl() ? 1 : -1), true);
        return;
      // §5 — first card / last option. Same caret rule as the two above.
      case 'Home':
        if (!open || this.active < 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.setActive(0, true);
        return;
      case 'End':
        if (!open || this.active < 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.setActive(this.options().length - 1, true);
        return;
      case 'Escape':
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        this.close();
        return;
      case 'Enter':
        e.stopPropagation(); // theme must not hijack the submit
        if (open && this.active >= 0) {
          var opt = this.options()[this.active];
          if (opt && opt.getAttribute('href')) {
            e.preventDefault();
            window.location.assign(opt.getAttribute('href'));
          }
          return;
        }
        // No active option: our own form submits to the results page; the
        // theme's trigger form does the same on its side.
        if (!mine) this.close();
        return;
      case 'Tab':
        // <dialog> owns Tab inside the modal — §5. Only the theme trigger
        // still closes on Tab.
        if (!mine && !this.native) this.close();
        return;
      default:
        return;
    }
  };

  var dropdowns = new WeakMap();
  function attachDropdown(input) {
    if (dropdowns.has(input)) return dropdowns.get(input);
    var dd = new Dropdown(input);
    dropdowns.set(input, dd);
    return dd;
  }

  function attachAll(rootNode) {
    var scope = rootNode || document;
    var inputs = scope.querySelectorAll ? scope.querySelectorAll(INPUT_SELECTOR) : [];
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].type === 'hidden') continue;
      attachDropdown(inputs[i]);
    }
  }

  // A search field gets its own Dropdown, so the combobox ARIA lands on the
  // element the shopper's screen reader is already on. Every other trigger —
  // an icon, a <summary>, a /search link — shares one modal.
  function dropdownFor(trigger) {
    if (isTextField(trigger)) return attachDropdown(trigger);
    if (instances.length) return instances[0];
    return attachDropdown(trigger);
  }

  // ---------- 1b. the trigger takeover (6.5, spec §4.2/§4.3/§4.4) ----------
  //
  // Three listeners on `document`, in the CAPTURE phase, so they run before
  // the theme's own handlers and the theme's search UI never opens. Per §4.2
  // this is one step earlier than Phase 4's per-input interception: we take
  // the trigger, not the field, so we never have to fight the theme's input
  // handlers.

  function isTextField(node) {
    if (!node || node.nodeType !== 1 || !node.tagName) return false;
    var tag = node.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var type = String(node.getAttribute('type') || 'text').toLowerCase();
    return (
      type !== 'hidden' &&
      type !== 'checkbox' &&
      type !== 'radio' &&
      type !== 'submit' &&
      type !== 'button' &&
      type !== 'image' &&
      type !== 'file'
    );
  }

  function isEditable(node) {
    return isTextField(node) || (node && node.isContentEditable === true);
  }

  function matchesTrigger(node) {
    if (!node || node.nodeType !== 1 || !node.matches) return false;
    try {
      return node.matches(TRIGGER_SELECTOR);
    } catch (err) {
      return false; // a merchant typo must never take search down
    }
  }

  function eventPath(e) {
    return e.composedPath ? e.composedPath() : [e.target];
  }

  // Our own modal lives in a shadow root, so at document level the event
  // retargets to the host. Walk the composed path instead: it gives us both
  // the real target and a way to recognise our own UI.
  function isOurs(path) {
    for (var i = 0; i < path.length; i++) {
      if (path[i] && path[i].__aiSearchModal) return true;
    }
    return false;
  }

  // Our own light-DOM output (the proxy-mode results page and its "load more"
  // link) points at /apps/search, so it matches a[href*="/search"]. It is not
  // a trigger — checked before the trigger test, on the way up.
  var NOT_TRIGGER = '[data-ai-search-more], [data-ai-search-page]';

  function triggerInPath(path) {
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node === document || node === window) return null;
      if (node && node.nodeType === 1 && node.matches && node.matches(NOT_TRIGGER)) return null;
      if (matchesTrigger(node)) return node;
    }
    return null;
  }

  // §4.3 guard 2 — some themes open their drawer on pointerdown, or through a
  // router we never see. When our modal opens, close any open <dialog> or
  // <details> in the light DOM that carries a search trigger. Once, on open
  // only: Dropdown.open() returns early when it is already open.
  function closeThemeContainers() {
    var nodes;
    try {
      nodes = document.querySelectorAll('dialog[open], details[open]');
    } catch (err) {
      return;
    }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var holds = matchesTrigger(n);
      if (!holds) {
        try {
          holds = !!n.querySelector(TRIGGER_SELECTOR);
        } catch (err) {
          holds = false;
        }
      }
      if (!holds) continue;
      if (n.tagName === 'DIALOG' && typeof n.close === 'function') {
        try {
          n.close();
        } catch (err) {
          n.removeAttribute('open');
        }
      } else {
        n.removeAttribute('open');
      }
    }
  }

  // §4.3 guard 3. Closing the theme's containers once, at our open, only helps
  // when they are already open. A theme can open its own search dialog AFTER
  // ours — through a router, a delayed component upgrade, or a path our
  // capture-phase handlers never see. When that happens its ::backdrop paints
  // over our modal (the whole panel greys out) and its header lands on top of
  // ours, so the shopper sees two search bars. So we watch while we are open.
  var themeWatch = null;
  function watchThemeContainers(on) {
    if (!on) {
      if (themeWatch) themeWatch.disconnect();
      themeWatch = null;
      return;
    }
    if (themeWatch || typeof MutationObserver !== 'function' || !document.documentElement) return;
    themeWatch = new MutationObserver(function () {
      if (stale()) {
        watchThemeContainers(false);
        return;
      }
      // Converges: closeThemeContainers only closes containers that hold a
      // search trigger, and a closed one no longer matches dialog[open].
      closeThemeContainers();
    });
    try {
      themeWatch.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['open'],
        subtree: true,
      });
    } catch (err) {
      themeWatch = null;
    }
  }

  // click → preventDefault, stopPropagation, open our modal, focus our input.
  document.addEventListener(
    'click',
    function (e) {
      if (stale()) return;
      if (e.button && e.button !== 0) return;
      if (e.defaultPrevented) return;
      // cmd/ctrl/shift-click on a link is "open the search page in a new
      // tab/window". Leave it to the browser.
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      var path = eventPath(e);
      if (isOurs(path)) return;
      var trigger = triggerInPath(path);
      if (!trigger) return;
      e.preventDefault();
      e.stopPropagation();
      var dd = dropdownFor(trigger);
      dd.openFrom(trigger, isTextField(trigger) ? trigger.value || '' : undefined);
    },
    true,
  );

  // focusin → the shopper reached the theme's search field (tab, autofocus, a
  // drawer that focuses it on open). Open our modal and move focus to OUR
  // input. Only a field does this: a focused button must stay tabbable.
  document.addEventListener(
    'focusin',
    function (e) {
      if (stale() || closingNow) return; // ours, or a superseded run
      var path = eventPath(e);
      if (isOurs(path)) return;
      var target = path[0] || e.target;
      if (!isTextField(target) || !matchesTrigger(target)) return;
      var dd = dropdownFor(target);
      if (dd.isOpen()) return;
      dd.openFrom(target, target.value || '');
    },
    true,
  );

  // keydown → the theme's own keyboard shortcut ("/" or cmd/ctrl+K), and the
  // §4.4 first-character carry: a printable key pressed on a trigger that is
  // not a field opens the modal with that character already typed.
  document.addEventListener(
    'keydown',
    function (e) {
      if (stale()) return;
      if (openDropdown) return; // the open modal owns its own keys
      if (e.defaultPrevented) return;
      var path = eventPath(e);
      if (isOurs(path)) return;
      var target = path[0] || e.target;
      var shortcut =
        (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable(target)) ||
        ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K'));
      var trigger = triggerInPath(path);
      var printable = e.key && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
      var carry = trigger && !isTextField(trigger) && printable;
      if (!shortcut && !carry) return;
      e.preventDefault();
      e.stopPropagation();
      var dd = dropdownFor(trigger || document.body);
      dd.openFrom(trigger || document.activeElement, carry ? e.key : '');
    },
    true,
  );

  document.addEventListener(
    'mousedown',
    function (e) {
      if (stale() || !openDropdown) return;
      var path = eventPath(e);
      if (isOurs(path) || path.indexOf(openDropdown.host) >= 0) return;
      if (openDropdown.trigger && path.indexOf(openDropdown.trigger) >= 0) return;
      if (openDropdown.opener && path.indexOf(openDropdown.opener) >= 0) return;
      openDropdown.close();
    },
    true,
  );

  // ---------- 3a. proxy mode: send the theme's search forms to /apps/search ----------

  function rewriteForms(scope) {
    var forms = (scope || document).querySelectorAll(FORM_SELECTOR);
    for (var i = 0; i < forms.length; i++) {
      var f = forms[i];
      if (f.getAttribute('data-ai-search-rewritten')) continue;
      f.setAttribute('data-ai-search-original-action', f.getAttribute('action') || '');
      f.setAttribute('action', PROXY);
      f.setAttribute('method', 'get');
      f.setAttribute('data-ai-search-rewritten', '1');
    }
  }

  // ---------- 2. results block ----------
  //
  // Phase 7: the search results page copies Horizon, the same way Phase 6's
  // modal does. Reference: specs/search-results-parity/reference/measurements.md.
  //
  // What we copy: the heading, the field, the count, the grid, the card, the
  // zero-results sentence. What we leave out, and why, is in the spec: the
  // filter/sort/density row (§2.1, it needs server work) and the zero-results
  // fallback grid (§3.2 B, we have no second list).
  //
  // The block still lives in a shadow root behind the merchant's app block —
  // §2.2. So the theme cannot restyle it, and `custom_css` is the way in.

  function ResultsBlock(container) {
    this.container = container;
    this.endpoint = container.getAttribute('data-endpoint') || PROXY + '/results';
    this.limit = Number(container.getAttribute('data-limit')) || 24;
    this.query = new URLSearchParams(window.location.search).get('q') || cfg.searchTerms || '';
    this.query = this.query.replace(/\s+/g, ' ').trim();
    this.page = 0;
    this.announced = false;
    applyTokens(container); // 6.6 — same sampled tokens as the modal
    // 7.7 / §6.4 — the Phase 6 takeover binds a CAPTURE-phase focusin on
    // `document` and opens the modal for anything that matches a search
    // trigger. focusin composes, so composedPath() reaches our own field
    // inside this shadow root. isOurs() skips a path that carries this flag.
    // Without it every click on our own field opens the modal over the page.
    container.__aiSearchModal = true;
    this.root = shadow(container);
    this.wrap = el('div', { class: 'ai-results', dir: pageDir(container) });
    this.root.appendChild(this.wrap);
    this.render();
  }

  ResultsBlock.prototype.render = function () {
    var self = this;
    var c = this.container;
    this.wrap.textContent = '';
    var page = el('div', { class: 'ai-page' });
    this.wrap.appendChild(page);

    // The heading never prints the query, and its text depends on whether
    // there is one: "Search results" with, "Search" without (measurements §3).
    page.appendChild(
      el('h1', {
        class: 'ai-heading',
        text: this.query ? t('searchResults') : t('searchHeading'),
      }),
    );

    if (c.getAttribute('data-show-form') !== 'false') page.appendChild(this.field());

    // Horizon carries role=status on the count element itself and announces
    // the count alone — "11 items", not the query (measurements §5).
    this.count = el('p', { class: 'ai-count', role: 'status' });
    if (c.getAttribute('data-show-count') !== 'false') page.appendChild(this.count);

    // Zero results (§6.1) and the loading line share this slot. It is empty
    // in every other state, and CSS hides it when empty.
    this.note = el('p', { class: 'ai-empty' });
    page.appendChild(this.note);

    this.grid = el('div', { class: 'ai-grid' });
    page.appendChild(this.grid);

    // The error line is separate from the note: it is assertive, it survives
    // a re-render of the note, and §6.2 keeps it when the modal has none.
    this.status = el('p', { class: 'ai-status', role: 'alert' });
    page.appendChild(this.status);

    this.more = el('button', { type: 'button', class: 'ai-more', text: t('loadMore') });
    this.more.style.display = 'none';
    this.more.addEventListener('click', function () {
      self.load();
    });
    page.appendChild(this.more);

    if (this.query) this.load();
  };

  // The Horizon field: a magnifier, the input, and a reset control that shows
  // only when the field holds a value (measurements §4). No visible submit
  // button — Enter submits, as it does on Horizon.
  ResultsBlock.prototype.field = function () {
    var input = el('input', {
      type: 'search',
      name: 'q',
      class: 'ai-input',
      value: this.query,
      placeholder: t('searchPlaceholder'),
      'aria-label': t('searchPlaceholder'),
      autocomplete: 'off',
    });
    var icon = magnifier();
    icon.className = 'ai-field__icon';
    var reset = el('button', {
      type: 'button',
      class: 'ai-field__reset',
      'aria-label': t('clear'),
      text: '×',
    });
    reset.style.display = this.query ? '' : 'none';
    reset.addEventListener('click', function () {
      input.value = '';
      reset.style.display = 'none';
      input.focus();
    });
    input.addEventListener('input', function () {
      reset.style.display = input.value ? '' : 'none';
    });
    var form = el('form', { class: 'ai-form', action: cfg.searchUrl || '/search', method: 'get', role: 'search' }, [
      el('div', { class: 'ai-field' }, [icon, input, reset]),
    ]);
    // 7.7 / §6.4 — Horizon's results-page field is a plain inline form. It
    // submits; it does NOT open the search modal. So no attachDropdown here.
    return form;
  };

  ResultsBlock.prototype.load = function () {
    var self = this;
    var page = this.page + 1;
    this.status.textContent = '';
    if (page === 1) this.note.textContent = t('loading');
    this.more.disabled = true;
    fetchJSON(this.endpoint + '?' + 'q=' + encodeURIComponent(this.query) + '&page=' + page + '&limit=' + this.limit)
      .then(function (body) {
        self.page = page;
        self.more.disabled = false;
        var hits = body.hits || [];
        hits.forEach(function (hit) {
          self.grid.appendChild(productCard(hit, 500, false));
        });
        if (page === 1) self.first(body, hits);
        self.more.style.display = body.has_more ? '' : 'none';
      })
      .catch(function () {
        self.fail();
      });
  };

  // Page one decides the state. Later pages only append cards, and they must
  // not re-announce: the total has not changed, and a second announcement is
  // noise for a screen-reader user (§6.3).
  ResultsBlock.prototype.first = function (body, hits) {
    this.note.textContent = '';
    if (!hits.length) {
      // Zero results (§6.1). Horizon adds a fallback grid of the store's
      // products here; we have no second list, so we print the sentence
      // alone — spec §3.2 B.
      this.note.textContent = t('pageNoResults', { query: this.query });
      this.count.textContent = '';
      return;
    }
    if (this.announced) return;
    this.announced = true;
    this.count.textContent = t('itemsCount', { count: body.total });
  };

  // Never a blank page: bring the theme's own results back and say so.
  ResultsBlock.prototype.fail = function () {
    var styleId = this.container.getAttribute('data-native-style');
    var style = styleId && document.getElementById(styleId);
    if (style) style.parentNode.removeChild(style);
    this.note.textContent = '';
    this.more.disabled = false;
    this.more.style.display = 'none';
    var href = (cfg.searchUrl || '/search') + '?q=' + encodeURIComponent(this.query) + '&ai=0';
    this.status.textContent = '';
    this.status.appendChild(el('span', { text: t('error') + ' ' }));
    this.status.appendChild(el('a', { href: href, text: t('nativeLink') }));
  };

  // ---------- 3b. proxy mode: enhance the server-rendered /apps/search page ----------

  function enhanceProxyPage(page) {
    var more = page.querySelector('[data-ai-search-more]');
    var grid = page.querySelector('[data-ai-search-grid]');
    if (!more || !grid) return;
    var endpoint = page.getAttribute('data-endpoint') || PROXY + '/results';
    var q = page.getAttribute('data-query') || '';
    var limit = Number(page.getAttribute('data-limit')) || 24;
    var current = Number(page.getAttribute('data-page')) || 1;
    more.addEventListener('click', function (e) {
      e.preventDefault();
      more.setAttribute('aria-busy', 'true');
      fetchJSON(endpoint + '?q=' + encodeURIComponent(q) + '&page=' + (current + 1) + '&limit=' + limit)
        .then(function (body) {
          current += 1;
          (body.hits || []).forEach(function (hit) {
            var li = el('li', { class: 'ai-search-item' });
            var a = el('a', { class: 'ai-search-link', href: productUrl(hit) }, [
              hit.image_url
                ? el('img', { class: 'ai-search-image', src: imageUrl(hit, 400), alt: hit.image_alt || hit.title, loading: 'lazy' })
                : el('span', { class: 'ai-search-image ai-search-image--empty', 'aria-hidden': 'true' }),
              hit.available === false ? el('span', { class: 'ai-search-badge', text: t('soldOut') }) : null,
              el('span', { class: 'ai-search-title', text: hit.title }),
              priceText(hit) ? el('span', { class: 'ai-search-price', text: priceText(hit) }) : null,
            ]);
            li.appendChild(a);
            grid.appendChild(li);
          });
          more.removeAttribute('aria-busy');
          if (!body.has_more) more.style.display = 'none';
          else more.setAttribute('href', PROXY + '?q=' + encodeURIComponent(q) + '&page=' + (current + 1));
        })
        .catch(function () {
          more.removeAttribute('aria-busy');
          // leave the plain link in place — it still paginates without JS
        });
    });
  }

  // ---------- boot ----------

  function boot() {
    attachAll(document);
    if (cfg.resultsMode === 'proxy') rewriteForms(document);

    // ?ai=0 — the escape hatch our own error state links to: show the
    // theme's native results and stay out of the way on this page.
    var nativeRequested = new URLSearchParams(window.location.search).get('ai') === '0';
    var blocks = nativeRequested ? [] : document.querySelectorAll('[data-ai-search-results]');
    for (var i = 0; i < blocks.length; i++) new ResultsBlock(blocks[i]);
    if (!blocks.length) {
      // No block on this page: make sure a stray hide-style never blanks it.
      var stray = document.getElementById('ai-search-hide-native');
      if (stray) stray.parentNode.removeChild(stray);
    } else if (cfg.nativeResultsSelector) {
      var override = el('style', { text: cfg.nativeResultsSelector + '{display:none !important}' });
      document.head.appendChild(override);
    }

    var pages = document.querySelectorAll('[data-ai-search-page]');
    for (var j = 0; j < pages.length; j++) enhanceProxyPage(pages[j]);

    // Themes that render search UI late (drawers, lazy sections).
    if (window.MutationObserver) {
      var pending = null;
      var observer = new MutationObserver(function () {
        if (stale()) {
          observer.disconnect();
          return;
        }
        if (pending) return;
        pending = setTimeout(function () {
          pending = null;
          // The run guard again. The observer stands down the moment the stamp
          // moves on, but a debounce it had already scheduled would still fire
          // — and attachAll() would then build a SECOND Dropdown on a field the
          // live run already owns, whose bind() resets the field's combobox
          // ARIA underneath it. Stand down here too.
          if (stale()) return;
          attachAll(document);
          if (cfg.resultsMode === 'proxy') rewriteForms(document);
        }, 100);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
