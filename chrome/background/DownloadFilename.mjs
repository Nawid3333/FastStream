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
const FORBIDDEN = /["*:<>?|\/\\\u0000-\u001F\u007F]/g;

// Invisible and text-direction characters: Firefox refuses some of them
// (U+202E, U+200B) and the rest would be saved unseen, so remove them.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// Every space character that is not the ordinary space; Firefox refuses
// U+00A0, so turn all of them into a plain space.
const UNUSUAL_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// Windows refuses these names before the first dot, in any letter case.
const DEVICE_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

const MAX_LENGTH = 200;
const FALLBACK_NAME = 'download';

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

  // Only the edges of the name; spaces and dots inside it stay.
  name = name.replace(/^ +/, '').replace(/[. ]+$/, '');

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
    if (after.length >= 1 && after.length <= 10 && !after.includes(' ')) {
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
