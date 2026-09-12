// @ts-check
const PlayerURL = chrome.runtime.getURL('player/index.html');

// The native chrome.action badge box can't fit 'MPV' without clipping it -
// three wide capital letters don't fit the way 'On'/'Off' do below - and an
// abbreviation like 'MP' just reads as a typo. So instead of the native
// badge, 'MPV' is drawn directly onto a copy of the icon bitmap, where the
// font size is ours to pick. Built once and cached forever: OffscreenCanvas
// is a Worker/service-worker API (missing on some very old targets, hence
// the feature check), and the icon never changes at runtime.
/** @type {Promise<ImageData|null>|null} */
let mpvIconImageDataPromise = null;
function getMpvIconImageData() {
  if (!mpvIconImageDataPromise) {
    mpvIconImageDataPromise = buildMpvIconImageData().catch((e) => {
      console.warn('Could not draw the MPV toolbar icon, falling back to the plain icon', e);
      return null;
    });
  }
  return mpvIconImageDataPromise;
}

async function buildMpvIconImageData() {
  if (typeof OffscreenCanvas === 'undefined') {
    return null;
  }

  const response = await fetch(chrome.runtime.getURL('/icon3_128.png'));
  const bitmap = await createImageBitmap(await response.blob());

  const size = bitmap.width;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, size, size);

  const tagWidth = size * 0.84;
  const tagHeight = size * 0.32;
  const tagX = size - tagWidth - size * 0.02;
  const tagY = size - tagHeight - size * 0.02;
  const radius = tagHeight * 0.3;

  ctx.fillStyle = '#d32f2f';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(tagX, tagY, tagWidth, tagHeight, radius);
  } else {
    ctx.rect(tagX, tagY, tagWidth, tagHeight);
  }
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(tagHeight * 0.6)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MPV', tagX + tagWidth / 2, tagY + tagHeight / 2 + size * 0.01);

  return ctx.getImageData(0, 0, size, size);
}

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
      // No native badge text here - the 'MPV' tag is baked into the icon
      // itself (see buildMpvIconImageData above), so any leftover 'On'/'Off'
      // badge text from a previous state must be cleared or it would sit on
      // top of the icon as a second, redundant label.
      chrome.action.setBadgeText({
        text: '',
        tabId: tab.tabId,
      });
      // Locales without a translation for this key yet still get sensible
      // English text instead of an empty tooltip (chrome.i18n.getMessage
      // returns '' when a key is missing from a locale's messages.json).
      chrome.action.setTitle({
        title: chrome.i18n.getMessage('extension_toggle_label_mpv') || 'FastStream - Playing in MPV',
        tabId: tab.tabId,
      });
      getMpvIconImageData().then((imageData) => {
        if (imageData) {
          chrome.action.setIcon({imageData, tabId: tab.tabId});
        } else {
          // OffscreenCanvas unavailable or drawing failed - fall back to the
          // plain MPV icon with a short badge that at least fits.
          chrome.action.setIcon({path: '/icon3_128.png', tabId: tab.tabId});
          chrome.action.setBadgeText({text: 'MP', tabId: tab.tabId});
        }
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
