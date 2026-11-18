// @ts-check
// An MP4's audio tracks: which ones Firefox can play, what to call them, which one to start with.

/**
 * mp4box calls Opus "Opus"; the MediaSource wants "opus".
 * @param {string} codec
 * @return {string}
 */
export function audioTrackMime(codec) {
  return 'audio/mp4; codecs="' + (codec === 'Opus' ? 'opus' : codec) + '"';
}

// The handler names muxers write into every audio track when nobody named it: no label.
const GENERIC_HANDLER_NAME = new RegExp('^(sound ?(media )?handler|audio ?(media )?handler|core media audio|' +
  'apple sound media handler|gpac iso audio handler|l-smash audio handler|bento4 sound handler|' +
  'usp sound handler|mainconcept mp4 sound media handler|iso media file produced by .*|' +
  'video ?handler|datahandler)?$', 'i');

/**
 * The hdlr name, which ffmpeg fills from a track title; '' for none or a muxer's default.
 * @param {?string|undefined} name
 * @return {string}
 */
export function audioTrackLabel(name) {
  const text = (name || '').replace(/\u0000/g, '').trim();
  return GENERIC_HANDLER_NAME.test(text) ? '' : text;
}

/**
 * The one chosen before, else (in the preferred language) the one marked enabled, else the first.
 * @template {{id: string}} L
 * @param {Array<L>} levels
 * @param {(level: L) => boolean} isEnabled
 * @param {?string} remembered
 * @param {(levels: Array<L>) => Array<L>} preferLanguage
 * @return {?L} Null when there is none.
 */
export function pickAudioTrack(levels, isEnabled, remembered, preferLanguage) {
  if (levels.length === 0) return null;
  const kept = remembered === null ? undefined : levels.find((level) => level.id === remembered);
  if (kept) return kept;
  // In file order still: the filter keeps the order it is given.
  const inLanguage = preferLanguage(levels);
  const candidates = inLanguage.length ? inLanguage : levels;
  return candidates.find(isEnabled) || candidates[0];
}
