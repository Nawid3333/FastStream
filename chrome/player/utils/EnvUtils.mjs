// @ts-check
import {MessageTypes} from '../enums/MessageTypes.mjs';

export class EnvUtils {
  /** @type {?string} Firefox's answer to os(). */
  static knownOs = null;

  /**
   * @return {boolean}
   */
  static isExtension() {
    return typeof chrome !== 'undefined' && !!chrome?.extension;
  }

  /**
   * Opens a tab with no opener, which the background's popup guard leaves alone. A framed
   * player has no chrome.tabs and asks the background.
   * @param {string} url
   */
  static openExternalURL(url) {
    if (EnvUtils.isExtension()) {
      if (chrome.tabs) {
        chrome.tabs.create({url});
      } else {
        chrome.runtime.sendMessage({type: MessageTypes.OPEN_EXTERNAL_URL, url})
            .catch((e) => console.error('Opening the page failed', e));
      }
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  /**
   * @return {boolean}
   */
  static isMobile() {
    return /Mobi|Android/i.test(navigator.userAgent);
  }

  /**
   * @return {string}
   */
  static getVersion() {
    // eslint-disable-next-line prefer-const
    let version = '1.0.0.web';

    // SPLICER:WEB:INSERT_VERSION

    return this.isExtension() ? chrome.runtime.getManifest().version : version;
  }

  /**
   * @return {boolean}
   */
  static isIncognito() {
    return this.isExtension() ? chrome.extension.inIncognitoContext : false;
  }

  /**
   * The operating system as Firefox says it ('win', 'mac', 'linux', ...). navigator.platform
   * says "Win32" everywhere under resistFingerprinting: only without a runtime.
   * @return {Promise<string>}
   */
  static async os() {
    try {
      const info = await globalThis.chrome?.runtime?.getPlatformInfo?.();
      if (info?.os) {
        EnvUtils.knownOs = info.os;
        return info.os;
      }
    } catch (e) {
      // No answer: what the page is told.
    }
    if (/Android/i.test(String(globalThis.navigator?.userAgent || ''))) return 'android';
    const platform = String(globalThis.navigator?.platform || '');
    return platform.startsWith('Win') ? 'win' : platform.startsWith('Mac') ? 'mac' : 'linux';
  }

  /**
   * Firefox for Android: no mpv helper there. Firefox's answer once os() has it, the user agent until then.
   * @return {boolean}
   */
  static isAndroid() {
    if (EnvUtils.knownOs) return EnvUtils.knownOs === 'android';
    return /Android/i.test(String(globalThis.navigator?.userAgent || ''));
  }

  /**
   * Firefox's answer once os() has it, what the page is told until then.
   * @return {boolean}
   */
  static isWindows() {
    if (EnvUtils.knownOs) return EnvUtils.knownOs === 'win';
    return String(globalThis.navigator?.platform || '').startsWith('Win');
  }

  /**
   * @return {boolean}
   */
  static isMacOS() {
    return navigator.userAgent.indexOf('Mac OS') !== -1;
  }

  /**
   * @return {boolean}
   */
  static isWebAudioSupported() {
    return !!window.AudioContext;
  }

  /**
   * @return {Promise<number>} Available storage in bytes.
   */
  static async getAvailableStorage() {
    if (!window.navigator || !window.navigator.storage || !window.navigator.storage.estimate) {
      return 2 * 1024 * 1024 * 1024;
    }
    const estimate = await window.navigator.storage.estimate().catch(() => ({quota: 2 * 1024 * 1024 * 1024, usage: 0}));
    return /** @type {number} */ (estimate.quota) - /** @type {number} */ (estimate.usage);
  }
}
