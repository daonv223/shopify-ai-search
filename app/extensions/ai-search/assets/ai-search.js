/*
 * AI Search — storefront client (theme app extension, Phase 4 spec §3.2/§3.3).
 *
 * Loaded by the app embed on every page (window.AISearchConfig is written by
 * blocks/embed.liquid). Plain ES2019, no build step, no dependencies.
 *
 *  1. Type-ahead: finds the theme's search inputs (Dawn's <predictive-search>
 *     modal, the search-template input, any form[action*="/search"]
 *     input[name="q"]), silences the theme's own predictive handlers on
 *     those inputs (capture-phase stopImmediatePropagation on input/focus
 *     and the keys we own), and mounts our dropdown in a Shadow DOM host
 *     anchored under the input. Debounce 150ms, AbortController per
 *     keystroke, ArrowUp/Down + Enter, Escape, click-outside, ARIA combobox
 *     + live region. A response with semantic:"timeout" (cold embedding
 *     cache — phase4-notes.md) triggers ONE upgrade re-fetch ~600ms later if
 *     the query is unchanged, swapping in the hybrid ranking.
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

  var PROXY = cfg.proxy || '/apps/search';
  var TEXT = cfg.text || {};
  var DEBOUNCE_MS = 150;
  var UPGRADE_DELAY_MS = 600;
  var INPUT_SELECTOR = cfg.inputSelector || 'form[action*="/search"] input[name="q"]';
  var FORM_SELECTOR = cfg.formSelector || 'form[action*="/search"]';

  // ---------- small helpers ----------

  function t(key, vars) {
    var s = TEXT[key] || '';
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
    return root;
  }

  var liveRegion = null;
  function announce(message) {
    if (!liveRegion) {
      liveRegion = el('div', {
        role: 'status',
        'aria-live': 'polite',
        class: 'ai-search-visually-hidden',
        style: 'position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;',
      });
      document.body.appendChild(liveRegion);
    }
    liveRegion.textContent = '';
    setTimeout(function () {
      liveRegion.textContent = message;
    }, 50);
  }

  function card(hit, opts) {
    var img = cfg.showImages && hit.image_url
      ? el('img', { class: 'ai-img', src: imageUrl(hit, opts.width), alt: hit.image_alt || hit.title, loading: 'lazy' })
      : el('span', { class: 'ai-img ai-img--empty', 'aria-hidden': 'true' });
    var price = priceText(hit);
    return el('a', { class: 'ai-card', href: productUrl(hit) }, [
      el('span', { class: 'ai-media' }, [
        img,
        hit.available === false ? el('span', { class: 'ai-badge', text: t('soldOut') }) : null,
      ]),
      el('span', { class: 'ai-title', text: hit.title }),
      price ? el('span', { class: 'ai-price', text: price }) : null,
    ]);
  }

  // ---------- 1. type-ahead dropdown ----------

  var openDropdown = null; // only one open at a time
  var uid = 0;

  function Dropdown(input) {
    this.input = input;
    this.form = input.form || input.closest('form');
    this.id = 'ai-search-list-' + ++uid;
    this.host = el('div', { class: 'ai-search-host', 'data-ai-search': 'dropdown' });
    this.host.style.cssText = 'position:fixed;z-index:2147483000;display:none;';
    this.root = shadow(this.host);
    this.panel = el('div', { class: 'ai-panel', dir: 'rtl', role: 'listbox', id: this.id });
    this.root.appendChild(this.panel);
    document.body.appendChild(this.host);
    this.hits = [];
    this.active = -1;
    this.query = '';
    this.controller = null;
    this.timer = null;
    this.upgradeTimer = null;
    this.swallowNextKeyup = false;
    this.bind();
  }

  Dropdown.prototype.bind = function () {
    var self = this;
    var input = this.input;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('role', 'combobox');

    // Capture-phase listeners on the target run before the theme's own
    // (bubble/target) listeners — this is what silences Dawn's
    // <predictive-search> without touching theme code.
    input.addEventListener(
      'input',
      function (e) {
        e.stopImmediatePropagation();
        self.onInput();
      },
      true,
    );
    input.addEventListener(
      'focus',
      function (e) {
        e.stopImmediatePropagation();
        if (self.hits.length && input.value.trim() === self.query) self.open();
        else self.onInput();
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
    input.addEventListener(
      'keyup',
      function (e) {
        if (self.swallowNextKeyup && e.key === 'Escape') {
          self.swallowNextKeyup = false;
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      },
      true,
    );
    this.panel.addEventListener('mousedown', function (e) {
      // keep focus in the input while clicking a suggestion
      if (e.target.closest && e.target.closest('a')) return;
      e.preventDefault();
    });
    this.panel.addEventListener('mousemove', function (e) {
      var opt = e.target.closest && e.target.closest('[role="option"]');
      if (opt) self.setActive(Number(opt.getAttribute('data-index')), false);
    });
  };

  Dropdown.prototype.onInput = function () {
    var self = this;
    var q = this.input.value.replace(/\s+/g, ' ').trim();
    clearTimeout(this.timer);
    clearTimeout(this.upgradeTimer);
    if (q.length < (cfg.minChars || 1)) {
      this.abort();
      this.close();
      this.query = q;
      return;
    }
    this.timer = setTimeout(function () {
      self.search(q, false);
    }, DEBOUNCE_MS);
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
    fetchJSON(proxyUrl('/suggest', { q: q, limit: cfg.maxSuggestions || 6 }), controller.signal)
      .then(function (body) {
        if (controller !== self.controller) return; // superseded
        self.controller = null;
        if (self.input.value.replace(/\s+/g, ' ').trim() !== q) return; // typed on
        self.render(body);
        if (!isUpgrade && body.semantic === 'timeout') {
          // Cold embedding cache: the vector is landing in the server's LRU
          // behind this answer — ask once more for the hybrid ranking.
          clearTimeout(self.upgradeTimer);
          self.upgradeTimer = setTimeout(function () {
            if (self.input.value.replace(/\s+/g, ' ').trim() === q && document.activeElement === self.input) {
              self.search(q, true);
            }
          }, UPGRADE_DELAY_MS);
        }
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        // Fail closed and quiet: no dropdown, native form submit still works.
        self.close();
      });
  };

  Dropdown.prototype.render = function (body) {
    var self = this;
    var hits = (body.hits || []).slice(0, cfg.maxSuggestions || 6);
    this.hits = hits;
    this.active = -1;
    this.panel.textContent = '';
    if (!hits.length) {
      this.close();
      announce(t('statusResults', { count: 0 }));
      return;
    }
    var list = el('div', { class: 'ai-list' });
    hits.forEach(function (hit, i) {
      var a = card(hit, { width: 120 });
      a.setAttribute('role', 'option');
      a.setAttribute('id', self.id + '-opt-' + i);
      a.setAttribute('data-index', String(i));
      a.setAttribute('aria-selected', 'false');
      a.className += ' ai-option';
      list.appendChild(a);
    });
    this.panel.appendChild(list);
    var all = el('a', {
      class: 'ai-show-all ai-option',
      role: 'option',
      id: this.id + '-opt-all',
      'data-index': String(hits.length),
      'aria-selected': 'false',
      href: this.resultsHref(this.query),
      text: t('showAll', { query: this.query }),
    });
    this.panel.appendChild(all);
    this.open();
    announce(t('statusResults', { count: hits.length }));
  };

  Dropdown.prototype.resultsHref = function (q) {
    var base = this.form ? this.form.getAttribute('action') || cfg.searchUrl || '/search' : cfg.searchUrl || '/search';
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'q=' + encodeURIComponent(q);
  };

  Dropdown.prototype.position = function () {
    var r = this.input.getBoundingClientRect();
    var width = Math.max(r.width, 280);
    var left = r.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
    this.host.style.top = r.bottom + 4 + 'px';
    this.host.style.left = left + 'px';
    this.host.style.width = Math.min(width, window.innerWidth - 16) + 'px';
    this.panel.style.maxHeight = Math.max(160, window.innerHeight - r.bottom - 24) + 'px';
  };

  Dropdown.prototype.open = function () {
    if (openDropdown && openDropdown !== this) openDropdown.close();
    openDropdown = this;
    this.position();
    this.host.style.display = 'block';
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-controls', this.id);
    if (!this.reposition) {
      var self = this;
      this.reposition = function () {
        if (openDropdown === self) self.position();
      };
      window.addEventListener('scroll', this.reposition, true);
      window.addEventListener('resize', this.reposition);
    }
  };

  Dropdown.prototype.close = function () {
    clearTimeout(this.upgradeTimer);
    this.host.style.display = 'none';
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.active = -1;
    if (openDropdown === this) openDropdown = null;
  };

  Dropdown.prototype.isOpen = function () {
    return this.host.style.display !== 'none';
  };

  Dropdown.prototype.options = function () {
    return this.panel.querySelectorAll('[role="option"]');
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
    // aria-activedescendant cannot cross the shadow boundary; the live
    // region carries the active title instead.
    if (index >= 0) announce(opts[index].textContent.trim());
  };

  Dropdown.prototype.onKeydown = function (e) {
    var open = this.isOpen();
    switch (e.key) {
      case 'ArrowDown':
        if (!open && this.hits.length) this.open();
        e.preventDefault();
        e.stopImmediatePropagation();
        this.setActive(this.active + 1, true);
        return;
      case 'ArrowUp':
        if (!open) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.setActive(this.active - 1, true);
        return;
      case 'Escape':
        if (!open) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.swallowNextKeyup = true; // keep Dawn's modal open on the same keystroke
        this.close();
        return;
      case 'Enter':
        e.stopImmediatePropagation(); // theme must not hijack the submit
        if (open && this.active >= 0) {
          var opt = this.options()[this.active];
          if (opt && opt.getAttribute('href')) {
            e.preventDefault();
            window.location.assign(opt.getAttribute('href'));
          }
          return;
        }
        // No active option: let the form submit to the results page.
        this.close();
        return;
      case 'Tab':
        this.close();
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

  document.addEventListener(
    'mousedown',
    function (e) {
      if (!openDropdown) return;
      var path = e.composedPath ? e.composedPath() : [e.target];
      if (path.indexOf(openDropdown.host) >= 0 || path.indexOf(openDropdown.input) >= 0) return;
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

  function ResultsBlock(container) {
    this.container = container;
    this.endpoint = container.getAttribute('data-endpoint') || PROXY + '/results';
    this.limit = Number(container.getAttribute('data-limit')) || 24;
    this.query = new URLSearchParams(window.location.search).get('q') || cfg.searchTerms || '';
    this.query = this.query.replace(/\s+/g, ' ').trim();
    this.page = 0;
    this.root = shadow(container);
    this.wrap = el('div', { class: 'ai-results', dir: 'rtl' });
    this.root.appendChild(this.wrap);
    this.render();
  }

  ResultsBlock.prototype.render = function () {
    var self = this;
    var c = this.container;
    this.wrap.textContent = '';
    if (c.getAttribute('data-show-form') !== 'false') {
      var input = el('input', {
        type: 'search',
        name: 'q',
        class: 'ai-input',
        value: this.query,
        placeholder: t('searchPlaceholder'),
        'aria-label': t('searchPlaceholder'),
        autocomplete: 'off',
      });
      var form = el('form', { class: 'ai-form', action: cfg.searchUrl || '/search', method: 'get', role: 'search' }, [
        input,
        el('button', { type: 'submit', class: 'ai-button', text: t('searchButton') }),
      ]);
      this.wrap.appendChild(form);
      attachDropdown(input);
    }
    var heading = c.getAttribute('data-heading');
    if (heading) this.wrap.appendChild(el('h1', { class: 'ai-heading', text: heading }));
    if (this.query) {
      this.wrap.appendChild(el('p', { class: 'ai-subheading', text: t('resultsFor', { query: this.query }) }));
    }
    this.count = el('p', { class: 'ai-count' });
    if (c.getAttribute('data-show-count') !== 'false') this.wrap.appendChild(this.count);
    this.status = el('p', { class: 'ai-status', role: 'status' });
    this.wrap.appendChild(this.status);
    this.grid = el('div', { class: 'ai-grid' });
    this.wrap.appendChild(this.grid);
    this.more = el('button', { type: 'button', class: 'ai-button ai-more', text: t('loadMore') });
    this.more.style.display = 'none';
    this.more.addEventListener('click', function () {
      self.load();
    });
    this.wrap.appendChild(this.more);
    if (this.query) this.load();
  };

  ResultsBlock.prototype.load = function () {
    var self = this;
    var page = this.page + 1;
    this.status.textContent = t('loading');
    this.more.disabled = true;
    fetchJSON(this.endpoint + '?' + 'q=' + encodeURIComponent(this.query) + '&page=' + page + '&limit=' + this.limit)
      .then(function (body) {
        self.page = page;
        self.status.textContent = '';
        self.more.disabled = false;
        (body.hits || []).forEach(function (hit) {
          self.grid.appendChild(card(hit, { width: 400 }));
        });
        if (page === 1) {
          if (!body.hits || !body.hits.length) {
            self.status.textContent = t('noResults');
            self.count.textContent = '';
          } else {
            self.count.textContent = t('resultsCount', { count: body.total });
          }
        }
        self.more.style.display = body.has_more ? '' : 'none';
      })
      .catch(function () {
        self.fail();
      });
  };

  // Never a blank page: bring the theme's own results back and say so.
  ResultsBlock.prototype.fail = function () {
    var styleId = this.container.getAttribute('data-native-style');
    var style = styleId && document.getElementById(styleId);
    if (style) style.parentNode.removeChild(style);
    this.status.textContent = '';
    this.more.style.display = 'none';
    var href = (cfg.searchUrl || '/search') + '?q=' + encodeURIComponent(this.query) + '&ai=0';
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
      new MutationObserver(function () {
        if (pending) return;
        pending = setTimeout(function () {
          pending = null;
          attachAll(document);
          if (cfg.resultsMode === 'proxy') rewriteForms(document);
        }, 100);
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
