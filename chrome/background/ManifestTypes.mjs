// @ts-check
import {PlayerModes} from '../player/enums/PlayerModes.mjs';

// The Content-Types a server names a manifest by. Many name theirs this way only, with no
// extension in the URL: og.bakayaro.live/m3u8/<token>, .../playlist?id=... Manifests only:
// a media segment says video/mp4 or video/mp2t, and taking one for the stream would open
// the player on a few seconds of it.
const MANIFEST_TYPES = new Map([
  ['application/vnd.apple.mpegurl', PlayerModes.ACCELERATED_HLS],
  ['application/x-mpegurl', PlayerModes.ACCELERATED_HLS],
  ['audio/mpegurl', PlayerModes.ACCELERATED_HLS],
  ['audio/x-mpegurl', PlayerModes.ACCELERATED_HLS],
  ['application/dash+xml', PlayerModes.ACCELERATED_DASH],
]);

/**
 * A response's media type, without its parameters.
 * @param {Array<{name: string, value?: string}>} [headers] - webRequest's responseHeaders.
 * @return {string} It, in lower case; '' when there is none.
 */
export function contentTypeOf(headers) {
  const header = headers?.find((h) => h.name.toLowerCase() === 'content-type');
  return (header?.value || '').split(';')[0].trim().toLowerCase();
}

/**
 * The player mode for a manifest, by its Content-Type.
 * @param {Array<{name: string, value?: string}>} [headers] - webRequest's responseHeaders.
 * @return {string|undefined} The mode, or undefined when the type names no manifest.
 */
export function modeFromContentType(headers) {
  return MANIFEST_TYPES.get(contentTypeOf(headers));
}

// Files a media element plays that the player's MP4 mode cannot read (it reads MP4 only):
// played as they are, as a .webm URL already is (URLUtils).
const DIRECT_TYPES = ['video/webm', 'video/ogg'];

/**
 * The player mode for a file a <video> or <audio> element loaded, whose URL names no type:
 * by its Content-Type. Every such file used to be taken for an MP4 video: a site's
 * notification sound or a podcast's MP3 too, which on the MPV allowlist went to mpv as the
 * page's first stream, and on a tab that is on opened the player.
 * @param {Array<{name: string, value?: string}>} [headers] - webRequest's responseHeaders.
 * @return {string|null} The mode, or null for audio, which is no video.
 */
export function modeFromMediaType(headers) {
  const type = contentTypeOf(headers);
  if (type.startsWith('audio/')) {
    return null;
  }
  if (DIRECT_TYPES.includes(type)) {
    return PlayerModes.DIRECT;
  }
  return PlayerModes.ACCELERATED_MP4;
}
