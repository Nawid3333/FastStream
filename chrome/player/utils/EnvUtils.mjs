/**
 * Utility functions for environment and platform detection.
 */
export class EnvUtils {
  /**
   * Checks if the browser is Chrome.
   * @return {boolean} True if Chrome, false otherwise.
   */
  static isChrome() {
    return navigator.userAgent.indexOf('Chrome') !== -1;
  }

  /**
   * Checks if the browser is Firefox.
   * @return {boolean} True if Firefox, false otherwise.
   */
  static isFirefox() {
    return navigator.userAgent.indexOf('Firefox') !== -1;
  }

  /**
   * Checks if the browser is Safari.
   * @return {boolean} True if Safari, false otherwise.
   */
  static isSafari() {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  }

  /**
   * Checks if running as a browser extension.
   * @return {boolean} True if extension, false otherwise.
   */
  static isExtension() {
    return typeof chrome !== 'undefined' && !!chrome?.extension;
  }

  /**
   * Opens a URL outside the player. Prefers chrome.tabs.create when running
   * as the extension: a raw window.open() from inside the player's iframe is
   * an opener-attributed tab creation the background's popup/popunder guard
   * (chrome.tabs.onCreated) would otherwise have to special-case, and
   * chrome.tabs.create from extension-context code doesn't set openerTabId
   * unless told to, so it's naturally exempt.
   * @param {string} url
   */
  static openExternalURL(url) {
    if (EnvUtils.isExtension()) {
      chrome?.tabs?.create({url});
    } else {
      window.open(url, '_blank');
    }
  }

  /**
   * Checks if the device is mobile.
   * @return {boolean} True if mobile, false otherwise.
   */
  static isMobile() {
    return /Mobi|Android/i.test(navigator.userAgent);
  }

  /**
   * Gets the version of the extension or web app.
   * @return {string} The version string.
   */
  static getVersion() {
    // eslint-disable-next-line prefer-const
    let version = '1.0.0.web';

    // SPLICER:WEB:INSERT_VERSION

    return this.isExtension() ? chrome.runtime.getManifest().version : version;
  }

  /**
   * Checks if the browser is in incognito/private mode.
   * @return {boolean} True if incognito, false otherwise.
   */
  static isIncognito() {
    return this.isExtension() ? chrome.extension.inIncognitoContext : false;
  }

  /**
   * Checks if the operating system is macOS.
   * @return {boolean} True if macOS, false otherwise.
   */
  static isMacOS() {
    return navigator.userAgent.indexOf('Mac OS') !== -1;
  }

  /**
   * Checks if Web Audio API is supported in the browser.
   * @return {boolean} True if supported, false otherwise.
   */
  static isWebAudioSupported() {
    return !!window.AudioContext;
  }

  /**
   * Gets the available storage space in bytes.
   * @return {Promise<number>} Available storage in bytes.
   */
  static async getAvailableStorage() {
    if (!window.navigator || !window.navigator.storage || !window.navigator.storage.estimate) {
      // 2GB
      return 2 * 1024 * 1024 * 1024;
    }
    const estimate = await window.navigator.storage.estimate().catch(() => ({quota: 2 * 1024 * 1024 * 1024, usage: 0}));
    return estimate.quota - estimate.usage;
  }
}
