// @ts-check
import {EnvUtils} from '../player/utils/EnvUtils.mjs';
import {URLUtils} from '../player/utils/URLUtils.mjs';
import {MpvBackend} from './MpvBackend.mjs';
import {isSubtitles} from './StreamDetection.mjs';

const PlayerURL = chrome.runtime.getURL('player/index.html');

/** @typedef {import('./TabTracker.mjs').TabHolder} TabHolder */

/**
 * @typedef {Object} TabIconExtras
 * @property {ReturnType<typeof setTimeout>} [tabIconTimeout]
 */

/**
 * The tab may be closed by now: Firefox's rejection then is nothing to report.
 * @param {'setBadgeText'|'setTitle'|'setIcon'} method
 * @param {*} details
 */
function setAction(method, details) {
  const call = /** @type {(details: *) => (Promise<void>|void)} */ (chrome.action[method]);
  const done = call.call(chrome.action, details);
  if (done && typeof done.catch === 'function') done.catch(() => {});
}

export class BackgroundUtils {
  static PlayerOpeningResponses = ['redirect', 'replaceall', 'replace'];

  /**
   * @param {*} response
   * @return {boolean}
   */
  static isPlayerOpeningResponse(response) {
    return BackgroundUtils.PlayerOpeningResponses.includes(response);
  }

  /**
   * A page can post such a report too (Instagram's): one without an address or a playable type is no source.
   * @param {*} msg
   * @return {?string}
   */
  static detectedSourceMode(msg) {
    if (!msg || typeof msg.url !== 'string' || !msg.url) {
      return null;
    }
    return URLUtils.getModeFromExtension(msg.ext) || null;
  }

  /**
   * @param {string} message
   * @param {boolean} [suppress]
   */
  static checkMessageError(message, suppress = false) {
    if (chrome.runtime.lastError) {
      if (!suppress) console.warn(`Unable to send message '${message}'`, chrome.runtime.lastError);
    }
  }

  static checkPermissions() {
    return new Promise((resolve, reject) => {
      chrome.permissions.contains({
        origins: ['<all_urls>'],
        permissions: ['storage', 'tabs', 'webRequest', 'declarativeNetRequest'],
      }, (result) => {
        resolve(result);
      });
    });
  }

  /** The removed audio settings window's storage and IndexedDB files, forgotten once on an update. */
  static forgetRemovedAudioSettingsOnUpdate() {
    chrome.runtime.onInstalled.addListener((details) => {
      if (details?.reason !== 'update') return;
      return BackgroundUtils.forgetRemovedAudioSettings();
    });
  }

