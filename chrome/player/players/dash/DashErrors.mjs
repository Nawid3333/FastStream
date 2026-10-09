// @ts-check

// The dash.js errors (MediaPlayer.errors codes) that leave the stream stuck for good once it is
// up, with no error on the <video> element: DashPlayer reports them as the player's error,
// and the client shows it or builds the player again. Before, every dash.js error after the
// start was dropped, and such a stream sat behind a spinner for ever.
//
// Read from dash.js 5.2.1's errHandler.error calls: a download that ran out of retries (the
// manifest, an index, a segment, an init segment, an xlink), a manifest that cannot be used
// (no duration, no stream, a muxed track it cannot play), a type MSE does not take, no key
// it can use. Left to dash.js: a live manifest refresh that did not parse (MANIFEST_LOADER_
// PARSING_FAILURE: the next refresh may), the clock sync (TIME_SYNC_FAILED: it plays on with
// the local clock), and a subtitle that did not parse (TIMED_TEXT_ERROR_ID_PARSE).
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
 * @param {Object<string, *>} errors - dash.js's MediaPlayer.errors.
 * @param {boolean} [live] - A live (dynamic) stream: its manifest refresh failures stay dash.js's.
 * @return {Set<number>} The codes to report as the player's error once the stream is up.
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
