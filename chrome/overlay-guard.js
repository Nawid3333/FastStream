// @ts-check
// Hides a site's overlays painted over FastStream's player iframe, for content.js.
// eslint-disable-next-line no-unused-vars
const OverlayGuard = (() => {
  // Sites add their overlays late (ads keep coming).
  const CHECK_MS = 1000;
  /**
   * A box on screen, in CSS pixels.
   * @typedef {{left: number, top: number, right: number, bottom: number, area: number}} Box
   */
  /** @typedef {{src: string, timer: ReturnType<typeof setInterval>, hidden: Map<Styled, {value: string, priority: string}>}} Guard */
  /** @typedef {Element & ElementCSSInlineStyle} Styled */
  /** @typedef {Element & {openOrClosedShadowRoot?: ?ShadowRoot}} ShadowHost */
  /** @type {Map<HTMLIFrameElement, Guard>} */
  const guards = new Map();
  const PLAYER_URL = chrome.runtime.getURL('player/');

  /** @param {Element & {src?: string}} el */
  function isPlayerFrame(el) {
    return el.tagName === 'IFRAME' && (el.src || '').startsWith(PLAYER_URL);
  }

  // Every element, in open and closed shadow roots too: a web-component player's bar is in one.
  /**
   * @param {Document|ShadowRoot} root
   * @param {Element[]} found
   */
  function allElements(root = document, found = []) {
    for (const el of root.querySelectorAll('*')) {
      found.push(el);
      // Firefox lets a content script into closed roots too.
      const shadow = /** @type {ShadowHost} */ (el).openOrClosedShadowRoot || el.shadowRoot;
      if (shadow) allElements(shadow, found);
    }
    return found;
  }

  /** @param {Element} el */
  function parentOf(el) {
    return /** @type {Element} */ (el.parentElement || /** @type {ShadowRoot|null} */ (el.parentNode)?.host || null);
  }

  // Whether `inner` is `outer` or inside it, shadow roots included.
  /**
   * @param {Element} outer
   * @param {Element} inner
   */
  function holds(outer, inner) {
    for (let el = inner; el; el = parentOf(el)) {
      if (el === outer) return true;
    }
    return false;
  }

  // The iframe's box (full) and the part of it that is on screen (visible), with their areas.
  /** @param {HTMLIFrameElement} iframe */
  function boxesOf(iframe) {
    const r = iframe.getBoundingClientRect();
    const full = {left: r.left, top: r.top, right: r.right, bottom: r.bottom, area: r.width * r.height};
    const visible = /** @type {Box} */ ({
      left: Math.max(0, r.left),
      top: Math.max(0, r.top),
      right: Math.min(window.innerWidth, r.right),
      bottom: Math.min(window.innerHeight, r.bottom),
    });
    visible.area = Math.max(0, visible.right - visible.left) * Math.max(0, visible.bottom - visible.top);
    return {full, visible};
  }

  /**
   * @param {DOMRect} r
   * @param {Box} box
   */
  function overlap(r, box) {
    return Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)) *
        Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
  }

  /**
   * @param {Element} el
   * @param {Box} full
   */
  function belongsToPlayer(el, full) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    const inside = overlap(r, full);
    return area > 0 && (inside >= 0.8 * area || inside >= 0.5 * full.area);
  }

  const DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

  // document.activeElement gives a field in a shadow root as its host.
  function focused() {
    let active = document.activeElement;
    for (;;) {
      const root = active && (/** @type {ShadowHost} */ (active).openOrClosedShadowRoot || active.shadowRoot);
      if (!root || !root.activeElement) return active;
      active = root.activeElement;
    }
  }

  /** @param {Element & {isContentEditable?: boolean}} el */
  function isEditable(el) {
    return el.matches('input, textarea, select') || !!el.isContentEditable;
  }

  // By role, or by a focused field: a link or a button keeps the focus after a click.
  /** @param {Element} el */
  function isSiteDialog(el) {
    const active = focused();
    const hasBox = (/** @type {Element} */ e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const shown = (/** @type {Element} */ d) => hasBox(d) || Array.from(d.children).some(hasBox);
    return el.matches(DIALOGS) || Array.from(el.querySelectorAll(DIALOGS)).some(shown) ||
        (!!active && active !== document.body && isEditable(active) && holds(el, active));
  }

  // The outermost elements painted over the iframe that belong to the player's area.
  /**
   * @param {HTMLIFrameElement} iframe
   * @param {{full: Box, visible: Box}} param0
   */
  function overlaysOf(iframe, {full, visible: box}) {
    const picks = /** @type {Element[]} */ ([]);
    const everything = allElements();
    const players = everything.filter(isPlayerFrame);
    // The iframe's own root: the document's elementsFromPoint gives a shadow root's elements as their host.
    const root = /** @type {Document|ShadowRoot} */ (iframe.getRootNode());
    const stackRoot = typeof root.elementsFromPoint === 'function' ? root : document;
    // Every element, not only the body's: ad layers are often put straight into <html>.
    for (const el of everything) {
      if (el === iframe || holds(el, iframe) || isPlayerFrame(el)) continue;
      if (picks.some((pick) => holds(pick, el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || overlap(r, box) < 16) continue;
      const x = (Math.max(r.left, box.left) + Math.min(r.right, box.right)) / 2;
      const y = (Math.max(r.top, box.top) + Math.min(r.bottom, box.bottom)) / 2;
      const stack = stackRoot.elementsFromPoint(x, y);
      const iframeAt = stack.indexOf(iframe);
      const elAt = stack.indexOf(el);
      if (iframeAt === -1 || elAt === -1 || elAt > iframeAt) continue;
      // Ancestors go too while painted above the iframe; one missing from the stack goes by its size.
      let pick = /** @type {Element|null} */ (null);
      for (let a = el; a && !holds(a, iframe); a = parentOf(a)) {
        if (stack.indexOf(a) > iframeAt) break;
        if (isSiteDialog(a)) {
          pick = null;
          break;
        }
        if (belongsToPlayer(a, full) && !players.some((player) => holds(a, player))) {
          pick = a;
        }
      }
      if (pick && !picks.includes(pick)) picks.push(pick);
    }
    return /** @type {Styled[]} */ (picks.filter((el) => !picks.some((other) => other !== el && holds(other, el))));
  }

  /**
   * @param {Guard} guard
   * @param {Styled} el
   */
  function hide(guard, el) {
    // One guard per element: a second would take the first's "hidden" for the page's own value.
    for (const other of guards.values()) {
      if (other !== guard && other.hidden.has(el)) return;
    }
    if (!guard.hidden.has(el)) {
      guard.hidden.set(el, {
        value: el.style.getPropertyValue('visibility'),
        priority: el.style.getPropertyPriority('visibility'),
      });
    }
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  /**
   * @param {Guard} guard
   * @param {Styled} el
   */
  function show(guard, el) {
    const saved = guard.hidden.get(el);
    guard.hidden.delete(el);
    if (!saved) return;
    if (saved.value) {
      el.style.setProperty('visibility', saved.value, saved.priority);
    } else {
      el.style.removeProperty('visibility');
    }
  }

  /** @param {HTMLIFrameElement} iframe */
  function check(iframe) {
    const guard = guards.get(iframe);
    if (!guard) return;
    if (!iframe.isConnected || iframe.src !== guard.src) {
      release(iframe);
      return;
    }
    if (document.hidden) return;
    const boxes = boxesOf(iframe);
    for (const el of [...guard.hidden.keys()]) {
      if (!el.isConnected || boxes.visible.area === 0 || !belongsToPlayer(el, boxes.full) || isSiteDialog(el)) {
        show(guard, el);
      }
    }
    if (boxes.visible.area === 0) return;
    for (const el of overlaysOf(iframe, boxes)) hide(guard, el);
  }

  /** @param {HTMLIFrameElement} iframe */
  function release(iframe) {
    const guard = guards.get(iframe);
    if (!guard) return;
    clearInterval(guard.timer);
    guards.delete(iframe);
    for (const el of [...guard.hidden.keys()]) show(guard, el);
  }

  PageListeners.add(document, 'visibilitychange', () => {
    if (document.hidden) return;
    for (const iframe of [...guards.keys()]) check(iframe);
  });

  return {
    // The iframe holds FastStream's player, or a frame that does.
    /** @param {HTMLIFrameElement} iframe */
    guard(iframe) {
      if (!iframe || guards.has(iframe)) return;
      guards.set(iframe, {src: iframe.src, timer: setInterval(() => check(iframe), CHECK_MS), hidden: new Map()});
      check(iframe);
    },
    // The player under the iframe went, the iframe stays (RELEASE_OVERLAY_GUARD).
    /** @param {HTMLIFrameElement} iframe */
    release(iframe) {
      release(iframe);
    },
    releaseAll() {
      for (const iframe of [...guards.keys()]) release(iframe);
    },
    // For content.js, which runs after this script in the same frame (the manifest's order).
    focused,
    allElements,
  };
})();
