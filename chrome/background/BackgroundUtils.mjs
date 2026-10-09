// @ts-check
import {URLUtils} from '../player/utils/URLUtils.mjs';
import {MpvBackend} from './MpvBackend.mjs';

const PlayerURL = chrome.runtime.getURL('player/index.html');

export class BackgroundUtils {
  /**
   * The answers content.js gives OPEN_PLAYER when a player is on its way: the frame is
   * sent to the player page, or a player iframe goes over or in place of the page's video.
   * PLAYER_LOADED follows, and clears frame.playerOpening.
   */
  static PlayerOpeningResponses = ['redirect', 'replaceall', 'replace'];

  /**
   * Whether an OPEN_PLAYER answer means a player is on its way. 'no_video' does not, and
   * neither does no answer at all - the frame navigated away, or has no content script -
   * after which frame.playerOpening used to stay set, so that frame never opened a player
   * again.
   * @param {*} response - What content.js answered, undefined on a failed send.
   * @return {boolean}
   */
  static isPlayerOpeningResponse(response) {
    return BackgroundUtils.PlayerOpeningResponses.includes(response);
  }

  /**
   * The player mode of a source a site script reports (DETECTED_SOURCE, custom/*.js). Its
   * page can post such a report too (Instagram's): one without an address, or of a type
   * the player does not play, was recorded as a source of no mode.
   * @param {*} msg - The message.
   * @return {?string} The mode, or null for no source.
   */
  static detectedSourceMode(msg) {
    if (!msg || typeof msg.url !== 'string' || !msg.url) {
      return null;
    }
    return URLUtils.getModeFromExtension(msg.ext) || null;
  }

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
   * Whether this is Windows, where the mpv host's setup and update steps differ.
   * @return {boolean}
   */
  static isWindows() {
    return String(globalThis.navigator?.platform || '').startsWith('Win');
  }

  static updateTabIcon(tab, skipNotify) {
    clearTimeout(tab.tabIconTimeout);
    if (tab.isOn && tab.isMpv) {
      // MPV uses the plain purple icon, so clear any leftover state badge - or, when the
      // last hand-off failed, say so: the page plays on in the browser, and nothing else
      // would tell why. The title still names the mode ("MPV"): the tab is in it. An
      // outdated host gets the "!" too, after a hand-off that worked: the tooltip says to
      // install the host again. A failure's reason comes first.
      chrome.action.setBadgeText({
        text: tab.mpvError || tab.mpvHostOutdated ? '!' : '',
        tabId: tab.tabId,
      });
      // Locales without a translation for this key yet still get sensible
      // English text instead of an empty tooltip (chrome.i18n.getMessage
      // returns '' when a key is missing from a locale's messages.json).
      /** @type {string} */
      let title;
      if (tab.mpvError) {
        title = chrome.i18n.getMessage('extension_toggle_label_mpv_failed', [tab.mpvError]) ||
          'FastStream - MPV - the stream did not open: ' + tab.mpvError;
      } else if (tab.mpvHostOutdated) {
        // What to run differs: on Windows the setup installed a copy (Start menu "Update
        // mpv"); on Linux and macOS the manifest names the host file itself.
        title = BackgroundUtils.isWindows() ?
          chrome.i18n.getMessage('extension_toggle_label_mpv_outdated') ||
            'FastStream - MPV - the mpv host on this computer is out of date: ' +
            'run "Update mpv" from the Start menu (in a FastStream checkout: update-local.cmd or native-host\\install.ps1)' :
          chrome.i18n.getMessage('extension_toggle_label_mpv_outdated_unix') ||
            'FastStream - MPV - the mpv host on this computer is out of date: update the faststream-mpv-host.mjs that your native messaging manifest points to (git pull in your FastStream checkout; see native-host/README.md)';
      } else if (tab.mpvDecoder && tab.mpvDecoder.hardware) {
        // What mpv itself said about its decoder (MpvBackend.decoderStatus).
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
      chrome.action.setTitle({
        title,
        tabId: tab.tabId,
      });
      chrome.action.setIcon({
        path: '/icon3_128.png',
        tabId: tab.tabId,
      });
    } else if (tab.isOn) {
      chrome.action.setBadgeText({
        text: 'On',
        tabId: tab.tabId,
      });
      chrome.action.setTitle({
        title: chrome.i18n.getMessage('extension_toggle_label') || 'Toggle FastStream',
        tabId: tab.tabId,
      });
      chrome.action.setIcon({
        path: '/icon2_128.png',
        tabId: tab.tabId,
      });
    } else {
      chrome.action.setTitle({
        title: chrome.i18n.getMessage('extension_toggle_label') || 'Toggle FastStream',
        tabId: tab.tabId,
      });
      chrome.action.setIcon({
        path: '/icon128.png',
        tabId: tab.tabId,
      });
      if (skipNotify) {
        chrome.action.setBadgeText({
          text: '',
          tabId: tab.tabId,
        });
      } else {
        chrome.action.setBadgeText({
          text: 'Off',
          tabId: tab.tabId,
        });
        tab.tabIconTimeout = setTimeout(() => {
          chrome.action.setBadgeText({
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

  static isSubtitles(ext) {
    return ext === 'vtt' || ext === 'srt';
  }

  static isUrlPlayerUrl(url) {
    return url.substring(0, PlayerURL.length) === PlayerURL;
  }

  /**
   * Whether a tab's new URL (tabs.onUpdated) is still the same page: only its fragment
   * changed, to an anchor (#comments) or a time (#t=120), which Firefox reports as it
   * reports a new page. A hash route (#/episode/2, #!/...) is a page of its own, as is
   * the same URL again (a reload).
   * @param {?string|undefined} oldUrl - The tab's URL before.
   * @param {string} newUrl - Its URL now.
   * @return {boolean}
   */
  static isSamePageUrlChange(oldUrl, newUrl) {
    if (!oldUrl || !newUrl || oldUrl === newUrl) {
      return false;
    }
    const hash = (url) => (url.includes('#') ? url.slice(url.indexOf('#') + 1) : '');
    const strip = (url) => url.split('#')[0];
    const isRoute = (url) => hash(url).startsWith('/') || hash(url).startsWith('!');
    return strip(oldUrl) === strip(newUrl) && !isRoute(oldUrl) && !isRoute(newUrl);
  }

  static getPlayerUrl() {
    return PlayerURL;
  }
}
