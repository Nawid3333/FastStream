// @ts-check
// TTML (W3C Timed Text, TTML1/TTML2, IMSC, EBU-TT) and its older name DFXP, read into WebVTT.

/**
 * @typedef {Object} TtmlRates
 * @property {number} frameRate - Frames a second, the multiplier applied.
 * @property {number} subFrameRate - Sub-frames a frame.
 * @property {number} tickRate - Ticks a second.
 */

/**
 * What an element's styles specify; a property none of them names is undefined.
 * @typedef {Object} TtmlStyle
 * @property {boolean} [italic]
 * @property {boolean} [bold]
 * @property {boolean} [underline]
 * @property {?string} [color] - A WebVTT colour class, null for the viewer's own colour.
 */

// White space as XML counts it: a no-break or ideographic space is text.
const XML_SPACE = /[ \t\r\n]+/g;

/** @type {TtmlRates} */
export const DEFAULT_TTML_RATES = Object.freeze({frameRate: 30, subFrameRate: 1, tickRate: 1});

const OFFSET_UNITS = {h: 3600, m: 60, s: 1, ms: 0.001};

// A paragraph is rendered once for every stretch its spans' times cut it into: what reading one document may
// cost, counted where the work is done (docs/notes/player.md, "TTML and DFXP subtitles").
const MAX_WORK = 16000000;
const NODE_WORK = 1;
const STYLE_WORK = 10;
const TEXT_PER_WORK = 64;
// For the work the count does not know: no read takes longer than this, whatever it is made of.
const MAX_READ_MS = 5000;
const SPENDS_PER_LOOK_AT_THE_CLOCK = 64;
const MAX_CUE_TEXT = 16 * 1024 * 1024;

/**
 * Why a document gives no cues: not well-formed XML (or no tt root), entity declarations,
 * subtitles that are images, or more work or cue text than a subtitle file is.
 */
export class TtmlError extends Error {
  /**
   * @param {'malformed'|'entities'|'images'|'large'} reason
   * @param {string} [detail]
   */
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'TtmlError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * A TTML time expression in seconds: clock time (01:02:03.5, 01:02:03:12 with frames and
 * sub-frames) or offset time (1.5s, 250ms, 2h, 90m, 12f, 1000t).
 * @param {?string} expression
 * @param {TtmlRates} rates
 * @return {number} NaN for no expression or one that is not TTML.
 */
export function parseTtmlTime(expression, rates) {
  if (typeof expression !== 'string') return NaN;
  const value = expression.trim();
  const clock = /^(\d{2,}):(\d{2}):(\d{2})(?:(\.\d+)|:(\d{2,})(?:\.(\d+))?)?$/.exec(value);
  if (clock) {
    const [, hours, minutes, seconds, fraction, frames, subFrames] = clock;
    let time = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
    if (fraction) time += Number(fraction);
    if (frames) time += Number(frames) / rates.frameRate;
    if (subFrames) time += Number(subFrames) / (rates.frameRate * rates.subFrameRate);
    return time;
  }
  const offset = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(value);
  if (!offset) return NaN;
  const amount = Number(offset[1]);
  const unit = /** @type {'h'|'m'|'s'|'ms'|'f'|'t'} */ (offset[2]);
  if (unit === 'f') return amount / rates.frameRate;
  if (unit === 't') return amount / rates.tickRate;
  return amount * OFFSET_UNITS[unit];
}

/**
 * The rates a document's time expressions count in, from the root's ttp: parameters.
 * @param {(name: string) => ?string} rootAttribute - The root's attribute by local name.
 * @return {TtmlRates}
 */
