import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import {afterAll, afterEach, describe, expect, it, vi} from 'vitest';

// The web build has no chrome.i18n: build.mjs writes every locale's texts into Localize.mjs
// (SPLICER:WEB:INSERT_LOCALE), English first, and getMessage picks the column of the
// browser's language. A language outside the 16 locales (Swedish, Arabic, Czech) matched no
// column, and every text on the page showed as its key ("player_loading"). This builds the
// same map from the real locales into a copy of the module and asks it in such a language.

const chromeDir = path.resolve(import.meta.dirname, '../../chrome');
const localesDir = path.join(chromeDir, '_locales');
const tempDirs = [];

/**
 * @return {Object<string, string[]>} The map build.mjs inserts: LANGUAGES (en first, the
 *     rest sorted) and, per English key, one text per language.
 */
function translationMap() {
  const locales = fs.readdirSync(localesDir).map((code) => ({
    code,
    messages: JSON.parse(fs.readFileSync(path.join(localesDir, code, 'messages.json'), 'utf8')),
  }));
  locales.sort((a, b) => a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.code.localeCompare(b.code));
  // Made from entries, not written key by key: the keys come from the locale files, and a
  // write by such a key is CodeQL's js/remote-property-injection.
  return Object.fromEntries([
    ['LANGUAGES', locales.map((locale) => locale.code)],
    ...Object.keys(locales[0].messages).map((key) => [
      key, locales.map((locale) => (locale.messages[key] || locales[0].messages[key]).message),
    ]),
  ]);
}

/**
 * @return {Promise<typeof import('../../chrome/player/modules/Localize.mjs').Localize>} A
 *     fresh Localize with the map inserted, as the web build has it.
 */
async function webLocalize() {
  const source = fs.readFileSync(path.join(chromeDir, 'player/modules/Localize.mjs'), 'utf8');
  const marker = '// SPLICER:WEB:INSERT_LOCALE';
  expect(source).toContain(marker);
  const envUtils = url.pathToFileURL(path.join(chromeDir, 'player/utils/EnvUtils.mjs')).href;
  const text = JSON.stringify(translationMap(), null, 2);
  const spliced = source.replace(marker, text.substring(1, text.length - 1).trim())
      .replace('\'../utils/EnvUtils.mjs\'', JSON.stringify(envUtils));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-localize-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'Localize.mjs');
  fs.writeFileSync(file, spliced);
  return (await import(url.pathToFileURL(file).href)).Localize;
}

const english = JSON.parse(fs.readFileSync(path.join(localesDir, 'en/messages.json'), 'utf8'));
const german = JSON.parse(fs.readFileSync(path.join(localesDir, 'de/messages.json'), 'utf8'));
const portuguese = JSON.parse(fs.readFileSync(path.join(localesDir, 'pt_BR/messages.json'), 'utf8'));

describe('Localize on the web build', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, {recursive: true, force: true});
  });

  it('shows English, not the key, for a language without a locale', async () => {
    const Localize = await webLocalize();
    for (const language of ['sv', 'sv-SE', 'ar', 'cs-CZ']) {
      vi.stubGlobal('navigator', {language});
      expect(Localize.getMessage('player_loading'), language).toBe(english.player_loading.message);
    }
  });

  it('still picks the locale of a language it has', async () => {
    const Localize = await webLocalize();
    vi.stubGlobal('navigator', {language: 'de-AT'});
    expect(Localize.getMessage('player_loading')).toBe(german.player_loading.message);
    vi.stubGlobal('navigator', {language: 'pt'});
    expect(Localize.getMessage('player_loading')).toBe(portuguese.player_loading.message);
    // Substitutions still apply.
    vi.stubGlobal('navigator', {language: 'sv'});
    expect(Localize.getMessage('player_welcometext', ['1.2.3'])).toBe('Welcome to FastStream v1.2.3!');
  });
});
