// @ts-check

// Each player emits its own kind of reason with DefaultPlayerEvents.ERROR: MP4Player a string,
// the <video> element its 'error' event, hls.js its error data, dash.js an event with an error.

const MAX_LENGTH = 160;

/**
 * A short description of a player error, or '' when there is nothing to say.
 * @param {*} reason - What the player emitted with DefaultPlayerEvents.ERROR.
 * @return {string}
 */
export function describePlayerError(reason) {
  // A throw here would leave the player spinning instead of showing the load error.
  try {
    return clip(describe(reason));
  } catch (e) {
    return '';
  }
}

// dash.js's download errors (MediaPlayer.errors).
const DASH_NETWORK_ERRORS = new Set([11, 25, 26, 27, 28, 29]);

/**
 * Whether a player error is the network's: a rebuilt player would ask the same server for the
 * same fragment, so recoverPlayer does not rebuild for it.
 * @param {*} reason - What the player emitted with DefaultPlayerEvents.ERROR.
 * @return {boolean}
 */
export function isNetworkFailure(reason) {
  try {
    if (typeof reason === 'string') {
      return /^(Range|Segment) .+ failed to load(?: \(.*\))?$/.test(reason) ||
        reason === 'Failed first fragment' || reason === 'No content range';
    }
    if (!reason || typeof reason !== 'object') return false;
    if (reason.type === 'error' && DASH_NETWORK_ERRORS.has(reason.error?.code)) return true;
    return reason.type === 'networkError';
  } catch (e) {
    return false;
  }
}

/**
 * @param {{code?: number, text?: string, page?: string, viaPage?: boolean}|undefined|null} error - FetchLoader's stats.error.
 * @return {string}
 */
export function describeLoadError(error) {
  if (!error || typeof error !== 'object') return '';
  const answer = error.code ? 'HTTP ' + error.code : (error.text || '').trim();
  if (error.viaPage) return clip(answer ? 'through the page: ' + answer : '');
  const page = error.page ? 'through the page: ' + error.page : '';
  return clip([answer, page].filter(Boolean).join('; '));
}

/**
 * @param {*} reason
 * @return {string}
 */
function describe(reason) {
  if (reason === null || reason === undefined) return '';
  if (typeof reason === 'string') return reason;
  if (typeof reason !== 'object') return String(reason);

  // The <video> element's 'error' event: the element holds the MediaError.
  const mediaError = reason.target?.error;
  if (mediaError && typeof mediaError.code === 'number') {
    return mediaErrorText(mediaError);
  }
  if (typeof reason.code === 'number' && 'message' in reason && reason.MEDIA_ERR_DECODE !== undefined) {
    return mediaErrorText(reason);
  }

  // hls.js: {type, details, fatal, response: {code, text}, error}.
  if (typeof reason.details === 'string') {
    const code = reason.response?.code;
    return reason.details + (code ? ' (HTTP ' + code + ')' : '');
  }

  // dash.js: an event with {error: {code, message}}, or now and then {error: 'text'}.
  if (typeof reason.error === 'string') return reason.error;
  if (reason.error && typeof reason.error === 'object') {
    const error = reason.error;
    if (error.message) return String(error.message);
    if (error.code !== undefined) return 'dash.js error ' + error.code;
  }

  if (reason instanceof Error || typeof reason.message === 'string') {
    return String(reason.message || reason.name || '');
  }
  return '';
}

/**
 * @param {{code: number, message?: string}} error - A MediaError.
 * @return {string}
 */
function mediaErrorText(error) {
  const message = String(error.message || '').trim();
  return 'media error ' + error.code + (message ? ': ' + message : '');
}

/**
 * @param {string} text
 * @return {string}
 */
function clip(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_LENGTH ? oneLine.slice(0, MAX_LENGTH - 1) + '…' : oneLine;
}