export function ttmlRates(rootAttribute) {
  const positive = (/** @type {?string} */ text) => {
    const number = Number(text);
    return text !== null && Number.isFinite(number) && number > 0 ? number : null;
  };
  const baseFrameRate = positive(rootAttribute('frameRate'));
  let frameRate = baseFrameRate ?? DEFAULT_TTML_RATES.frameRate;
  const multiplier = /^\s*(\d+)\s+(\d+)\s*$/.exec(rootAttribute('frameRateMultiplier') || '');
  if (multiplier && Number(multiplier[1]) > 0 && Number(multiplier[2]) > 0) {
    frameRate = frameRate * Number(multiplier[1]) / Number(multiplier[2]);
  }
  const subFrameRate = positive(rootAttribute('subFrameRate')) ?? DEFAULT_TTML_RATES.subFrameRate;
  // Without its own tickRate: the sub-frame rate when the document names a frame rate, else 1.
  const tickRate = positive(rootAttribute('tickRate')) ?? (baseFrameRate !== null ? frameRate * subFrameRate : 1);
  return {frameRate, subFrameRate, tickRate};
}

/**
 * Whether a subtitle file's text is a TTML document: its root element is tt, with any prefix.
 * @param {string} text
 * @return {boolean}
 */
export function isTtml(text) {
  const head = text.slice(0, 8192);
  // Each part has one way to match (a comment ends at its first "-->"): no backtracking blow-up.
  return /^\uFEFF?(?:\s|<\?[^>]*\?>|<!--(?:(?!-->)[^])*-->|<!DOCTYPE[^>[]*(?:\[[^\]]*\]\s*)?>)*<(?:[A-Za-z_][\w.-]*:)?tt[\s>/]/.test(head);
}

/** @type {Map<string, number[]>} */
const NAMED_COLORS = new Map(Object.entries({
  transparent: [0, 0, 0, 0], black: [0, 0, 0, 255], silver: [192, 192, 192, 255],
  gray: [128, 128, 128, 255], white: [255, 255, 255, 255], maroon: [128, 0, 0, 255],
  red: [255, 0, 0, 255], purple: [128, 0, 128, 255], fuchsia: [255, 0, 255, 255],
  magenta: [255, 0, 255, 255], green: [0, 128, 0, 255], lime: [0, 255, 0, 255],
  olive: [128, 128, 0, 255], yellow: [255, 255, 0, 255], navy: [0, 0, 128, 255],
  blue: [0, 0, 255, 255], teal: [0, 128, 128, 255], aqua: [0, 255, 255, 255], cyan: [0, 255, 255, 255],
}));

// The WebVTT colour classes the player draws. White is the viewer's colour setting, and black
// text would vanish into the subtitle background: neither is written.
/** @type {Map<string, string>} */
const CUE_COLOR_CLASSES = new Map(Object.entries({
  '0,255,0': 'lime', '0,255,255': 'cyan', '255,0,0': 'red',
  '255,255,0': 'yellow', '255,0,255': 'magenta', '0,0,255': 'blue',
}));

/**
 * @param {string} value - A TTML colour: a name, #rrggbb, #rrggbbaa, rgb() or rgba().
 * @return {string|null|undefined} Its WebVTT colour class; null for one the player does not draw;
 *   undefined for no colour TTML knows.
 */
export function cueColorClass(value) {
  const text = value.trim().toLowerCase();
  /** @type {number[]|undefined} */
  let rgba = NAMED_COLORS.get(text);
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(text);
  if (hex) rgba = [1, 2, 3, 4].map((i) => (hex[i] === undefined ? 255 : parseInt(hex[i], 16)));
  const functional = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d{1,3})\s*)?\)$/.exec(text);
  if (functional && (functional[4] === undefined) === text.startsWith('rgb(')) {
    rgba = [1, 2, 3, 4].map((i) => (functional[i] === undefined ? 255 : Number(functional[i])));
  }
  if (!rgba || rgba.some((part) => part > 255)) return undefined;
  if (rgba[3] === 0) return null;
  return CUE_COLOR_CLASSES.get(rgba.slice(0, 3).join(',')) ?? null;
}

