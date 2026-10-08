// @ts-check

// What a player's error says, for the load error the user sees. Each player emits its own
// kind with DefaultPlayerEvents.ERROR: MP4Player a sentence, the <video> element its 'error'
// event, hls.js its error data, dash.js an event carrying an error. The client's handler read
// a second argument nobody passes, so every failure showed only "Failed to load video!" and
// a user's report could not say which of a dozen causes it was.

const MAX_LENGTH = 160;

/**
 * A short description of a player error, or '' when there is nothing to say.
 * @param {*} reason - What the player emitted with DefaultPlayerEvents.ERROR.
 * @return {string}
 */
export function describePlayerError(reason) {
  // The client calls failedToLoad() with what this returns: a throw here (a getter that
  // throws, a Symbol where a string was expected) would leave the player spinning instead.
  try {
    return clip(describe(reason));
  } catch (e) {
    return '';
  }
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
