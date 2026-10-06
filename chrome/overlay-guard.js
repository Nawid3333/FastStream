// Keeps a site's own overlays off FastStream's player, for content.js.
//
// FastStream's player is an iframe in the frame whose video it replaced, and each frame
// above sees it through the iframe of the frame below. Whatever a site lays over its video
// - its control bar, a big play button, a "server" menu, an ad layer - it lays over that
// iframe too, so it lay over FastStream's player: on sites that embed their player in a
// full-page iframe, the embedding page's bar stayed on top of FastStream.
//
// While a player is up, each frame of its chain hides what it paints over the iframe it
// holds, and gives it back when the player goes (releaseAll, from removePlayers) or the
// iframe does. An element counts as the player's when it is painted above the iframe and
// at least 80% of it lies inside the iframe's box, or it covers half of that box: a bar or
// a button on the player, or a layer over it, but not a page header that overlaps its top
// edge. The box is the whole iframe's, on screen or not: measured by its part on screen,
// a header over a player scrolled mostly out of view covered "half" of it. A site's own
// dialog (sign-in, cookie consent, settings) is left alone, though it covers the player as
// an ad layer does: hidden, the user saw no dialog, and clicks went through its backdrop.
// It is hidden with visibility, so it keeps its box and is given back as soon as it no
// longer covers the player (the page scrolled, the player became the miniplayer).
// eslint-disable-next-line no-unused-vars
const OverlayGuard = (() => {
  // How often a guarded frame looks again: sites add their overlays late (ads keep coming).
  // A check goes through the whole page: about 1 ms for 1,500 elements, 10 ms for 20,000.
  const CHECK_MS = 1000;
  // iframe -> {src, timer, hidden: Map<element, {value, priority}>}
  const guards = new Map();
  const PLAYER_URL = chrome.runtime.getURL('player/');

  function isPlayerFrame(el) {
    return el.tagName === 'IFRAME' && (el.src || '').startsWith(PLAYER_URL);
  }

  // A web-component player keeps its control bar in its shadow root, next to the player
  // FastStream put there: document.querySelectorAll('*') never saw the bar, and contains()
  // stops at the shadow boundary (#233).

  // Every element of the page, those in shadow roots (open or closed) too.
  function allElements(root = document, found = []) {
    for (const el of root.querySelectorAll('*')) {
      found.push(el);
      // Firefox lets a content script into closed roots too.
      const shadow = el.openOrClosedShadowRoot || el.shadowRoot;
      if (shadow) allElements(shadow, found);
    }
    return found;
  }

  // The element above, across a shadow root's boundary to its host.
  function parentOf(el) {
    return el.parentElement || el.parentNode?.host || null;
  }

  // Whether `inner` is `outer` or inside it, shadow roots included.
  function holds(outer, inner) {
    for (let el = inner; el; el = parentOf(el)) {
      if (el === outer) return true;
    }
    return false;
  }

  // The iframe's box (full) and the part of it that is on screen (visible), with their areas.
  function boxesOf(iframe) {
    const r = iframe.getBoundingClientRect();
    const full = {left: r.left, top: r.top, right: r.right, bottom: r.bottom, area: r.width * r.height};
    const visible = {
      left: Math.max(0, r.left),
      top: Math.max(0, r.top),
      right: Math.min(window.innerWidth, r.right),
      bottom: Math.min(window.innerHeight, r.bottom),
    };
    visible.area = Math.max(0, visible.right - visible.left) * Math.max(0, visible.bottom - visible.top);
    return {full, visible};
  }

  function overlap(r, box) {
    return Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)) *
        Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
  }

  function belongsToPlayer(el, full) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    const inside = overlap(r, full);
    return area > 0 && (inside >= 0.8 * area || inside >= 0.5 * full.area);
  }

  const DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

  // The element with the focus, inside shadow roots too: document.activeElement gives a
  // field in a shadow root as its host.
  function focused() {
    let active = document.activeElement;
    for (;;) {
      const root = active && (active.openOrClosedShadowRoot || active.shadowRoot);
      if (!root || !root.activeElement) return active;
      active = root.activeElement;
    }
  }

  function isEditable(el) {
    return el.matches('input, textarea, select') || !!el.isContentEditable;
  }

  // A site's own dialog, or a layer holding one, or one the user is typing in: by what it
  // says it is, or by a field in it having the focus. Geometry cannot tell it from an ad
  // layer. Only a field: a link or a button keeps the focus after a click, and an ad layer
  // the user clicked once (or a click-to-play cover) then stayed over the player for good,
  // taking every click meant for it.
  function isSiteDialog(el) {
    const active = focused();
    return el.matches(DIALOGS) || !!el.querySelector(DIALOGS) ||
        (!!active && active !== document.body && isEditable(active) && holds(el, active));
  }

  // The elements painted over the iframe that belong to the player's area, each the
  // outermost one below the ancestor they share with the iframe.
  function overlaysOf(iframe, {full, visible: box}) {
    const picks = new Set();
    const everything = allElements();
    const players = everything.filter(isPlayerFrame);
    // The document's elementsFromPoint gives a shadow root's elements as their host: the
    // iframe's own root gives the iframe, and the elements of its shadow root.
    const root = iframe.getRootNode();
    const stackRoot = typeof root.elementsFromPoint === 'function' ? root : document;
    // Every element, not only the body's: ad layers are often put straight into <html>.
    for (const el of everything) {
      if (el === iframe || holds(el, iframe) || isPlayerFrame(el)) continue;
      // Inside one already picked, which goes as a whole.
      if ([...picks].some((pick) => holds(pick, el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || overlap(r, box) < 16) continue;
      // Painted above the iframe where the two overlap?
      const x = (Math.max(r.left, box.left) + Math.min(r.right, box.right)) / 2;
      const y = (Math.max(r.top, box.top) + Math.min(r.bottom, box.bottom)) / 2;
      const stack = stackRoot.elementsFromPoint(x, y);
      const iframeAt = stack.indexOf(iframe);
      const elAt = stack.indexOf(el);
      if (iframeAt === -1 || elAt === -1 || elAt > iframeAt) continue;
      // Its ancestors go with it while they are painted above the iframe too. A layout
      // wrapper under the player that holds an ad over it (and the page's nav) stays. One
      // missing from the stack says nothing of where it is painted: pointer-events: none,
      // as a see-through veil holding a clickable ad has. It goes by its size, as before.
      let pick = null;
      for (let a = el; a && !holds(a, iframe); a = parentOf(a)) {
        if (stack.indexOf(a) > iframeAt) break;
        // Nothing of a site's dialog goes: not the dialog, nor what holds it.
        if (isSiteDialog(a)) {
          pick = null;
          break;
        }
        if (belongsToPlayer(a, full) && !players.some((player) => holds(a, player))) {
          pick = a;
        }
      }
      if (pick) picks.add(pick);
    }
    return [...picks].filter((el) => ![...picks].some((other) => other !== el && holds(other, el)));
  }

  function hide(guard, el) {
    // One guard holds an element: a second one (another player's, in the same page) would
    // take the first one's "hidden" for the page's own value and put it back for good.
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

  function check(iframe) {
    const guard = guards.get(iframe);
    if (!guard) return;
    if (!iframe.isConnected || iframe.src !== guard.src) {
      release(iframe);
      return;
    }
    // Nothing is painted in a hidden tab: the whole-page look waits until it shows again
    // (visibilitychange, below).
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

  function release(iframe) {
    const guard = guards.get(iframe);
    if (!guard) return;
    clearInterval(guard.timer);
    guards.delete(iframe);
    for (const el of [...guard.hidden.keys()]) show(guard, el);
  }

  // A tab shown again is looked at at once, not at the next check: what a site laid over
  // the player while the tab was hidden goes before it is seen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const iframe of [...guards.keys()]) check(iframe);
  });

  return {
    // The iframe holds FastStream's player, or a frame that does.
    guard(iframe) {
      if (!iframe || guards.has(iframe)) return;
      guards.set(iframe, {src: iframe.src, timer: setInterval(() => check(iframe), CHECK_MS), hidden: new Map()});
      check(iframe);
    },
    releaseAll() {
      for (const iframe of [...guards.keys()]) release(iframe);
    },
  };
})();