/**
 * @param {Element} element
 * @param {string} name - The attribute's local name, whatever namespace or prefix it has.
 * @return {?string}
 */
function attribute(element, name) {
  for (const attr of Array.from(element.attributes)) {
    if (attr.localName === name) return attr.value;
  }
  return null;
}

/**
 * @param {string} text
 * @return {string} Safe in a WebVTT cue: no markup of its own, no "-->".
 */
function escapeCueText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The style of an element: what it inherits, then the styles it refers to, its nested style
 * elements and its own tts: attributes, each over the one before. A region's style is TTML's
 * root of inheritance for what is shown in it: it fills only what the content left unspecified.
 * @param {Document} doc
 * @param {(work: number) => void} spend
 * @return {{resolve: (element: Element, inherited: TtmlStyle) => TtmlStyle, regionStyle: (id: ?string) => TtmlStyle}}
 */
function styleResolver(doc, spend) {
  /**
   * @param {string} name
   * @return {Map<string, Element>} The elements of that name, by xml:id.
   */
  const byId = (name) => {
    const elements = new Map();
    for (const element of Array.from(doc.getElementsByTagNameNS('*', name))) {
      const id = attribute(element, 'id');
      if (id) elements.set(id, element);
    }
    return elements;
  };
  const styles = byId('style');
  const regions = byId('region');

  /**
   * @param {Element} element
   * @param {TtmlStyle} style - Changed in place.
   * @param {Set<string>} seen - Style ids on the way here: a reference loop ends.
   */
  const apply = (element, style, seen) => {
    const named = (attribute(element, 'style') || '').split(/\s+/);
    spend(STYLE_WORK + named.length + element.attributes.length);
    for (const id of named) {
      const referenced = styles.get(id);
      if (!id || !referenced || seen.has(id)) continue;
      seen.add(id);
      apply(referenced, style, seen);
    }
    for (const child of Array.from(element.children)) {
      if (child.localName === 'style') apply(child, style, seen);
    }
    const fontStyle = attribute(element, 'fontStyle');
    if (fontStyle) style.italic = fontStyle === 'italic' || fontStyle === 'oblique';
    const fontWeight = attribute(element, 'fontWeight');
    if (fontWeight) style.bold = fontWeight === 'bold';
    const decoration = attribute(element, 'textDecoration');
    if (decoration) {
      if (/\bnoUnderline\b/.test(decoration)) style.underline = false;
      else if (/\bunderline\b/.test(decoration)) style.underline = true;
    }
    const color = attribute(element, 'color');
    const colorClass = color === null ? undefined : cueColorClass(color);
    if (colorClass !== undefined) style.color = colorClass;
  };

  /** @type {Map<string, TtmlStyle>} */
  const regionStyles = new Map();
  return {
    resolve: (element, inherited) => {
      const style = {...inherited};
      apply(element, style, new Set());
      return style;
    },
    regionStyle: (id) => {
      const region = regions.get(id || '');
      if (!region) return {};
      let style = regionStyles.get(/** @type {string} */ (id));
      if (!style) {
        style = {};
        apply(region, style, new Set());
        regionStyles.set(/** @type {string} */ (id), style);
      }
      return style;
    },
  };
}

/**
 * @param {Element} element
 * @param {boolean} inherited
 * @return {boolean} Whether its white space is kept (xml:space="preserve").
 */
function preservesSpace(element, inherited) {
  const space = attribute(element, 'space');
  return space === 'preserve' ? true : space === 'default' ? false : inherited;
}

