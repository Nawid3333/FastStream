// @ts-check

// dash.js errors (MediaPlayer.errors) that leave the stream stuck for good once it is up.
const STUCK_AFTER_START = [
  'MANIFEST_LOADER_LOADING_FAILURE_ERROR_CODE',
  'DOWNLOAD_ERROR_ID_MANIFEST_CODE',
  'DOWNLOAD_ERROR_ID_SIDX_CODE',
  'DOWNLOAD_ERROR_ID_CONTENT_CODE',
  'DOWNLOAD_ERROR_ID_INITIALIZATION_CODE',
  'DOWNLOAD_ERROR_ID_XLINK_CODE',
  'MANIFEST_ERROR_ID_PARSE_CODE',
  'MANIFEST_ERROR_ID_NOSTREAMS_CODE',
  'MANIFEST_ERROR_ID_MULTIPLEXED_CODE',
  'MEDIASOURCE_TYPE_UNSUPPORTED_CODE',
  'NO_SUPPORTED_KEY_IDS',
];
// A live stream's manifest refresh that did not load: the next refresh may.
const LIVE_REFRESH = ['MANIFEST_LOADER_LOADING_FAILURE_ERROR_CODE', 'DOWNLOAD_ERROR_ID_MANIFEST_CODE'];

/**
 * @param {Object<string, *>} errors
 * @param {boolean} [live] - Its manifest refresh failures stay dash.js's.
 * @return {Set<number>} Reported as the player's error once the stream is up.
 */
export function stuckAfterStart(errors, live = false) {
  const codes = new Set();
  for (const name of STUCK_AFTER_START) {
    if (live && LIVE_REFRESH.includes(name)) continue;
    const code = errors?.[name];
    if (Number.isFinite(code)) codes.add(code);
  }
  return codes;
}