  /** @return {Promise<void>} */
  static forgetRemovedAudioSettings() {
    const profiles = Promise.resolve().then(() => chrome.storage.local.remove(['audioProfiles', 'currentAudioProfile']))
        .catch((e) => console.warn('Could not forget the old audio profiles', e));
    // A tab of the old version holding the database open blocks the delete until it closes.
    const files = /** @type {Promise<void>} */ (new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('faststream-impulse-responses');
      request.onsuccess = request.onerror = () => resolve(undefined);
    })).catch(() => {
      // no IndexedDB (a private window may refuse it): nothing was kept there either
    });
    return Promise.all([profiles, files]).then(() => {});
  }

  static openWelcomePageOnInstall() {
    chrome.runtime.onInstalled.addListener((object) => {
      chrome.storage.local.get('welcome', (result) => {
        if (!result || !result.welcome) {
          chrome.tabs.create({
            url: chrome.runtime.getURL('welcome.html'),
          }, (tab) => {
            chrome.storage.local.set({
              welcome: true,
            });
          });
        }
      });
    });
  }

  /**
   * @param {TabHolder & TabIconExtras} tab
   * @param {boolean} [skipNotify]
   */
  static updateTabIcon(tab, skipNotify) {
    clearTimeout(tab.tabIconTimeout);
    if (tab.isOn && tab.isMpv) {
      // MPV: no state badge, or say the last hand-off failed; an outdated host shows in the tooltip only.
      setAction('setBadgeText', {
        text: tab.mpvError ? '!' : '',
        tabId: tab.tabId,
      });
      // getMessage returns '' for a key a locale lacks.
      /** @type {string} */
      let title;
      if (tab.mpvError) {
        title = chrome.i18n.getMessage('extension_toggle_label_mpv_failed', [tab.mpvError]) ||
          'FastStream - MPV - the stream did not open: ' + tab.mpvError;
      } else if (tab.mpvHostOutdated) {
        title = EnvUtils.isWindows() ?
          chrome.i18n.getMessage('extension_toggle_label_mpv_outdated') ||
            'FastStream - MPV - the mpv helper on this computer is out of date: ' +
            'run "Update mpv" from the Start menu (in a FastStream checkout: update-local.cmd or native-host\\install.ps1)' :
          chrome.i18n.getMessage('extension_toggle_label_mpv_outdated_unix') ||
            'FastStream - MPV - the mpv helper on this computer is out of date: update the faststream-mpv-host.mjs that your native messaging manifest points to (git pull in your FastStream checkout; see native-host/README.md)';
      } else if (tab.mpvDecoder && tab.mpvDecoder.hardware) {
        const what = MpvBackend.describeDecoder(tab.mpvDecoder);
        title = chrome.i18n.getMessage('extension_toggle_label_mpv_hw', [what]) ||
          'FastStream - Playing in MPV - decoded by the graphics card: ' + what;
      } else if (tab.mpvDecoder) {
        // Only a hint: mpv.conf is the user's, and FastStream never overrides it.
        const what = MpvBackend.describeDecoder(tab.mpvDecoder) || tab.mpvDecoder.api;
        title = chrome.i18n.getMessage('extension_toggle_label_mpv_sw', [what]) ||
          'FastStream - Playing in MPV - decoded by the processor (' + what + '): ' +
          'add hwdec=auto-safe to mpv.conf to decode on the graphics card';
      } else {
        title = chrome.i18n.getMessage('extension_toggle_label_mpv') || 'FastStream - Playing in MPV';
      }
      setAction('setTitle', {
        title,
        tabId: tab.tabId,
      });
      setAction('setIcon', {
        path: '/icon3_128.png',
        tabId: tab.tabId,
      });
    } else if (tab.isOn) {
      // A copy-protected video stays in the page's player: the button says why.
      setAction('setBadgeText', {
        text: tab.protectedVideo ? 'DRM' : 'On',
        tabId: tab.tabId,
      });
      setAction('setTitle', {
        title: tab.protectedVideo ?
          chrome.i18n.getMessage('extension_toggle_label_drm') ||
            'FastStream - This video is copy-protected (DRM), and FastStream cannot play it: the site\'s own player keeps it' :
          chrome.i18n.getMessage('extension_toggle_label') || 'Toggle FastStream',
        tabId: tab.tabId,
      });
      setAction('setIcon', {
        path: '/icon2_128.png',
        tabId: tab.tabId,
      });
    } else {
      setAction('setTitle', {
        title: chrome.i18n.getMessage('extension_toggle_label') || 'Toggle FastStream',
        tabId: tab.tabId,
      });
      setAction('setIcon', {
        path: '/icon128.png',
        tabId: tab.tabId,
      });
      if (skipNotify) {
        setAction('setBadgeText', {
          text: '',
          tabId: tab.tabId,
        });
      } else {
        setAction('setBadgeText', {
          text: 'Off',
          tabId: tab.tabId,
        });
        tab.tabIconTimeout = setTimeout(() => {
          setAction('setBadgeText', {
            text: '',
            tabId: tab.tabId,
          });
        }, 1000);
      }
    }
  }

  static queryTabs() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({}, (tabs) => {
        resolve(tabs);
      });
    });
  }

  /**
   * @param {string} ext
   * @return {boolean}
   */
  static isSubtitles(ext) {
    return isSubtitles(ext);
  }

  /**
   * @param {string} url
   * @return {boolean}
   */
  static isUrlPlayerUrl(url) {
    return url.substring(0, PlayerURL.length) === PlayerURL;
  }

  /**
   * Only the fragment changed, to an anchor or a time; a hash route (#/, #!) or a reload is a new page.
   * @param {?string|undefined} oldUrl
   * @param {string} newUrl
   * @return {boolean}
   */
  static isSamePageUrlChange(oldUrl, newUrl) {
    if (!oldUrl || !newUrl || oldUrl === newUrl) {
      return false;
    }
    /** @param {string} url */
    const hash = (url) => (url.includes('#') ? url.slice(url.indexOf('#') + 1) : '');
    /** @param {string} url */
    const strip = (url) => url.split('#')[0];
    /** @param {string} url */
    const isRoute = (url) => hash(url).startsWith('/') || hash(url).startsWith('!');
    return strip(oldUrl) === strip(newUrl) && !isRoute(oldUrl) && !isRoute(newUrl);
  }

  static getPlayerUrl() {
    return PlayerURL;
  }
}