/**
 * A p's text as WebVTT cue text: br (and a line feed where white space is kept) as a line break,
 * each run of text in its own colour, italic, bold and underline tags (so a line break or an
 * upright span inside an italic p keeps its style), other white space collapsed.
 * @param {Element} paragraph
 * @param {(element: Element, inherited: TtmlStyle) => TtmlStyle} resolve
 * @param {TtmlStyle} inherited - The style of the p's ancestors.
 * @param {TtmlStyle} region - The style of the region the p is shown in.
 * @param {boolean} preserve - Whether the p's ancestors keep white space.
 * @param {(span: Element) => boolean} shown - Whether a span is on screen in this cue.
 * @param {(work: number) => void} spend
 * @return {string} Empty when the p holds no text.
 */
function cueText(paragraph, resolve, inherited, region, preserve, shown, spend) {
  /**
   * @param {string} text
   * @param {TtmlStyle} style
   * @return {string}
   */
  const wrap = (text, style) => {
    let out = text;
    if (style.underline ?? region.underline) out = `<u>${out}</u>`;
    if (style.bold ?? region.bold) out = `<b>${out}</b>`;
    if (style.italic ?? region.italic) out = `<i>${out}</i>`;
    const color = style.color === undefined ? region.color : style.color;
    if (color) out = `<c.${color}>${out}</c>`;
    return out;
  };
  /**
   * @param {Element} element
   * @param {TtmlStyle} style - The element's own.
   * @param {boolean} keep - Whether it keeps white space.
   * @return {string}
   */
  const render = (element, style, keep) => {
    let out = '';
    for (const child of Array.from(element.childNodes)) {
      spend(NODE_WORK);
      if (child.nodeType === 3 || child.nodeType === 4) {
        const raw = child.nodeValue || '';
        spend(raw.length / TEXT_PER_WORK);
        const lines = keep ? raw.split(/\r?\n/) : [raw.replace(XML_SPACE, ' ')];
        out += lines.map((line) => (/\S/.test(line) ? wrap(escapeCueText(line), style) : line)).join('\n');
      } else if (child.nodeType === 1) {
        const inner = /** @type {Element} */ (child);
        if (inner.localName === 'br') {
          out += '\n';
        } else if (inner.localName === 'span' && shown(inner)) {
          spend(inner.attributes.length);
          // TTML2 ruby: its container and text as WebVTT's; the delimiters are for players without ruby.
          const ruby = attribute(inner, 'ruby');
          if (ruby === 'delimiter') continue;
          const text = render(inner, resolve(inner, style), preservesSpace(inner, keep));
          out += ruby === 'container' ? `<ruby>${text}</ruby>` : ruby === 'text' ? `<rt>${text}</rt>` : text;
        }
      }
    }
    return out;
  };

  // A blank line would end the cue: each line trimmed, blank ones dropped.
  return render(paragraph, resolve(paragraph, inherited), preservesSpace(paragraph, preserve)).split('\n')
      .map((line) => line.replace(XML_SPACE, ' ').replace(/^ | $/g, '')).filter((line) => /\S/.test(line)).join('\n');
}

/**
 * @typedef {Object} TtmlCue
 * @property {number} start - Seconds.
 * @property {number} end - Seconds; Infinity when nothing ends it.
 * @property {string} text - WebVTT cue text.
 */

/**
 * The cues of a parsed TTML document, in document order. Times nest: an element's begin and end
 * count from its parent's begin (in a seq container, from the end of the element before it), and
 * it ends no later than its parent. Spans with times of their own split their p into the cues
 * each stretch of it shows.
 * @param {Document} doc
 * @return {TtmlCue[]}
 */
