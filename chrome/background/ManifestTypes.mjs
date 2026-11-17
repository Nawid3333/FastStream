// @ts-check
import {PlayerModes} from '../player/enums/PlayerModes.mjs';

// Manifests only: a segment's type (video/mp4, video/mp2t) would open the player on a few seconds of it.
const MANIFEST_TYPES = new Map([
  ['application/vnd.apple.mpegurl', PlayerModes.ACCELERATED_HLS],
  ['application/x-mpegurl', PlayerModes.ACCELERATED_HLS],
  ['audio/mpegurl', PlayerModes.ACCELERATED_HLS],
  ['audio/x-mpegurl', PlayerModes.ACCELERATED_HLS],
  ['application/dash+xml', PlayerModes.ACCELERATED_DASH],
]);

/**
 * @param {Array<{name: string, value?: string}>} [headers]
 * @return {string}
 */
export function contentTypeOf(headers) {
  const header = headers?.find((h) => h.name.toLowerCase() === 'content-type');
  return (header?.value || '').split(';')[0].trim().toLowerCase();
}

/**
 * @param {Array<{name: string, value?: string}>} [headers]
 * @return {string|undefined}
 */
export function modeFromContentType(headers) {
  return MANIFEST_TYPES.get(contentTypeOf(headers));
}

// The MP4 mode reads MP4 only; these play as they are. application/ogg is how many servers name Ogg video.
const DIRECT_TYPES = ['video/webm', 'video/ogg', 'application/ogg', 'video/x-matroska', 'video/matroska'];

/**
 * The player mode for a <video>/<audio> file whose URL names no type, by its Content-Type; null for audio and pages.
 * @param {Array<{name: string, value?: string}>} [headers]
 * @return {string|null}
 */
export function modeFromMediaType(headers) {
  const type = contentTypeOf(headers);
  if (type.startsWith('audio/') || type === 'text/html' || type === 'application/xhtml+xml') {
    return null;
  }
  if (DIRECT_TYPES.includes(type)) {
    return PlayerModes.DIRECT;
  }
  return PlayerModes.ACCELERATED_MP4;
}
