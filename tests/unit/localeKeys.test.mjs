import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// Localize.getMessage answers a key the locales lack with the key itself, and
// chrome.i18n.getMessage with nothing, so a missing key shows on screen as its name (the
// convolver's store failure alerted "audioconvolver_fileerror") and nothing fails. This
// checks every key the code names against the English locale, which the others fall
// back to.

const chromeDir = path.resolve(import.meta.dirname, '../../chrome');
const english = JSON.parse(fs.readFileSync(path.join(chromeDir, '_locales/en/messages.json'), 'utf8'));

/**
 * @param {string} dir - The directory to search.
 * @return {string[]} The scripts, pages and manifest under it, without the locales.
 */
function sourceFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '_locales' ? [] : sourceFiles(file);
    }
    return /\.(mjs|js|html)$/.test(entry.name) || entry.name === 'manifest.json' ? [file] : [];
  });
}

/**
 * @return {{keys: Map<string, Set<string>>, prefixes: Map<string, Set<string>>}} The
 *     keys the code names, and the starts of the keys it builds ('loop_menu_' + name),
 *     each with the files that name it.
 */
function namedKeys() {
  const keys = new Map();
  const prefixes = new Map();
  const add = (map, key, file) => map.set(key, (map.get(key) || new Set()).add(file));
  for (const file of sourceFiles(chromeDir)) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.relative(chromeDir, file).split(path.sep).join('/');
    // getI18nMessage is what i18n.mjs gives the extension's pages (perms.mjs, options.mjs).
    for (const match of source.matchAll(/\b(?:(?:Localize|i18n)\.getMessage|getI18nMessage)\(\s*(['"])([^'"]+)\1\s*([,)+])/g)) {
      add(match[3] === '+' ? prefixes : keys, match[2], name);
    }
    // getMessage(count === 1 ? 'one' : 'other')
    for (const match of source.matchAll(/\b(?:Localize|i18n)\.getMessage\([^'"()]*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*[,)]/g)) {
      add(keys, match[1], name);
      add(keys, match[2], name);
    }
    for (const match of source.matchAll(/\bdata-i18n(?:-label)?="([^"]+)"/g)) {
      add(keys, match[1], name);
    }
    for (const match of source.matchAll(/__MSG_(\w+)__/g)) {
      add(keys, match[1], name);
    }
  }
  return {keys, prefixes};
}

describe('Message keys', () => {
  it('names only keys the English locale has', () => {
    const {keys} = namedKeys();
    // A pattern that stopped matching would make the check below pass on nothing.
    expect(keys.size).toBeGreaterThanOrEqual(300);
    expect(keys.has('player_fragment_failed_plural')).toBe(true);
    expect(keys.has('extension_name')).toBe(true);
    expect(keys.has('perms_page_granted')).toBe(true);
    const missing = [...keys].filter(([key]) => !Object.hasOwn(english, key))
        .map(([key, files]) => `${key} (${[...files].join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('builds only keys the English locale has a start of', () => {
    const {prefixes} = namedKeys();
    expect(prefixes.has('loop_menu_toggle_')).toBe(true);
    const unmatched = [...prefixes.keys()].filter((prefix) => !Object.keys(english).some((key) => key.startsWith(prefix)));
    expect(unmatched).toEqual([]);
  });

  it('writes no English text into the player\'s UI', () => {
    // Text written into the code shows in English in every language ("Type", "Play",
    // "Edit subtitle text" and "Press a key" did); what the user reads goes through
    // Localize. These stay, each for its reason:
    const allowed = [
      // Two abbreviations on a small button, whose tooltip is localized.
      'player/ui/audio/AudioChannelMixer.mjs: EQ/Comp',
      // The label of a hidden, aria-hidden file input, which nothing reads.
      'player/ui/subtitles/SubtitlesManager.mjs: Upload subtitle file',
      // A fallback never shown: CHANNEL_NAMES names every one of the MAX_AUDIO_CHANNELS.
      'player/ui/audio/OutputConvolver.mjs: Channel',
    ];
    const patterns = [
      /\.(?:textContent|innerText|title|placeholder|ariaLabel)\s*=\s*(['"`])([A-Za-z][^'"`]*[a-z][^'"`]*)\1/g,
      /AlertPolyfill\.(?:alert|prompt|confirm)\(\s*(['"`])([^'"`]+)\1/g,
      /AlertPolyfill\.toast\(\s*'[a-z]+',\s*(['"`])([^'"`]+)\1/g,
      /createDropdown\([^,]+,\s*(['"`])([^'"`]+)\1/g,
      /WebUtils\.setLabels\([^,]+,\s*(['"`])([^'"`]+)\1/g,
    ];
    const found = [];
    for (const file of sourceFiles(path.join(chromeDir, 'player'))) {
      const name = path.relative(chromeDir, file).split(path.sep).join('/');
      // The vendored libraries.
      if (name.startsWith('player/modules/') || !/\.m?js$/.test(name)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          // Example URLs, and the product's name.
          if (match[2].includes('://') || match[2].startsWith('FastStream')) continue;
          found.push(`${name}: ${match[2]}`);
        }
      }
      // A template literal anywhere on the right of the assignment. "Also used by ${...}"
      // and "${shown} / ${total} matched" got past the patterns above, which stop at the
      // first quote (the one in join(', ')) and want a letter first.
      for (const match of source.matchAll(/\.(?:textContent|innerText|title|placeholder|ariaLabel)\s*=\s*[^;\n]*?`([^`]*)`/g)) {
        const text = match[1].replace(/\$\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
        // A unit, and the product's name.
        if (!/[A-Za-z]{3,}/.test(text.replace(/\bkbps\b/g, '')) || text.startsWith('FastStream')) continue;
        found.push(`${name}: ${text}`);
      }
    }
    // The exceptions are found, so the patterns still match.
    expect(allowed.filter((entry) => !found.includes(entry))).toEqual([]);
    expect(found.filter((entry) => !allowed.includes(entry))).toEqual([]);
  });
});

describe('Every locale', () => {
  // A locale is compared with English, not only with combined-locales.json: one that lacks
  // a key shows that text in English, one that has a key English dropped carries dead
  // text, and one whose $1/$2 differ from English's loses or garbles what is put in.
  const placeholders = (message) => (message.match(/[$]\d/g) || []).sort().join(' ');
  for (const locale of fs.readdirSync(path.join(chromeDir, '_locales'))) {
    it(`${locale} has English's keys, each with English's placeholders`, () => {
      const messages = JSON.parse(fs.readFileSync(path.join(chromeDir, '_locales', locale, 'messages.json'), 'utf8'));
      expect(Object.keys(messages).sort()).toEqual(Object.keys(english).sort());
      const empty = Object.keys(messages).filter((key) => !messages[key].message?.trim());
      expect(empty).toEqual([]);
      const differing = Object.keys(english).filter((key) => Object.hasOwn(messages, key) &&
          placeholders(messages[key].message) !== placeholders(english[key].message));
      expect(differing).toEqual([]);
    });
  }
});

describe('combined-locales.json', () => {
  it('holds the same texts as the locales\' messages.json', () => {
    // It fell behind the locales (15 keys missing, 17 only in English), and `pnpm run
    // split-locales` writes it over them. Changed a locale? Run `pnpm run combine-locales`.
    const combined = JSON.parse(fs.readFileSync(path.join(chromeDir, '../combined-locales.json'), 'utf8'));
    const expected = {};
    for (const locale of fs.readdirSync(path.join(chromeDir, '_locales'))) {
      const messages = JSON.parse(fs.readFileSync(path.join(chromeDir, '_locales', locale, 'messages.json'), 'utf8'));
      for (const [key, value] of Object.entries(messages)) {
        // Own keys only, and the locale folder name as the key: a key like __proto__
        // would end up as a real member of expected (CodeQL js/remote-property-injection).
        if (!Object.hasOwn(messages, key)) continue;
        (expected[key] ||= {})[locale] = value.message;
      }
    }
    expect(Object.keys(expected).length).toBeGreaterThanOrEqual(400);
    expect(combined).toEqual(expected);
  });
});