export function ttmlCues(doc) {
  const root = doc.documentElement;
  if (!root || root.localName !== 'tt') return [];
  const rates = ttmlRates((name) => attribute(root, name));
  let work = 0;
  let spends = 0;
  let cueTextLength = 0;
  const started = performance.now();
  /** @param {number} units */
  const spend = (units) => {
    work += units;
    if (work > MAX_WORK) throw new TtmlError('large', 'reading it is more work than a subtitle file is');
    if (++spends % SPENDS_PER_LOOK_AT_THE_CLOCK === 0 && performance.now() - started > MAX_READ_MS) {
      throw new TtmlError('large', 'reading it takes longer than a subtitle file does');
    }
  };
  const {resolve, regionStyle} = styleResolver(doc, spend);
  /** @type {TtmlCue[]} */
  const cues = [];
  /** @type {TtmlStyle} */
  const plain = {};
  let unreadTimes = 0;
  let neverShown = 0;

  /**
   * @param {Element} element
   * @param {string} name
   * @return {number} NaN when it has none, or one that is not TTML (counted).
   */
  const time = (element, name) => {
    const value = attribute(element, name);
    const seconds = parseTtmlTime(value, rates);
    if (value !== null && Number.isNaN(seconds)) unreadTimes++;
    return seconds;
  };

  /**
   * @param {Element} element
   * @param {number} parentBegin
   * @param {number} parentEnd
   * @return {[number, number]} When it shows: the earlier of end and begin + dur, within its parent.
   */
  const interval = (element, parentBegin, parentEnd) => {
    const begin = time(element, 'begin');
    const start = parentBegin + (Number.isFinite(begin) ? begin : 0);
    const end = time(element, 'end');
    const dur = time(element, 'dur');
    let stop = Number.isFinite(end) ? parentBegin + end : parentEnd;
    if (Number.isFinite(dur)) stop = Math.min(stop, start + dur);
    // To the microsecond: sums like 0.1 + 0.2 meet the 0.3 written elsewhere.
    const round = (/** @type {number} */ seconds) => Math.round(seconds * 1e6) / 1e6;
    return [round(start), round(Math.min(stop, parentEnd))];
  };

  /**
   * The children of a container, each with its interval.
   * @param {Element} element
   * @param {number} start
   * @param {number} stop
   * @param {(child: Element) => boolean} timed - The children that take part.
   * @return {Array<[Element, number, number]>}
   */
  const childIntervals = (element, start, stop, timed) => {
    const sequence = attribute(element, 'timeContainer') === 'seq';
    /** @type {Array<[Element, number, number]>} */
    const out = [];
    let base = start;
    for (const child of Array.from(element.children)) {
      if (!timed(child)) continue;
      const [childStart, childStop] = interval(child, base, stop);
      out.push([child, childStart, childStop]);
      if (sequence && Number.isFinite(childStop)) base = childStop;
    }
    return out;
  };

  /**
   * @param {Element} paragraph
   * @param {number} start
   * @param {number} stop
   * @param {TtmlStyle} style
   * @param {?string} regionId - The region it is shown in, its own or its parent's.
   * @param {boolean} preserve
   */
  const addParagraph = (paragraph, start, stop, style, regionId, preserve) => {
    const region = regionStyle(attribute(paragraph, 'region') ?? regionId);
    /** @type {Map<Element, [number, number]>} */
    const spanTimes = new Map();
    const points = new Set([start, stop]);
    /** @type {(element: Element, from: number, to: number) => void} */
    const timeSpans = (element, from, to) => {
      for (const [span, spanStart, spanStop] of childIntervals(element, from, to, (child) => child.localName === 'span')) {
        spanTimes.set(span, [spanStart, spanStop]);
        if (spanStart > start && spanStart < stop) points.add(spanStart);
        if (spanStop > start && spanStop < stop) points.add(spanStop);
        timeSpans(span, spanStart, spanStop);
      }
    };
    timeSpans(paragraph, start, stop);

    const bounds = Array.from(points).sort((a, b) => a - b);
    if (stop <= start) {
      if (cueText(paragraph, resolve, style, region, preserve, () => true, spend)) neverShown++;
      return;
    }
    /** @type {?TtmlCue} */
    let previous = null;
    for (let i = 0; i + 1 < bounds.length; i++) {
      const [from, to] = [bounds[i], bounds[i + 1]];
      const text = cueText(paragraph, resolve, style, region, preserve, (span) => {
        const times = /** @type {[number, number]} */ (spanTimes.get(span));
        return times[0] <= from && times[1] >= to && times[0] < times[1];
      }, spend);
      if (!text) continue;
      cueTextLength += text.length;
      if (cueTextLength > MAX_CUE_TEXT) throw new TtmlError('large', 'its cues hold more text than is read');
      // A stretch that shows what the one before it showed goes on with it.
      if (previous && previous.end === from && previous.text === text) {
        previous.end = to;
      } else {
        previous = {start: from, end: to, text};
        cues.push(previous);
      }
    }
  };

  /**
   * @param {Element} element - body or div.
   * @param {number} start
   * @param {number} stop
   * @param {TtmlStyle} style
   * @param {?string} regionId
   * @param {boolean} preserve
   */
  const walk = (element, start, stop, style, regionId, preserve) => {
    const own = resolve(element, style);
    const region = attribute(element, 'region') ?? regionId;
    const keep = preservesSpace(element, preserve);
    for (const [child, childStart, childStop] of childIntervals(element, start, stop, (child) => child.localName === 'div' || child.localName === 'p')) {
      if (child.localName === 'p') addParagraph(child, childStart, childStop, own, region, keep);
      else walk(child, childStart, childStop, own, region, keep);
    }
  };

  for (const body of Array.from(root.children)) {
    if (body.localName !== 'body') continue;
    const [start, stop] = interval(body, 0, Infinity);
    walk(body, start, stop, plain, null, preservesSpace(root, false));
  }
  if (unreadTimes) console.warn(`TTML: ${unreadTimes} time expression(s) could not be read; their elements are timed as if they had none`);
  if (neverShown) console.warn(`TTML: ${neverShown} paragraph(s) end before they begin, or after their container ended; not shown`);
  return cues;
}

