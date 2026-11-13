// @ts-check
// SPLICER:NO_UPDATE_CHECKER:REMOVE_FILE

import {RequestUtils} from './RequestUtils.mjs';

const PACKAGE_JSON_URL = 'https://raw.githubusercontent.com/Nawid3333/FastStream-for-Firefox/main/package.json';

// The time between two checks, failed or not.
const CHECK_INTERVAL = 1000 * 60 * 60 * 12;

/**
 * What storage.local's updateData holds, as JSON: the latest version known, the time of the
 * last check, and the version the user said to stop showing ("No").
 * @typedef {{latestVersion?: ?string, lastUpdateCheck?: number, ignoreVersion?: ?string}} UpdateData
 */

/**
 * Utility for checking and comparing FastStream versions.
 */
export class UpdateChecker {
  /**
   * Asks for the latest version when the last check, failed or not, was more than 12 hours ago
   * or never ran. The options page, an iframe in every player, stored the update data at every
   * load, which told every open options page; a failed check wrote null over the version known,
   * and with no version known it asked again at every player opened.
   * @param {UpdateData} data - The stored update data.
   * @param {number} now - Date.now().
   * @return {Promise<?UpdateData>} The update data to store, or null when no check was due:
   *   nothing changed, and nothing is to be stored.
   */
  static async refreshUpdateData(data, now) {
    if (now - Number(data.lastUpdateCheck) <= CHECK_INTERVAL) {
      return null;
    }
    const latestVersion = await UpdateChecker.getLatestVersion();
    // A failed check keeps the version known, and counts as a check: no new one for 12 hours.
    return {...data, latestVersion: latestVersion ?? data.latestVersion ?? null, lastUpdateCheck: now};
  }

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
