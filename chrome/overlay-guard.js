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
// edge. It is hidden with visibility, so it keeps its box and is given back as soon as it
// no longer covers the player (the page scrolled, the player became the miniplayer).
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

  // The part of the iframe that is on screen, and its area.
  function visibleBox(iframe) {
    const r = iframe.getBoundingClientRect();
    const box = {
      left: Math.max(0, r.left),
      top: Math.max(0, r.top),
      right: Math.min(window.innerWidth, r.right),
      bottom: Math.min(window.innerHeight, r.bottom),
    };
    box.area = Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
    return box;
  }

  function overlap(r, box) {
    return Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)) *
        Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
  }

  function belongsToPlayer(el, box) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    const inside = overlap(r, box);
    return area > 0 && (inside >= 0.8 * area || inside >= 0.5 * box.area);
  }

  // The elements painted over the iframe that belong to the player's area, each the
  // outermost one below the ancestor they share with the iframe.
  function overlaysOf(iframe, box) {
    const picks = new Set();
    const players = [...document.querySelectorAll(`iframe[src^="${PLAYER_URL}"]`)];
    // Every element, not only the body's: ad layers are often put straight into <html>.
    for (const el of document.querySelectorAll('*')) {
      if (el === iframe || el.contains(iframe) || iframe.contains(el) || isPlayerFrame(el)) continue;
      // Inside one already picked, which goes as a whole.
      if ([...picks].some((pick) => pick.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || overlap(r, box) < 16) continue;
      // Painted above the iframe where the two overlap?
      const x = (Math.max(r.left, box.left) + Math.min(r.right, box.right)) / 2;
      const y = (Math.max(r.top, box.top) + Math.min(r.bottom, box.bottom)) / 2;
      const stack = document.elementsFromPoint(x, y);
      const iframeAt = stack.indexOf(iframe);
      const elAt = stack.indexOf(el);
      if (iframeAt === -1 || elAt === -1 || elAt > iframeAt) continue;
      // Its ancestors go with it while they are painted above the iframe too. A layout
      // wrapper under the player that holds an ad over it (and the page's nav) stays.
      let pick = null;
      for (let a = el; a && !a.contains(iframe); a = a.parentElement) {
        const at = stack.indexOf(a);
        if (at === -1 || at > iframeAt) break;
        if (belongsToPlayer(a, box) && !players.some((player) => a.contains(player))) {
          pick = a;
        }
      }
      if (pick) picks.add(pick);
    }
    return [...picks].filter((el) => ![...picks].some((other) => other !== el && other.contains(el)));
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
    const box = visibleBox(iframe);
    for (const el of [...guard.hidden.keys()]) {
      if (!el.isConnected || box.area === 0 || !belongsToPlayer(el, box)) show(guard, el);
    }
    if (box.area === 0) return;
    for (const el of overlaysOf(iframe, box)) hide(guard, el);
  }

  function release(iframe) {
    const guard = guards.get(iframe);
    if (!guard) return;
    clearInterval(guard.timer);
    guards.delete(iframe);
    for (const el of [...guard.hidden.keys()]) show(guard, el);
  }

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
