// @ts-check

// Firefox refuses these; "/" and "\" would make subfolders. Cc: control characters.
const FORBIDDEN = /["*:<>?|\/\\\p{Cc}]/gu;

// Firefox refuses format characters (Cf), and they would be saved unseen.
const INVISIBLE = /\p{Cf}/gu;

// Firefox refuses separators (Z) other than the ordinary space.
const UNUSUAL_SPACES = /(?! )\p{Z}/gu;

// Windows refuses these names before the first dot, in any letter case.
const DEVICE_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

const MAX_LENGTH = 200;
const FALLBACK_NAME = 'download';

/**
 * @param {string} text
 * @return {boolean}
 */
function isExtension(text) {
  return text.length >= 1 && text.length <= 10 && !/[ .]/.test(text);
}

/**
 * @param {string} filename
 * @return {string}
 */
export function sanitizeDownloadFilename(filename) {
  if (typeof filename !== 'string') {
    return FALLBACK_NAME;
  }

  let name = filename
      .replace(FORBIDDEN, '_')
      .replace(INVISIBLE, '')
      .replace(UNUSUAL_SPACES, ' ');

  // Firefox refuses a name that starts or ends with a space or a dot.
  name = name.replace(/[. ]+$/, '');
  const start = /** @type {RegExpExecArray} */ (/^[. ]*/.exec(name))[0];
  name = name.slice(start.length);
  if (start.endsWith('.') && isExtension(name)) {
    name = FALLBACK_NAME + '.' + name;
  }

  if (name === '') {
    return FALLBACK_NAME;
  }

  if (DEVICE_NAMES.test(name.split('.')[0])) {
    name = '_' + name;
  }

  const lastDot = name.lastIndexOf('.');
  let base = name;
  let extension = '';
  if (lastDot !== -1) {
    const after = name.slice(lastDot + 1);
    if (isExtension(after)) {
      extension = name.slice(lastDot);
      base = name.slice(0, lastDot);
    }
  }

  if (base.length + extension.length > MAX_LENGTH) {
    base = base.slice(0, MAX_LENGTH - extension.length);
    // Never cut a surrogate pair.
    while (base.length > 0 && /[\uD800-\uDBFF]$/.test(base)) {
      base = base.slice(0, -1);
    }
    // The cut can leave a space or a dot at the end, which Firefox refuses.
    if (!extension) {
      base = base.replace(/[. ]+$/, '');
    }
  }

  if (base === '') {
    base = FALLBACK_NAME;
  }

  return base + extension;
}