/**
 * @param {TtmlCue[]} cues - In document order; changed in place.
 * @return {TtmlCue[]} By start, each open end closed at the next later start (2 s for the last).
 */
export function closeOpenEnds(cues) {
  cues.sort((a, b) => a.start - b.start);
  let later = Infinity;
  for (let i = cues.length - 1; i >= 0; i--) {
    if (i + 1 < cues.length && cues[i + 1].start > cues[i].start) later = cues[i + 1].start;
    if (!Number.isFinite(cues[i].end)) cues[i].end = Number.isFinite(later) ? later : cues[i].start + 2;
  }
  return cues;
}

/**
 * @param {string} text - A TTML document.
 * @param {(seconds: number) => string} timeFormat - A WebVTT timestamp.
 * @return {string} WebVTT; only the header when the document holds no cue.
 * @throws {TtmlError} When it is not well-formed, declares entities, or holds only images.
 */
export function ttml2vtt(text, timeFormat) {
  // TTML needs no entities: declared ones could expand without end, or name outside files.
  if (/<!ENTITY/i.test(text)) throw new TtmlError('entities', 'entity declarations are not read');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  const failure = root?.localName === 'parsererror' ? root : doc.getElementsByTagName('parsererror')[0];
  if (failure) throw new TtmlError('malformed', (failure.firstChild?.textContent || '').trim().split('\n')[0]);
  if (!root || root.localName !== 'tt') throw new TtmlError('malformed', `its root is <${root?.localName}>, not <tt>`);
  const cues = closeOpenEnds(ttmlCues(doc));
  if (!cues.length && (doc.getElementsByTagNameNS('*', 'image').length ||
      Array.from(doc.getElementsByTagNameNS('*', 'div')).some((div) => attribute(div, 'backgroundImage') !== null))) {
    throw new TtmlError('images');
  }
  const blocks = ['WEBVTT'];
  for (const cue of cues) {
    blocks.push(blocks.length + '\n' + timeFormat(cue.start) + ' --> ' + timeFormat(cue.end) + '\n' + cue.text);
  }
  return blocks.join('\n\n');
}
