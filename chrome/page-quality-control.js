// @ts-check
// A page player's qualities that only its own menu knows (the files do not exist until the player picks one):
// read from the menu, opened by script when it is built only on opening, and switched there. For content.js.
// eslint-disable-next-line no-unused-vars
const PageQualityControl = (() => {
  /**
   * @typedef {{label: string, height: number, auto: boolean, selected: boolean}} Choice
   * @typedef {{el: Element, target: HTMLElement, label: string, height: number, auto: boolean, selected: boolean}} Item
   * @typedef {{items: Item[], container: Element, opened: boolean}} Group
   * @typedef {{name: string, tag: string}} Step - A control found again by its name, for a later switch.
   * @typedef {{video: HTMLVideoElement, path: Step[], labels: string[], items: ?Item[]}} Found
   */

  // Words a quality control or its row is named with, in FastStream's languages and the players' own.
  const QUALITY_WORDS = ['quality', 'resolution', 'definition', 'rendition', 'source quality', 'video quality',
    'qualität', 'auflösung', 'calidad', 'resolución', 'qualité', 'résolution', 'kualitas', 'kualiti', 'resolusi',
    'qualità', 'risoluzione', '画質', '解像度', '品質', '화질', '해상도', 'kwaliteit', 'resolutie', 'jakość',
    'rozdzielczość', 'qualidade', 'resolução', 'качество', 'разрешение', 'kalite', 'çözünürlük', '画质', '清晰度',
    '分辨率', '畫質', '解析度'];
  const SETTINGS_WORDS = ['settings', 'setting', 'options', 'einstellungen', 'ajustes', 'configuración',
    'paramètres', 'réglages', 'pengaturan', 'setelan', 'tetapan', 'impostazioni', '設定', '설정', 'instellingen',
    'ustawienia', 'configurações', 'definições', 'настройки', 'ayarlar', '设置'];
  // Controls that are never a quality menu: clicking them would change something else. Whole words.
  const OTHER_WORDS = /\b(subtitles?|captions?|audio|speed|share|download|cast|airplay|pip|picture.in.picture|full ?screen|volume|mute|unmute|play|pause|next|previous|prev|close|report|log ?in|sign ?in|episodes?|servers?|chapters?|loop|sleep|mirror|brightness|aspect)\b/i;
  const AUTO_WORDS = ['auto', 'automatic', 'automatisch', 'automatique', 'automático', 'automatico', 'otomatis',
    'otomatik', 'автоматически', 'авто', '自动', '自動', '자동'];
  const WORD_HEIGHTS = {'8k': 4320, '4k': 2160, 'uhd': 2160, '2k': 1440, 'qhd': 1440, 'full hd': 1080, 'fhd': 1080,
    'hd': 720, 'sd': 480, 'ld': 360};
  const BARE_HEIGHTS = new Set([144, 180, 240, 270, 288, 360, 404, 432, 480, 540, 576, 720, 768, 800, 900, 1080, 1200,
    1440, 1600, 2160, 2880, 4320]);
  const CLICKABLE = 'button, [role=button], [role=menuitem], [role=menuitemradio], [role=option], [role=radio], ' +
    '[role=tab], li, label, [tabindex], [aria-haspopup]';
  const SELECTED_CLASS = /(^|[\s_-])(active|selected|current|checked|chosen)($|[\s_-])/i;
  // A quality list is short.
  const MAX_ITEMS = 12;
  // How far up from the video a player's own controls are looked for.
  const PLAYER_DEPTH = 8;
  const STEP_WAIT_MS = 1500;
  const CHANGE_WAIT_MS = 5000;
  const METADATA_WAIT_MS = 3000;

  /**
   * What a quality label names: "1080p", "1080p60", "720p (2.5 Mbps)", "1080p HDR", "4K", "Auto (720p)".
   * The whole text must be the label: a sentence with "1080p" in it is no menu entry.
   * @param {*} text
   * @return {?{height: number, auto: boolean, bare: boolean}} Bare: a number without its "p".
   */
  function qualityLabel(text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 32) return null;
    const lower = t.toLowerCase();
    if (AUTO_WORDS.some((word) => lower === word || lower.startsWith(word + ' ') || lower.startsWith(word + '('))) {
      return {height: 0, auto: true, bare: false};
    }
    const word = lower.replace(/\+$/, '').trim();
    if (word in WORD_HEIGHTS) return {height: WORD_HEIGHTS[/** @type {keyof typeof WORD_HEIGHTS} */ (word)], auto: false, bare: false};
    const core = lower
        .replace(/\([^()]{0,24}\)/g, ' ')
        .replace(/\b(hdr10\+?|hdr|sdr|dolby vision|hd\+?|fhd|full hd|uhd|qhd|8k|4k|2k|\d{2,3} ?fps|fps)\b/g, ' ')
        .replace(/[•·|–—,-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const match = /^(\d{3,4}) ?([pi])?(\d{2,3})?$/.exec(core);
    if (!match) return null;
    const height = parseInt(match[1], 10);
    if (height < 144 || height > 4320) return null;
    // Without its "p", only a height videos have: a list of years or episodes is no quality menu.
    if (!match[2] && (match[3] || !BARE_HEIGHTS.has(height))) return null;
    return {height, auto: false, bare: !match[2]};
  }

  /** @param {Node} el @return {string} The element's own text, without its children's. */
  function ownText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.textContent;
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  /** @param {Element} el @return {string} What a control is called: its text, else its label or title. */
  function nameOf(el) {
    const text = ownText(el) || (/** @type {HTMLElement} */ (el).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return (text.length <= 40 ? text : '') || el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('data-title') || el.getAttribute('data-tooltip') || '';
  }

  /** @param {Element} el @return {string} Its class, id and data-* values, for icon-only controls. */
  function keysOf(el) {
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    let keys = `${cls} ${el.id}`;
    for (const attribute of el.attributes) {
      if (attribute.name.startsWith('data-')) keys += ` ${attribute.name} ${attribute.value}`;
    }
    return keys.toLowerCase();
  }

  /**
   * @param {string} text
   * @param {string[]} words
   * @return {boolean}
   */
  function hasWord(text, words) {
    const lower = text.toLowerCase();
    return words.some((word) => lower.includes(word));
  }

  /** @param {Element} el @return {?Element} Its parent, through a shadow root to its host. */
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  /**
   * Every element below a root, open shadow roots included.
   * @param {Element|Document} root
   * @return {Element[]}
   */
  function allBelow(root) {
    /** @type {Element[]} */
    const out = [];
    /** @param {Element|Document|ShadowRoot} node */
    const walk = (node) => {
      for (const el of node.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  }

  /** @param {Element} el @return {boolean} FastStream's own player frame, which nothing here touches. */
  function isOwn(el) {
    return el.tagName === 'IFRAME' && /^(moz|chrome)-extension:/.test(/** @type {HTMLIFrameElement} */ (el).src);
  }

  /**
   * The player around a video: its ancestors up to PLAYER_DEPTH, without the page's body.
   * @param {HTMLVideoElement} video
   * @return {Element}
   */
  function playerRoot(video) {
    /** @type {Element} */
    let root = video;
    let el = parentOf(video);
    for (let depth = 0; el && depth < PLAYER_DEPTH && el.tagName !== 'BODY' && el.tagName !== 'HTML'; depth++) {
      root = el;
      el = parentOf(el);
    }
    return root;
  }

  /**
   * The element a click goes to: a control around the label, not above the item's list.
   * A link to another page is never one.
   * @param {Element} el
   * @return {?HTMLElement}
   */
  function clickTarget(el) {
    /** @type {?Element} */
    let found = null;
    let node = /** @type {?Element} */ (el);
    for (let depth = 0; node && depth < 4; depth++) {
      if (node.matches(CLICKABLE)) {
        found = node;
        break;
      }
      node = parentOf(node);
    }
    const target = /** @type {HTMLElement} */ (found || el);
    const link = target.closest('a[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      if (!href.startsWith('#') && !/^javascript:/i.test(href)) return null;
    }
    return target;
  }

  /**
   * A click as a script makes it. No user activation: a page's pop-up on click stays blocked.
   * @param {HTMLElement} el
   */
  function press(el) {
    el.click();
  }

  /**
   * Brings back controls a player hides when the mouse rests: moves on the video, its parents' children
   * (the overlay that takes the mouse is usually beside the video) and the video. No point lookups: after
   * a takeover the player has no size.
   * @param {HTMLVideoElement} video
   */
  function wake(video) {
    const rect = video.getBoundingClientRect();
    const x = rect.width > 0 ? rect.x + rect.width / 2 : 10;
    const y = rect.height > 0 ? rect.y + rect.height / 2 : 10;
    /** @type {Set<Element>} */
    const targets = new Set([video]);
    let el = parentOf(video);
    for (let depth = 0; el && depth < PLAYER_DEPTH && el.tagName !== 'HTML'; depth++) {
      for (const child of el.children) {
        if (!isOwn(child) && targets.size < 200) targets.add(child);
      }
      el = parentOf(el);
    }
    for (const target of targets) {
      for (const type of ['pointermove', 'mousemove']) {
        target.dispatchEvent(new MouseEvent(type, {bubbles: true, composed: true, clientX: x, clientY: y}));
      }
    }
  }

  /**
   * @param {Element} item
   * @return {boolean} Whether the menu marks it as the one in use.
   */
  function isSelected(item) {
    for (const el of [item, ...item.querySelectorAll('*')].slice(0, 20)) {
      // A check icon in the entry (each list keeps it in one only: more than one counts as none).
      if (el.tagName.toLowerCase() === 'svg' && /(^|[\s_-])check($|[\s_-])/i.test(el.getAttribute('class') || '')) return true;
      if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') return true;
      const current = el.getAttribute('aria-current');
      if (current && current !== 'false') return true;
      if (/^(checked|active|on)$/.test(el.getAttribute('data-state') || '')) return true;
      const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
      if (SELECTED_CLASS.test(cls)) return true;
    }
    return false;
  }

  /**
   * The quality lists below a root: items whose whole text is a quality label, grouped by the list they are
   * in, with two heights at least. Hidden lists count: a menu that is only hidden is in the page.
   * @param {Element|Document} root
   * @param {?WeakSet<Element>} [before] - Elements there before a click: a list of only those was not opened by it.
   * @return {Group[]}
   */
  function findGroups(root, before = null) {
    /** @type {Map<Element, Item[]>} */
    const lists = new Map();
    for (const el of allBelow(root)) {
      if (isOwn(el)) continue;
      const text = ownText(el) || (el.matches('[role=menuitemradio], [role=option], [role=radio]') ?
        el.getAttribute('aria-label') || '' : '');
      const label = qualityLabel(text);
      if (!label) continue;
      const target = clickTarget(el);
      if (!target) continue;
      const list = parentOf(target);
      if (!list) continue;
      const items = lists.get(list) || [];
      if (!items.some((item) => item.target === target)) {
        items.push({el, target, label: text.replace(/\s+/g, ' ').trim(), height: label.height, auto: label.auto, selected: false});
      }
      lists.set(list, items);
    }
    /** @type {Group[]} */
    const groups = [];
    for (const [container, items] of lists) {
      const heights = new Set(items.filter((item) => !item.auto).map((item) => item.height));
      if (heights.size < 2 || items.length > MAX_ITEMS) continue;
      // Bare numbers ("720") only in a list that says what it is.
      const bare = items.every((item) => item.auto || qualityLabel(item.label)?.bare);
      if (bare && !container.matches('[role=menu], [role=listbox], [role=radiogroup], [role=group]') &&
          !hasWord(keysOf(container), ['quality', 'resolution', 'definition', 'level'])) {
        continue;
      }
      // Most of the list is quality entries, not a panel that happens to show two numbers.
      const siblings = [...container.children].filter((child) => !isOwn(child));
      if (items.length * 2 < siblings.length) continue;
      for (const item of items) item.selected = isSelected(item.target);
      if (items.filter((item) => item.selected).length > 1) {
        for (const item of items) item.selected = false;
      }
      groups.push({items, container, opened: !!before && items.some((item) => !before.has(item.target))});
    }
    return groups;
  }

  /**
   * The group for a video: one a click opened, else the one nearest the video.
   * @param {Group[]} groups
   * @param {Element} root
   * @return {?Group}
   */
  function pickGroup(groups, root) {
    const opened = groups.filter((group) => group.opened);
    if (opened.length) return opened.sort((a, b) => b.items.length - a.items.length)[0];
    const inside = groups.filter((group) => root.contains(group.container) ||
      root.getRootNode() !== document && group.container.getRootNode() === root.getRootNode());
    return inside.sort((a, b) => b.items.length - a.items.length)[0] || null;
  }

  /**
   * Controls that may open a quality menu, best first: named after quality, then settings, then any menu button.
   * @param {Element} root
   * @return {HTMLElement[]}
   */
  function openers(root) {
    /** @type {Array<{el: HTMLElement, rank: number}>} */
    const found = [];
    for (const el of allBelow(root)) {
      if (isOwn(el) || !el.matches('button, [role=button], [aria-haspopup], [tabindex], [title], [aria-label]')) continue;
      const name = nameOf(el);
      const keys = keysOf(el);
      if (OTHER_WORDS.test(name) && !hasWord(name, QUALITY_WORDS) && !hasWord(name, SETTINGS_WORDS)) continue;
      let rank = -1;
      if (hasWord(name, QUALITY_WORDS) || qualityLabel(ownText(el))) rank = 0;
      else if (hasWord(name, SETTINGS_WORDS)) rank = 1;
      else if (hasWord(keys, ['quality', 'resolution', 'definition'])) rank = 2;
      else if (hasWord(keys, ['setting', 'gear', 'cog'])) rank = 3;
      else if (/^(true|menu|listbox)$/.test(el.getAttribute('aria-haspopup') || '') && !name) rank = 4;
      if (rank < 0) continue;
      const target = clickTarget(el);
      if (!target || found.some((f) => f.el === target || f.el.contains(target))) continue;
      found.push({el: target, rank});
    }
    return found.sort((a, b) => a.rank - b.rank).slice(0, 4).map((f) => f.el);
  }

  /**
   * Rows of an opened settings menu that lead to the quality list: a row showing one quality as its value first
   * ("Source quality 360p"), then rows named after quality ("Quality Auto").
   * @param {Element[]} elements
   * @return {HTMLElement[]}
   */
  function qualityRows(elements) {
    /** @type {Array<{el: HTMLElement, rank: number}>} */
    const found = [];
    for (const el of elements) {
      if (isOwn(el) || !el.matches(CLICKABLE)) continue;
      const text = (/** @type {HTMLElement} */ (el).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60 || !hasWord(text, QUALITY_WORDS)) continue;
      const showsLabel = [...el.querySelectorAll('*')].some((child) => {
        const label = qualityLabel(ownText(child));
        return label && !label.auto;
      });
      const target = /** @type {HTMLElement} */ (el);
      if (found.some((f) => f.el.contains(target) || target.contains(f.el))) continue;
      found.push({el: target, rank: showsLabel ? 0 : 1});
    }
    return found.sort((a, b) => a.rank - b.rank).slice(0, 2).map((f) => f.el);
  }

  /** @param {number} ms @return {Promise<void>} */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * @template T
   * @param {() => ?T} check
   * @param {number} ms
   * @return {Promise<?T>}
   */
  async function waitFor(check, ms) {
    const end = performance.now() + ms;
    for (;;) {
      const value = check();
      if (value) return value;
      if (performance.now() >= end) return null;
      await sleep(100);
    }
  }

  /**
   * Closes what a probe or a switch opened: Escape, then the opener again when the menu is still there
   * (players without Escape) or the opener says it is open.
   * @param {?HTMLElement} opener
   * @param {() => boolean} [stillOpen]
   * @return {Promise<void>}
   */
  async function closeMenus(opener, stillOpen = () => false) {
    const target = opener && opener.isConnected ? opener : document.body;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, {key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, composed: true}));
    }
    await sleep(250);
    if (opener && opener.isConnected && (opener.getAttribute('aria-expanded') === 'true' || stillOpen())) press(opener);
  }

  /**
   * What a control is known by across switches: its first text that is not a quality value ("Source quality",
   * not "Source quality 360p", which changes with the pick), else its label, else its class.
   * @param {Element} el
   * @return {string}
   */
  function stableName(el) {
    for (const node of [el, ...el.querySelectorAll('*')].slice(0, 30)) {
      const text = ownText(node);
      if (text && text.length <= 40 && !qualityLabel(text)) return text;
    }
    return el.getAttribute('aria-label') || el.getAttribute('title') || keysOf(el).slice(0, 80);
  }

  /**
   * Finds a step's control again: the same tag and name.
   * @param {Element[]} elements
   * @param {Step} step
   * @return {?HTMLElement}
   */
  function findStep(elements, step) {
    const el = elements.find((e) => !isOwn(e) && e.tagName === step.tag && stableName(e) === step.name);
    return el ? clickTarget(el) : null;
  }

  /** @param {HTMLElement} el @return {Step} */
  function stepOf(el) {
    return {name: stableName(el), tag: el.tagName};
  }

  /**
   * The quality list of a video's player: a list in the page, else one opened through its controls (a quality
   * button, or settings and a quality row). Leaves the menus closed.
   * @param {HTMLVideoElement} video
   * @return {Promise<?Found>}
   */
  async function locate(video) {
    const root = playerRoot(video);
    const passive = pickGroup(findGroups(root), root);
    if (passive) {
      return {video, path: [], labels: passive.items.map((item) => item.label), items: passive.items};
    }
    wake(video);
    await sleep(50);
    for (const opener of openers(root)) {
      const before = new WeakSet(allBelow(document));
      wake(video);
      press(opener);
      let group = await waitFor(() => pickGroup(findGroups(document, before), root), STEP_WAIT_MS);
      if (group) {
        /** @type {Found} */
        const result = {video, path: [stepOf(opener)], labels: group.items.map((item) => item.label), items: null};
        await closeMenus(opener, isOpen(result));
        return result;
      }
      const added = allBelow(document).filter((el) => !before.has(el));
      for (const row of qualityRows(added.length ? added : allBelow(root))) {
        const beforeRow = new WeakSet(allBelow(document));
        press(row);
        group = await waitFor(() => pickGroup(findGroups(document, beforeRow), root), STEP_WAIT_MS);
        if (group) {
          /** @type {Found} */
          const result = {video, path: [stepOf(opener), stepOf(row)], labels: group.items.map((item) => item.label), items: null};
          await closeMenus(opener, isOpen(result));
          return result;
        }
        // Back to the start: the next row is tried from a freshly opened menu.
        await closeMenus(opener, () => !!findStep(allBelow(document), stepOf(row)));
        wake(video);
        if (!opener.isConnected) break;
        press(opener);
        await sleep(300);
      }
      await closeMenus(opener, () => added.some((el) => el.isConnected));
    }
    return null;
  }

  /**
   * The list with a found menu's labels, open in the page.
   * @param {Element} root
   * @param {string[]} labels
   * @return {?Group}
   */
  function listWith(root, labels) {
    const groups = findGroups(document).filter((group) =>
      labels.every((label) => group.items.some((item) => item.label === label)));
    return pickGroup(groups, root) || groups[0] || null;
  }

  /**
   * Whether a found menu is still open: its opener says so, else its quality row or its list is in the page
   * (players that build their menus only while open).
   * @param {Found} known
   * @return {() => boolean}
   */
  function isOpen(known) {
    return () => {
      const elements = allBelow(document);
      const opener = known.path.length ? findStep(elements, known.path[0]) : null;
      const expanded = opener?.getAttribute('aria-expanded');
      if (expanded === 'true' || expanded === 'false') return expanded === 'true';
      if (known.path.length > 1) return !!findStep(elements, known.path[1]) || !!listWith(playerRoot(known.video), known.labels);
      return !!listWith(playerRoot(known.video), known.labels);
    };
  }

  /**
   * Opens the found menu again (from the deepest step already open: a menu left open is not toggled shut) and
   * returns its items, or the items still in the page.
   * @param {Found} found
   * @return {Promise<Item[]|string>} The items, or which step was missing.
   */
  async function reopen(found) {
    const root = playerRoot(found.video);
    const open = listWith(root, found.labels);
    if (open) return open.items;
    if (found.path.length === 0) return 'list';
    let start = 0;
    for (let i = found.path.length - 1; i > 0; i--) {
      if (findStep(allBelow(document), found.path[i])) {
        start = i;
        break;
      }
    }
    for (let i = start; i < found.path.length; i++) {
      wake(found.video);
      const step = found.path[i];
      const el = await waitFor(() => findStep(allBelow(document), step), STEP_WAIT_MS);
      if (!el) return 'step ' + i;
      press(el);
    }
    const group = await waitFor(() => listWith(root, found.labels), STEP_WAIT_MS);
    return group ? group.items : 'list';
  }

  /**
   * The <video> playing in the page now: the same element, or the one the player put in its place.
   * @param {HTMLVideoElement} video
   * @param {string} oldUrl
   * @return {?HTMLVideoElement}
   */
  function playingVideo(video, oldUrl) {
    if (video.isConnected && video.currentSrc && video.currentSrc !== oldUrl) return video;
    const videos = /** @type {HTMLVideoElement[]} */ (allBelow(document).filter((el) => el.tagName === 'VIDEO'));
    return videos.find((v) => /^https?:/.test(v.currentSrc) && v.currentSrc !== oldUrl) || null;
  }

  // One probe or switch at a time in a frame: two would click through the same menus.
  let queue = Promise.resolve();
  /** @type {Map<number, Found>} */
  const found = new Map();
  let nextId = 1;
  /** @type {WeakMap<HTMLVideoElement, ?number>} */
  const probed = new WeakMap();

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @return {Promise<T>}
   */
  function serial(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The qualities a video's player offers in its menu.
   * @param {HTMLVideoElement} video
   * @return {Promise<?{id: number, choices: Choice[]}>} Null when it offers no list.
   */
  function probe(video) {
    return serial(async () => {
      if (probed.has(video)) {
        const id = probed.get(video);
        const known = typeof id === 'number' ? found.get(id) : null;
        return known && typeof id === 'number' ? {id, choices: choicesOf(known)} : null;
      }
      let result = null;
      try {
        result = await locate(video);
      } catch (e) {
        console.warn('Reading the page player\'s quality menu failed', e);
      }
      if (!result) {
        probed.set(video, null);
        return null;
      }
      const id = nextId++;
      found.set(id, result);
      probed.set(video, id);
      return {id, choices: choicesOf(result)};
    });
  }

  /**
   * @param {Found} known
   * @return {Choice[]}
   */
  function choicesOf(known) {
    return known.labels.map((label, i) => {
      const parsed = qualityLabel(label);
      return {label, height: parsed?.height || 0, auto: !!parsed?.auto, selected: !!known.items?.[i]?.selected};
    });
  }

  /**
   * Switches the page's player to one of its qualities and says what it plays then.
   * @param {number} id - From probe.
   * @param {number} index - In its choices.
   * @return {Promise<{url?: string, width?: number, height?: number, changed: boolean, error?: string}>}
   */
  function select(id, index) {
    return serial(async () => {
      const known = found.get(id);
      const label = known?.labels[index];
      if (!known || !label) return {changed: false, error: 'unknown'};
      const oldUrl = known.video.currentSrc;
      const opener = () => known.path.length ? findStep(allBelow(document), known.path[0]) : null;
      /** @type {Item[]|string} */
      let items = 'list';
      try {
        items = await reopen(known);
      } catch (e) {
        console.warn('Opening the page player\'s quality menu failed', e);
      }
      const item = typeof items === 'string' ? null : items.find((candidate) => candidate.label === label);
      if (!item) {
        await closeMenus(opener(), isOpen(known));
        return {changed: false, error: 'menu: ' + (typeof items === 'string' ? items : 'item')};
      }
      /** @type {?Event} */
      let reloaded = null;
      const onReload = (/** @type {Event} */ e) => {
        reloaded = e;
      };
      known.video.addEventListener('loadedmetadata', onReload);
      press(item.target);
      // Labels may name the same file ("1080p" that is the 480p one): a reload of the same element counts too.
      const now = await waitFor(() => playingVideo(known.video, oldUrl) || (reloaded ? known.video : null), CHANGE_WAIT_MS);
      known.video.removeEventListener('loadedmetadata', onReload);
      await closeMenus(opener(), isOpen(known));
      if (!now) return {changed: false};
      await waitFor(() => now.readyState >= 1 && now.videoHeight > 0, METADATA_WAIT_MS);
      if (now !== known.video) {
        // The player's new element is the one to switch next time.
        known.video = now;
        probed.set(now, id);
      }
      const url = now.currentSrc;
      if (!/^https?:/.test(url)) return {changed: false, error: 'not a file'};
      return {url, width: now.videoWidth, height: now.videoHeight, changed: url !== oldUrl};
    });
  }

  return {probe, select, qualityLabel, findGroups, openers, qualityRows, wake};
})();
