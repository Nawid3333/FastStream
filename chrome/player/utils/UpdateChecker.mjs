// @ts-check
// SPLICER:NO_UPDATE_CHECKER:REMOVE_FILE

import {RequestUtils} from './RequestUtils.mjs';

const PACKAGE_JSON_URL = 'https://raw.githubusercontent.com/Nawid3333/FastStream/main/package.json';

const CHECK_INTERVAL = 1000 * 60 * 60 * 12;

/**
 * storage.local's updateData, as JSON; ignoreVersion is the one the user said "No" to.
 * @typedef {{latestVersion?: ?string, lastUpdateCheck?: number, ignoreVersion?: ?string}} UpdateData
 */

export class UpdateChecker {
  /**
   * A failed check counts as a check too and keeps the version known: every player loads the
   * options page, which must not store or ask at every load.
   * @param {UpdateData} data
   * @param {number} now - Date.now().
   * @return {Promise<?UpdateData>} The data to store, or null when no check was due.
   */
  static async refreshUpdateData(data, now) {
    if (now - Number(data.lastUpdateCheck) <= CHECK_INTERVAL) {
      return null;
    }
    const latestVersion = await UpdateChecker.getLatestVersion();
    return {...data, latestVersion: latestVersion ?? data.latestVersion ?? null, lastUpdateCheck: now};
  }

  /**
   * @return {Promise<string|null>}
   */
  static async getLatestVersion() {
    const xhr = await RequestUtils.requestSimple(PACKAGE_JSON_URL);
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
   * @param {string} currentVersion
   * @param {string} latestVersion
   * @return {boolean} Whether currentVersion is older.
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
