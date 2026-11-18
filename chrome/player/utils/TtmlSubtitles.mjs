// @ts-check
// TTML (W3C Timed Text, TTML1/TTML2, IMSC, EBU-TT) and its older name DFXP, read into WebVTT.

/**
 * @typedef {Object} TtmlRates
 * @property {number} frameRate - Frames a second, the multiplier applied.
 * @property {number} subFrameRate - Sub-frames a frame.
 * @property {number} tickRate - Ticks a second.
 */

/** @typedef {{italic: boolean, bold: boolean, underline: boolean}} TtmlStyle */

/** @type {TtmlRates} */
export const DEFAULT_TTML_RATES = Object.freeze({frameRate: 30, subFrameRate: 1, tickRate: 1});

const OFFSET_UNITS = {h: 3600, m: 60, s: 1, ms: 0.001};

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
  return /^\uFEFF?(?:\s|<\?[^>]*\?>|<!--(?:(?!-->)[^])*-->|<!DOCTYPE[^>]*>)*<(?:[A-Za-z_][\w.-]*:)?tt[\s>/]/.test(head);
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
 * The style ids each style element names, with its own italic, bold and underline.
 * @param {Document} doc
 * @return {(element: Element, inherited: TtmlStyle) => TtmlStyle}
 */
function styleResolver(doc) {
  /** @type {Map<string, Element>} */
  const styles = new Map();
  for (const element of Array.from(doc.getElementsByTagNameNS('*', 'style'))) {
    const id = attribute(element, 'id');
    if (id) styles.set(id, element);
  }

  /**
   * @param {Element} element
   * @param {TtmlStyle} style - Changed in place.
   * @param {Set<string>} seen - Style ids on the way here: a reference loop ends.
   */
  const apply = (element, style, seen) => {
    for (const id of (attribute(element, 'style') || '').split(/\s+/)) {
      const referenced = styles.get(id);
      if (!id || !referenced || seen.has(id)) continue;
      seen.add(id);
      apply(referenced, style, seen);
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
  };

  return (element, inherited) => {
    const style = {...inherited};
    apply(element, style, new Set());
    return style;
  };
}

/**
 * A p's text as WebVTT cue text: br as a line break, each run of text in its own italic, bold and
 * underline tags (so a line break or an upright span inside an italic p keeps its style), white
 * space collapsed as TTML's default (xml:space="default") does.
 * @param {Element} paragraph
 * @param {(element: Element, inherited: TtmlStyle) => TtmlStyle} resolve
 * @param {TtmlStyle} inherited - The style of the p's ancestors.
 * @return {string} Empty when the p holds no text.
 */
function cueText(paragraph, resolve, inherited) {
  /**
   * @param {string} text
   * @param {TtmlStyle} style
   * @return {string}
   */
  const wrap = (text, style) => {
    let out = text;
    if (style.underline) out = `<u>${out}</u>`;
    if (style.bold) out = `<b>${out}</b>`;
    if (style.italic) out = `<i>${out}</i>`;
    return out;
  };
  /**
   * @param {Node} node
   * @param {TtmlStyle} style - The node's own.
   * @return {string}
   */
  const render = (node, style) => {
    let out = '';
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        const text = (child.nodeValue || '').replace(/\s+/g, ' ');
        out += /\S/.test(text) ? wrap(escapeCueText(text), style) : text;
      } else if (child.nodeType === 1) {
        const element = /** @type {Element} */ (child);
        if (element.localName === 'br') out += '\n';
        else if (element.localName === 'span') out += render(element, resolve(element, style));
      }
    }
    return out;
  };

  // A blank line would end the cue: each line trimmed, empty ones dropped.
  return render(paragraph, resolve(paragraph, inherited)).split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line).join('\n');
}

/**
 * @typedef {Object} TtmlCue
 * @property {number} start - Seconds.
 * @property {number} end - Seconds; Infinity when nothing ends it.
 * @property {string} text - WebVTT cue text.
 */

/**
 * The cues of a parsed TTML document, in document order. Times nest: a p's begin and end count
 * from its div's and body's begin (in a seq container, from the end of the element before it),
 * and it ends no later than they do. Timing on a span is not read: its text shows for the p.
 * @param {Document} doc
 * @return {TtmlCue[]}
 */
export function ttmlCues(doc) {
  const root = doc.documentElement;
  if (!root || root.localName !== 'tt') return [];
  const rates = ttmlRates((name) => attribute(root, name));
  const resolve = styleResolver(doc);
  /** @type {TtmlCue[]} */
  const cues = [];
  const plain = {italic: false, bold: false, underline: false};

  /**
   * @param {Element} element
   * @param {number} parentBegin
   * @param {number} parentEnd
   * @param {TtmlStyle} style
   * @return {number} Where the element ends: Infinity when nothing ends it.
   */
  const walk = (element, parentBegin, parentEnd, style) => {
    const begin = parseTtmlTime(attribute(element, 'begin'), rates);
    const start = parentBegin + (Number.isFinite(begin) ? begin : 0);
    const end = parseTtmlTime(attribute(element, 'end'), rates);
    const dur = parseTtmlTime(attribute(element, 'dur'), rates);
    // With both, the earlier end counts.
    let stop = Number.isFinite(end) ? parentBegin + end : parentEnd;
    if (Number.isFinite(dur)) stop = Math.min(stop, start + dur);
    stop = Math.min(stop, parentEnd);

    if (element.localName === 'p') {
      const text = cueText(element, resolve, style);
      if (text && stop > start) cues.push({start, end: stop, text});
      return stop;
    }
    const own = element.localName === 'body' || element.localName === 'div' ? resolve(element, style) : style;
    const sequence = attribute(element, 'timeContainer') === 'seq';
    let base = start;
    for (const child of Array.from(element.children)) {
      if (child.localName !== 'div' && child.localName !== 'p') continue;
      const childEnd = walk(child, base, stop, own);
      if (sequence && Number.isFinite(childEnd)) base = childEnd;
    }
    return stop;
  };

  for (const body of Array.from(root.children)) {
    if (body.localName === 'body') walk(body, 0, Infinity, plain);
  }
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
 * @return {string} WebVTT; only the header when the document holds no cue or is no TTML.
 */
export function ttml2vtt(text, timeFormat) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const cues = closeOpenEnds(ttmlCues(doc));
  const blocks = ['WEBVTT'];
  for (const cue of cues) {
    blocks.push(blocks.length + '\n' + timeFormat(cue.start) + ' --> ' + timeFormat(cue.end) + '\n' + cue.text);
  }
  return blocks.join('\n\n');
}
