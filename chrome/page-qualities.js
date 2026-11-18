// @ts-check
// The qualities a page's own player offers as separate files, for content.js.
// eslint-disable-next-line no-unused-vars
const PageQualities = (() => {
  /** @typedef {{url: string, label: string, height: number}} Quality */
  // Where players keep a <source>'s quality.
  const LABEL_ATTRIBUTES = ['label', 'size', 'res', 'data-quality', 'data-res', 'data-label', 'data-size',
    'data-height', 'title', 'quality'];
  // A list longer than this is no quality menu.
  const MAX_ENTRIES = 12;

  /**
   * The height a quality label names: "1080p", "720", "HD 720p", "Full HD", "4K", "SD".
   * @param {*} label
   * @return {number} 0 when it names none.
   */
  function heightOf(label) {
    const text = String(label ?? '').trim();
    // A size, "1920x1080": its second number.
    const size = /(?<!\d)\d{3,4}\s*[x×]\s*(\d{3,4})(?!\d)/i.exec(text);
    if (size) {
      const height = parseInt(size[1], 10);
      if (height >= 100 && height <= 4320) return height;
    }
    // Not a number that ends a word or a version: a codec's ("H264", "x265").
    const digits = /(?<![\w.])(\d{3,4})\s*[pP]?(?!\d)/.exec(text);
    if (digits) {
      const height = parseInt(digits[1], 10);
      if (height >= 100 && height <= 4320) return height;
    }
    if (/\b(8k)\b/i.test(text)) return 4320;
    if (/\b(4k|uhd|2160)\b/i.test(text)) return 2160;
    if (/\b(2k|qhd)\b/i.test(text)) return 1440;
    if (/\b(full\s*hd|fhd)\b/i.test(text)) return 1080;
    if (/\bhd\b/i.test(text)) return 720;
    if (/\bsd\b/i.test(text)) return 480;
    if (/\b(ld|low)\b/i.test(text)) return 360;
    return 0;
  }

  /**
   * An absolute http(s) URL, or null.
   * @param {*} url
   * @param {string} base
   * @return {?string}
   */
  function absolute(url, base) {
    if (typeof url !== 'string' || !url.trim()) return null;
    try {
      const parsed = new URL(url.trim(), base);
      return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * A label as plain text (Artplayer's are HTML). Tags go in a loop: one pass left "<scr<b>ipt>" a tag.
   * @param {*} label
   * @return {string}
   */
  function plainLabel(label) {
    let text = String(label ?? '').slice(0, 400);
    let previous;
    do {
      previous = text;
      text = text.replace(/<[^<>]*>/g, '');
    } while (text !== previous);
    return text.replace(/[<>]/g, '').trim().slice(0, 40);
  }

  /**
   * One list's entries cleaned up: absolute URLs, each once, labels as text.
   * @param {Array<{url: *, label: *}>} entries
   * @param {string} base
   * @return {?Array<Quality>} Null for fewer than two.
   */
  function toList(entries, base) {
    /** @type {Array<Quality>} */
    const list = [];
    for (const entry of entries) {
      const url = absolute(entry.url, base);
      if (!url || list.some((e) => e.url === url)) continue;
      const label = plainLabel(entry.label);
      list.push({url, label, height: heightOf(label)});
      // Early: each entry is compared with all before it.
      if (list.length > MAX_ENTRIES) return null;
    }
    return list.length >= 2 ? list : null;
  }

  /**
   * Playerjs's file string: "[360p]url,[720p]url". An entry may carry backups ("url or url"):
   * the first is the one. Encoded strings ("#2...", "#3...") are not read.
   * @param {string} text
   * @param {string} base
   * @return {?Array<Quality>}
   */
  function parsePlayerjsFile(text, base) {
    if (typeof text !== 'string' || !text.startsWith('[')) return null;
    const entries = [];
    const pattern = /\[([^\]]{0,40})\]\s*([^,\s][^,]*)/g;
    let match;
    while ((match = pattern.exec(text))) {
      const url = match[2].split(/\s+or\s+/)[0].trim();
      entries.push({url, label: match[1]});
    }
    return toList(entries, base);
  }

  /**
   * The <source> lists of the page's videos.
   * @param {Document} doc
   * @param {string} base
   * @return {Array<Array<Quality>>}
   */
  function fromSourceElements(doc, base) {
    const lists = [];
    for (const media of doc.querySelectorAll('video')) {
      const sources = media.querySelectorAll('source');
      if (sources.length > MAX_ENTRIES * 4) continue;
      const entries = [];
      for (const source of sources) {
        const attribute = LABEL_ATTRIBUTES.find((name) => source.hasAttribute(name) && /** @type {string} */ (source.getAttribute(name)).trim());
        if (!attribute) continue;
        let label = /** @type {string} */ (source.getAttribute(attribute)).trim();
        // Plyr's size is a bare height.
        if (/^\d{3,4}$/.test(label)) label += 'p';
        entries.push({url: source.getAttribute('src'), label});
      }
      const list = toList(entries, base);
      if (list) lists.push(list);
    }
    return lists;
  }

  /**
   * Playerjs's file strings in the page's own scripts (`file:"[360p]...,[720p]..."`).
   * @param {Document} doc
   * @param {string} base
   * @return {Array<Array<Quality>>}
   */
  function fromScripts(doc, base) {
    /** @type {Array<Array<Quality>>} */
    const lists = [];
    // file:"..." in a script, "file":"..." in JSON.
    const pattern = /\bfile["']?\s*:\s*(["'])(\[[^"']{0,40}\][\s\S]*?)\1/g;
    for (const script of doc.querySelectorAll('script:not([src])')) {
      const text = script.textContent || '';
      if (!text.includes('[')) continue;
      let match;
      while ((match = pattern.exec(text))) {
        const list = parsePlayerjsFile(match[2].replace(/\\\//g, '/'), base);
        if (list && !lists.some((known) => sameList(known, list))) lists.push(list);
      }
    }
    return lists;
  }

  /**
   * Whether two lists name the same files.
   * @param {Array<Quality>} a
   * @param {Array<Quality>} b
   * @return {boolean}
   */
  function sameList(a, b) {
    return a.length === b.length && a.every((entry) => b.some((other) => other.url === entry.url));
  }

  /**
   * Reads a page object's field, and nothing that throws (a getter, a dead object).
   * @param {*} object
   * @param {string|number} key
   * @return {*}
   */
  function field(object, key) {
    try {
      return object ? object[key] : undefined;
    } catch (e) {
      return undefined;
    }
  }

  /**
   * An array-like page object as an array, at most a few dozen items.
   * @param {*} value
   * @return {Array<*>}
   */
  function items(value) {
    const out = [];
    const length = Math.min(Number(field(value, 'length')) || 0, 50);
    for (let i = 0; i < length; i++) out.push(field(value, i));
    return out;
  }

  /**
   * The lists the page's player objects hold. `page` is window.wrappedJSObject.
   * @param {*} page
   * @param {string} base
   * @return {Array<Array<Quality>>}
   */
  function fromPlayers(page, base) {
    /** @type {Array<Array<Quality>>} */
    const lists = [];
    /** @param {Array<{url: *, label: *}>} entries */
    const add = (entries) => {
      const list = toList(entries, base);
      if (list && !lists.some((known) => sameList(known, list))) lists.push(list);
    };
    if (!page) return lists;
    // Artplayer: every instance, its option.quality [{html, url}].
    for (const art of items(field(field(page, 'Artplayer'), 'instances'))) {
      add(items(field(field(art, 'option'), 'quality')).map((q) => ({url: field(q, 'url'), label: field(q, 'html')})));
    }
    // JW Player: the playlist item playing, its sources [{file, label}].
    try {
      const jwplayer = field(page, 'jwplayer');
      if (typeof jwplayer === 'function') {
        const player = jwplayer();
        const item = player && typeof player.getPlaylistItem === 'function' ? player.getPlaylistItem() : null;
        add(items(field(item, 'sources')).map((s) => ({url: field(s, 'file'), label: field(s, 'label')})));
      }
    } catch (e) {
      // Not set up, or not a JW Player after all.
    }
    // DPlayer keeps no list of its instances: the page's own variable, as its docs name it.
    for (const name of ['dp', 'dplayer', 'player']) {
      const quality = field(field(field(field(page, name), 'options'), 'video'), 'quality');
      add(items(quality).map((q) => ({url: field(q, 'url'), label: field(q, 'name')})));
    }
    return lists;
  }

  /**
   * Every quality list the page holds.
   * @param {Document} doc
   * @param {*} page - The page's own window, or null.
   * @param {string} base - The page's address, for relative URLs.
   * @return {Array<Array<Quality>>}
   */
  function find(doc, page, base) {
    /** @type {Array<Array<Quality>>} */
    const lists = [];
    for (const list of [...fromSourceElements(doc, base), ...fromPlayers(page, base), ...fromScripts(doc, base)]) {
      if (!lists.some((known) => sameList(known, list))) lists.push(list);
    }
    return lists;
  }

  return {find, heightOf, parsePlayerjsFile};
})();
