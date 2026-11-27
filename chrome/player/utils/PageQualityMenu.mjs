// @ts-check

// Qualities a page's player offers only in its own menu (page-quality-control.js): FastStream lists them, the page
// switches its player to the one picked, and FastStream plays the file the page loaded then.

/**
 * @typedef {{label: string, height: number, auto: boolean, selected: boolean}} PageChoice
 * @typedef {{url: ?string, label: string, height: number, control?: {id: number, index: number}}} PageQuality
 */

const MAX_LABEL = 40;

/**
 * The size class a picture is called by ("1080p" for 1920x800 too): its short side, or its long one's 16:9 share.
 * @param {number} width
 * @param {number} height
 * @return {number}
 */
export function sizeClass(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  return w >= h ? Math.max(h, Math.round(w * 9 / 16)) : Math.max(w, Math.round(h * 9 / 16));
}

/**
 * The page menu's qualities as a source's: the one playing gets the source's address, the others are switched to
 * through the page. "Auto" is left out: it is no file.
 * @param {*} answer - The page's answer, {id, choices}.
 * @param {string} url - The source playing.
 * @param {number} width - What it plays, 0 before its metadata.
 * @param {number} height
 * @return {?PageQuality[]} Null without two qualities.
 */
export function menuQualities(answer, url, width, height) {
  if (!answer || typeof answer.id !== 'number' || !Array.isArray(answer.choices)) return null;
  /** @type {Array<PageQuality & {selected: boolean}>} */
  const entries = [];
  answer.choices.slice(0, 16).forEach((/** @type {*} */ choice, /** @type {number} */ index) => {
    const label = typeof choice?.label === 'string' ? choice.label.slice(0, MAX_LABEL) : '';
    const heightOf = Number(choice?.height);
    if (!choice || choice.auto || !(heightOf > 0) || !label) return;
    entries.push({url: null, label, height: Math.round(heightOf), control: {id: answer.id, index}, selected: !!choice.selected});
  });
  if (new Set(entries.map((entry) => entry.height)).size < 2) return null;
  const size = sizeClass(width, height);
  const playing = entries.find((entry) => entry.selected) ||
    (size > 0 ? entries.reduce((best, entry) =>
      Math.abs(entry.height - size) < Math.abs(best.height - size) ? entry : best) : null);
  if (!playing) return null;
  playing.url = url;
  return entries.map(({selected, ...entry}) => entry);
}

/**
 * Whether FastStream plays the file the page switched to: a web address of the played one's origin (no step down
 * from https), as the page's own lists keep to its host (PageQualityPick.listForSource): it gets that request's
 * headers.
 * @param {*} next
 * @param {string} played
 * @return {boolean}
 */
export function playableSwitch(next, played) {
  if (typeof next !== 'string' || next.length > 8192) return false;
  try {
    const to = new URL(next);
    const from = new URL(played);
    return /^https?:$/.test(to.protocol) && to.origin === from.origin;
  } catch (e) {
    return false;
  }
}

/**
 * Whether an automatic switch gets closer to the quality wanted (Infinity: the highest), by the sizes really played:
 * a label may name a file no bigger than the one playing.
 * @param {number} wanted
 * @param {number} now - The size class playing.
 * @param {number} next - The size class switched to.
 * @return {boolean}
 */
export function closerTo(wanted, now, next) {
  if (!(next > 0) || next === now) return false;
  if (wanted === Infinity) return next > now;
  return Math.abs(next - wanted) < Math.abs(now - wanted);
}
