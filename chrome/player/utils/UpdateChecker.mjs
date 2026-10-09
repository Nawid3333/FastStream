// SPLICER:NO_UPDATE_CHECKER:REMOVE_FILE

import {RequestUtils} from './RequestUtils.mjs';

const PACKAGE_JSON_URL = 'https://raw.githubusercontent.com/Nawid3333/FastStream/main/package.json';

/**
 * Utility for checking and comparing FastStream versions.
 */
export class UpdateChecker {
  /**
   * Fetches the latest version from the remote package.json.
   * @return {Promise<string|null>} The latest version string or null if failed.
   */
  static async getLatestVersion() {
    const xhr = await RequestUtils.requestSimple(PACKAGE_JSON_URL);
    // No answer at all (offline): requestSimple gives no request back.
    if (!xhr || xhr.status !== 200) {
      return null;
    }
    try {
      const version = JSON.parse(xhr.responseText)?.version;
      return typeof version === 'string' ? version : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Compares two version strings.
   * @param {string} currentVersion - The current version.
   * @param {string} latestVersion - The latest version.
   * @return {boolean} True if currentVersion is less than latestVersion, false otherwise.
   */
  static compareVersions(currentVersion, latestVersion) {
    const current = currentVersion.split('.');
    const latest = latestVersion.split('.');

    const maxLen = Math.max(current.length, latest.length);
    for (let i = 0; i < maxLen; i++) {
      const c = parseInt(current[i] || '0', 10);
      const l = parseInt(latest[i] || '0', 10);
      if (isNaN(l) || isNaN(c)) {
        return false;
      }
      if (c < l) {
        return true;
      }
      if (c > l) {
        return false;
      }
    }
    return false;
  }
}
