// @ts-check
import {EnvUtils} from '../utils/EnvUtils.mjs';

// Each key's text in every language, in the order of LANGUAGES (the web build fills it in).
/** @type {Object<string, string[]>} */
const TranslationMap = {
  // SPLICER:WEB:INSERT_LOCALE
};

/** @type {Map<string, number>} */
const translationMapCache = new Map();

export class Localize {
  /**
   * @param {string} key - The message's name in messages.json.
   * @param {Array<string|number|undefined>} [substitutions] - What goes in for $1, $2, ...; one
   *   left undefined leaves its $n.
   * @return {string} The text, or the key when there is none.
   */
  static getMessage(key, substitutions) {
    if (EnvUtils.isExtension()) {
      // Firefox's i18n turns each substitution into a string itself.
      return chrome.i18n.getMessage(key, /** @type {string[]|undefined} */ (substitutions)) || key;
    }

    if (!Object.hasOwn(TranslationMap, key)) {
      return key;
    }

    const index = Localize.getTranslationMapIndexCached(Localize.getLanguage());
    if (index === -1) {
      return key;
    }

    return Localize.substitute(TranslationMap[key][index], substitutions);
  }

  /**
   * Puts substitutions in for $1, $2, ... in one pass.
   *
   * A pass per substitution with String.replace read `$&`, `$'` or `$1` inside a
   * substitution (an error message, say) as a replacement pattern, let a later pass
   * replace a `$2` the earlier one had put in, and found `$10` with the `$1` pass.
   * @param {string} message
   * @param {Array<*>} [substitutions]
   * @return {string}
   */
  static substitute(message, substitutions) {
    substitutions = substitutions || [];
    return message.replace(/\$(\d+)/g, (match, number) => {
      const substitution = substitutions[number - 1];
      return substitution === undefined ? match : String(substitution);
    });
  }

  static getLanguage() {
    if (EnvUtils.isExtension()) {
      return chrome.i18n.getUILanguage();
    }

    return navigator.language;
  }

  /**
   * @param {string} chosenLanguage
   * @return {number} Its place in LANGUAGES; -1 without a map.
   */
  static getTranslationMapIndexCached(chosenLanguage) {
    const cached = translationMapCache.get(chosenLanguage);
    if (cached !== undefined) {
      return cached;
    }
    const index = Localize.getTranslationMapIndex(chosenLanguage);
    translationMapCache.set(chosenLanguage, index);
    return index;
  }

  /**
   * @param {string} chosenLanguage
   * @return {number} The best match's place in LANGUAGES, English's without a match, -1 without a map.
   */
  static getTranslationMapIndex(chosenLanguage) {
    const languages = TranslationMap['LANGUAGES'];
    if (!languages) {
      return -1;
    }

    /** @type {Array<{index: number, matchLevel: number}>} */
    const matches = [];
    languages.forEach((lang, index) => {
      const matchLevel = Localize.getLanguageMatchLevel(chosenLanguage, lang);
      if (matchLevel > 0) {
        matches.push({index, matchLevel});
      }
    });

    if (matches.length === 0) {
      // A language without a locale (Swedish, Arabic) reads English, as chrome.i18n's
      // default_locale gives the extension, not the raw keys.
      return languages.indexOf('en');
    }

    // Sort by match level descending
    matches.sort((a, b) => b.matchLevel - a.matchLevel);
    return matches[0].index;
  }

  /**
   * @param {string|null|undefined} lang1 - A language tag (en-US, en_GB); none matches nothing.
   * @param {string|null|undefined} lang2
   * @return {number} How many of their leading parts are the same.
   */
  static getLanguageMatchLevel(lang1, lang2) {
    if (!lang1 || !lang2) {
      return 0; // no match
    }
    const langArr1 = lang1.toLowerCase().split(/[-_]/);
    const langArr2 = lang2.toLowerCase().split(/[-_]/);

    const minLength = Math.min(langArr1.length, langArr2.length);
    let matchLevel = 0; // number of matching parts

    for (let i = 0; i < minLength; i++) {
      if (langArr1[i] === langArr2[i]) {
        matchLevel++;
      } else {
        break;
      }
    }

    return matchLevel;
  }
}
