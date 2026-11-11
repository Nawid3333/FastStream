// @ts-check
// An MP4's audio tracks: which ones Firefox can play, what to call them, and which one to start
// with. MP4Player played the first audio track, always: a film whose first track is Dolby
// (AC-3, E-AC-3), which Firefox does not decode, failed outright ("Failed to create
// SourceBuffers: Codec not supported") even with an AAC track next to it, and a second
// language could not be chosen at all (#665). Kept apart from MP4Player, which imports the
// vendored mp4box that unit tests do not have.

/**
 * The type a SourceBuffer for an MP4 audio track is made with. mp4box calls Opus "Opus"; the
 * MediaSource wants "opus".
 * @param {string} codec - mp4box's codec string for the track.
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
 * The track's own name (its hdlr box's), which ffmpeg fills from a source's track title
 * ("English 5.1", "Commentary"), or '' for none or a muxer's default name. Two tracks in one
 * language are told apart by it.
 * @param {?string|undefined} name - mp4box's track name.
 * @return {string}
 */
export function audioTrackLabel(name) {
  const text = (name || '').replace(/\u0000/g, '').trim();
  return GENERIC_HANDLER_NAME.test(text) ? '' : text;
}

/**
 * The audio track to start with: the one chosen before for this video, if it is there;
 * otherwise, among those in the preferred language (all of them when none is), the one the
 * file marks as enabled, else the first in the file. Only tracks Firefox can play are
 * offered.
 * @template {{id: string}} L
 * @param {Array<L>} levels - The playable tracks' levels, in file order.
 * @param {(level: L) => boolean} isEnabled - Whether the file marks its track enabled (tkhd).
 * @param {?string} remembered - The level chosen before (LevelManager), or null.
 * @param {(levels: Array<L>) => Array<L>} preferLanguage - Narrows to the preferred language,
 *   or returns them all (LevelManager.filterAudioLevelsByLanguage).
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
