/**
 * Maps the filename the player asks for to one Firefox accepts to save.
 *
 * Firefox refuses chrome.downloads.download() calls whose filename contains
 * characters it does not allow, for example the colon in "clip@00:05.png";
 * the call then rejects, the player gets no download and the user sees
 * nothing happen. Every measured refusal is mapped to a close safe name.
 */

// Firefox refuses names containing these, so each becomes "_"; "/" and "\"
// would not be refused, but they make subfolders instead of staying in the name.
// Cc is every control character, U+0000-U+001F and U+007F-U+009F.
const FORBIDDEN = /["*:<>?|\/\\\p{Cc}]/gu;

// Firefox refuses every format character (Cf: the soft hyphen, zero-width and
// text-direction marks, the joiners inside emoji sequences, tags), and they would
// be saved unseen anyway, so they are removed.
const INVISIBLE = /\p{Cf}/gu;

// Firefox refuses the space, line and paragraph separators (Z) other than the
// ordinary space, so each becomes an ordinary space.
const UNUSUAL_SPACES = /(?! )\p{Z}/gu;

// Windows refuses these names before the first dot, in any letter case.
const DEVICE_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

const MAX_LENGTH = 200;
const FALLBACK_NAME = 'download';

/**
 * @param {string} text - What follows a name's last dot.
 * @return {boolean} Whether it is kept as the extension: 1-10 characters, no
 *     space or dot.
 */
function isExtension(text) {
  return text.length >= 1 && text.length <= 10 && !/[ .]/.test(text);
}

/**
 * @param {string} filename - The name the player asked for.
 * @return {string} A name Firefox saves, as close to it as possible.
 */
export function sanitizeDownloadFilename(filename) {
  if (typeof filename !== 'string') {
    return FALLBACK_NAME;
  }

  let name = filename
      .replace(FORBIDDEN, '_')
      .replace(INVISIBLE, '')
      .replace(UNUSUAL_SPACES, ' ');

  // Only the edges of the name; spaces and dots inside it stay. Firefox refuses
  // a name that starts with a space or a dot, or ends with one.
  name = name.replace(/[. ]+$/, '');
  const start = /^[. ]*/.exec(name)[0];
  name = name.slice(start.length);
  // A name that was only an extension (".png") keeps it, after the fallback name.
  if (start.endsWith('.') && isExtension(name)) {
    name = FALLBACK_NAME + '.' + name;
  }

  if (name === '') {
    return FALLBACK_NAME;
  }

  if (DEVICE_NAMES.test(name.split('.')[0])) {
    name = '_' + name;
  }

  // Keep at most MAX_LENGTH characters: shorten the base, keep the
  // extension (the last dot and what follows) when it looks like one.
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
    // Never cut between the two halves of a surrogate pair.
    while (base.length > 0 && /[\uD800-\uDBFF]$/.test(base)) {
      base = base.slice(0, -1);
    }
    // The cut can leave a space or a dot at the end, which Firefox refuses there.
    if (!extension) {
      base = base.replace(/[. ]+$/, '');
    }
  }

  if (base === '') {
    // Only an extension was left, so the download still gets a name.
    base = FALLBACK_NAME;
  }

  return base + extension;
}
