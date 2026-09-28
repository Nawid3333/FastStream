// @ts-check

/**
 * Parses the "Custom source patterns" option: one pattern per line, the source type it
 * detects, then a regex in slashes, `<type> /<regex>/<flags>` (e.g. `hls /\/live\/\d+/i`).
 * Empty lines, `#` and `//` comments, and `@` command lines (reserved) are skipped.
 *
 * A malformed line is reported and left out. The old parser took the text between the
 * first character and the last slash whatever it was: `hls` alone gave the empty regex,
 * which matches every URL, so every response the browser received was detected as a
 * stream; `hls live` gave the regex `l`.
 *
 * @param {string} text - The option's text.
 * @return {{patterns: Array<{ext: string, regex: string, flags: string}>,
 *   errors: Array<{line: number, text: string, reason: string}>}}
 */
export function parseCustomSourcePatterns(text) {
  const patterns = [];
  const errors = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('//') || line.startsWith('@')) {
      continue;
    }

    const space = line.search(/\s/);
    const ext = space === -1 ? line : line.substring(0, space);
    const regexStr = space === -1 ? '' : line.substring(space).trim();
    const lastSlash = regexStr.lastIndexOf('/');
    if (!regexStr.startsWith('/') || lastSlash < 1) {
      errors.push({line: i + 1, text: line, reason: 'expected `<type> /<regex>/<flags>`'});
      continue;
    }

    const regex = regexStr.substring(1, lastSlash);
    const flags = regexStr.substring(lastSlash + 1);
    if (regex.length === 0) {
      errors.push({line: i + 1, text: line, reason: 'the regex is empty, so it would match every URL'});
      continue;
    }
    if (!/^[dgimsuvy]*$/.test(flags)) {
      errors.push({line: i + 1, text: line, reason: `unknown regex flags "${flags}"`});
      continue;
    }
    try {
      new RegExp(regex, flags);
    } catch (e) {
      errors.push({line: i + 1, text: line, reason: 'invalid regex: ' + e.message});
      continue;
    }
    patterns.push({ext, regex, flags});
  }
  return {patterns, errors};
}
