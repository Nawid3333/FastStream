// @ts-check
const PlayerURL = chrome.runtime.getURL('player/index.html');
export class BackgroundUtils {
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

  static updateTabIcon(tab, skipNotify) {
    clearTimeout(tab.tabIconTimeout);
    if (tab.isOn && tab.isMpv) {
      // 'MPV' (3 wide capital letters) gets clipped in the toolbar badge,
      // unlike 'On'/'Off' below. 'MP' fits the same way 'On' does.
      chrome.action.setBadgeText({
        text: 'MP',
        tabId: tab.tabId,
      });
      // Locales without a translation for this key yet still get sensible
      // English text instead of an empty tooltip (chrome.i18n.getMessage
      // returns '' when a key is missing from a locale's messages.json).
      chrome.action.setTitle({
        title: chrome.i18n.getMessage('extension_toggle_label_mpv') || 'FastStream - Playing in MPV',
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

  static getPlayerUrl() {
    return PlayerURL;
  }
}
