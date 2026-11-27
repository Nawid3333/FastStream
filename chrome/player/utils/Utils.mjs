// @ts-check
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {ClickActions} from '../options/defaults/ClickActions.mjs';
import {DefaultOptions} from '../options/defaults/DefaultOptions.mjs';
import {isKeyString, migrateKeybinds} from '../options/KeybindUtils.mjs';
import {DefaultSubtitlesSettings} from '../options/defaults/DefaultSubtitlesSettings.mjs';
import {migrateStorage} from '../options/StorageMode.mjs';
import {EnvUtils} from './EnvUtils.mjs';

export class Utils {
  /**
   * @return {Promise<typeof DefaultOptions>} The saved options over the defaults: the defaults' keys,
   *   each of its default's type (mergeOptions).
   */
  static async getOptionsFromStorage() {
    const stored = await Utils.readStoredConfig('options');
    return /** @type {typeof DefaultOptions} */ (migrateStorage(Utils.migrateClickActions(
        Utils.migrateSizes(Utils.migrateKeybinds(Utils.mergeOptions(DefaultOptions, stored || {}), stored), stored), stored), stored));
  }

  /**
   * Old saved sizes below 1 MB were megabytes, and an old 0 meant no limit. Once (sizesVersion).
   * @param {Object<string, *>} options - Saved options merged over the defaults; changed in place.
   * @param {Object<string, *>|null} stored - The options as saved, before the defaults were filled in.
   * @return {Object<string, *>} The same options, with sizesVersion set.
   */
  static migrateSizes(options, stored) {
    if (stored && !Number.isInteger(stored.sizesVersion)) {
      if (options.maxVideoSize > 0 && options.maxVideoSize < 1000000) {
        options.maxVideoSize *= 1000000;
      }
      if (options.maxVideoSize === 0) options.maxVideoSize = -1;
      if (options.maxSpeed === 0) options.maxSpeed = -1;
    }
    options.sizesVersion = 1;
    return options;
  }

  /**
   * The old click defaults, all three unchanged, move to today's, once (clickActionsVersion).
   * @param {Object<string, *>} options - Saved options merged over the defaults; changed in place.
   * @param {Object<string, *>|null} stored - The options as saved, before the defaults were filled in.
   * @return {Object} The same options, with clickActionsVersion set.
   */
  static migrateClickActions(options, stored) {
    if (stored && !Number.isInteger(stored.clickActionsVersion) &&
        options.singleClickAction === ClickActions.HIDE_CONTROLS &&
        options.doubleClickAction === ClickActions.PLAY_PAUSE &&
        options.tripleClickAction === ClickActions.FULLSCREEN) {
      options.singleClickAction = DefaultOptions.singleClickAction;
      options.doubleClickAction = DefaultOptions.doubleClickAction;
      options.tripleClickAction = DefaultOptions.tripleClickAction;
    }
    options.clickActionsVersion = 1;
    return options;
  }

  /**
   * See KeybindUtils.migrateKeybinds.
   * @param {Object} options - Saved options merged over the defaults; changed in place.
   * @param {Object|null} stored - The options as saved, before the defaults were filled in.
   * @return {Object<string, *>} The same options.
   */
  static migrateKeybinds(options, stored) {
    return migrateKeybinds(options, stored);
  }

  /**
   * @return {Object}
   */
  static getSubtitlesSettingsFromStorage() {
    return Utils.loadAndParseOptions('subtitlesSettings', DefaultSubtitlesSettings);
  }

  /**
   * @param {Object<string, *>} defaultOptions
   * @param {Object<string, *>} newOptions
   * @return {Object}
   */
  static mergeOptions(defaultOptions, newOptions) {
    /** @type {Object<string, *>} */
    const options = {};
    for (const prop in defaultOptions) {
      if (Object.hasOwn(defaultOptions, prop)) {
        const opt = defaultOptions[prop];
        if (Array.isArray(opt)) {
          // Only a list of strings; else a copy, so no caller changes the defaults in place.
          options[prop] = Object.hasOwn(newOptions, prop) && Array.isArray(newOptions[prop]) ?
            newOptions[prop].filter((item) => typeof item === 'string') : opt.slice();
        } else if (typeof opt === 'object') {
          options[prop] = this.mergeOptions(opt, newOptions[prop] || {});
          if (opt === DefaultOptions.keybinds) {
            for (const [action, key] of Object.entries(options[prop])) {
              if (!isKeyString(key)) options[prop][action] = opt[action];
            }
          }
        } else {
          options[prop] = (Object.hasOwn(newOptions, prop) && typeof newOptions[prop] === typeof opt) ? newOptions[prop] : opt;
        }
      }
    }
    return options;
  }

  /**
   * @template T
   * @param {Array<T>} array
   * @param {*} el
   * @param {Function} compareFn
   * @return {number} The index of a matching element; when there is none, -(the index it
   *   would go in) - 1, a negative number.
   */
  static binarySearch(array, el, compareFn) {
    let lower = 0;
    let upper = array.length - 1;
    while (lower <= upper) {
      const middle = (upper + lower) >> 1;
      const cmp = compareFn(el, array[middle]);
      if (cmp > 0) {
        lower = middle + 1;
      } else if (cmp < 0) {
        upper = middle - 1;
      } else {
        return middle;
      }
    }
    return -lower - 1;
  }

  /**
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @return {number}
   */
  static clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * @param {string|ArrayBuffer|Uint8Array|Blob} data
   * @return {number}
   */
  static getDataByteSize(data) {
    if (typeof data === 'string') return data.length * 2;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (data instanceof Blob) return data.size;
    return 0;
  }

  /**
   * @param {Map<*, Array<{start: number}>>|Array<Array<{start: number}>>} tracks - By track, or
   *   an array (the track is then its index).
   * @return {Array<*>} Sorted by start.
   */
  static zipTimedFragments(tracks) {
    /** @type {{track: *, fragment: {start: number}}[]} */
    const zippedFragments = [];
    tracks.forEach((fragments, track) => {
      fragments.forEach((fragment) => {
        zippedFragments.push({
          track,
          fragment,
        });
      });
    });

    zippedFragments.sort((a, b) => {
      return a.fragment.start - b.fragment.start;
    });

    return zippedFragments;
  }

  /**
   * Null before five are downloaded: an MP4's first ranges can share a second and last 0 s.
   * @param {Array<{dataSize: number|null, duration: number}|null>} fragments - dataSize null until downloaded.
   * @return {?number} Bits per second.
   */
  static measuredBitrate(fragments) {
    let count = 0;
    let size = 0;
    let totalDuration = 0;
    fragments.forEach((fragment) => {
      if (fragment && fragment.dataSize !== null) {
        count++;
        size += fragment.dataSize;
        totalDuration += fragment.duration;
      }
    });
    if (count <= 4 || !(totalDuration > 0)) return null;
    return size / totalDuration * 8;
  }

  /**
   * @param {string} key
   * @param {Object<string, *>} defaultOptions
   * @return {Promise<Object>}
   */
  static async loadAndParseOptions(key, defaultOptions) {
    return Utils.mergeOptions(defaultOptions, (await Utils.readStoredConfig(key)) || {});
  }

  /**
   * As it was saved, before any defaults are filled in.
   * @param {string} key
   * @return {Promise<Object<string, *>|null>} Null when nothing usable was saved.
   */
  static async readStoredConfig(key) {
    const settingsStr = await Utils.getConfig(key);
    if (settingsStr) {
      try {
        const settings = JSON.parse(settingsStr);
        if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
          return settings;
        }
      } catch (e) {
        console.error(e);
      }
    }
    return null;
  }

  /**
   * @param {string} key
   * @return {Promise<string|null>}
   */
  static getConfig(key) {
    return new Promise((resolve, reject)=> {
      if (EnvUtils.isExtension()) {
        chrome.storage.local.get(key, (result) => {
          // A failed read passes no result.
          resolve(/** @type {string|null} */ (result?.[key]));
        });
      } else {
        resolve(localStorage.getItem(key));
      }
    });
  }

  /**
   * @param {string} key
   * @param {string} value
   * @return {Promise<void>}
   */
  static setConfig(key, value) {
    return new Promise((resolve, reject)=> {
      if (EnvUtils.isExtension()) {
        chrome.storage.local.set({[key]: value}, () => {
          if (chrome.runtime?.lastError) console.error('Saving ' + key + ' failed', chrome.runtime.lastError);
          resolve();
        });
      } else {
        localStorage.setItem(key, value);
        resolve();
      }
    });
  }

  /**
   * @param {string} version
   */
  static printWelcome(version) {
    console.log('\n %c %c FastStream -%c ' + version + ' %c By Andrews54757 \n',
        'background: url("data:image/png;base64,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") no-repeat; background-size: 20px 20px; padding: 4px 8px; margin-right: 4px',
        'color: rgb(200,200,200); background: rgb(50,50,50); padding:5px 0;',
        'color: #afbc2a; background: rgb(50,50,50); padding:5px 0;',
        'color: black; background: #e9e9e9; padding:5px 0;',
    );
    console.log('Please report all issues to the GitHub repository: https://github.com/Nawid3333/FastStream/issues');
  }

  /**
   * @param {import('../modules/eventemitter.mjs').EventEmitter} context
   * @param {string} event
   * @param {number} timeout - ms.
   * @return {Promise<boolean>} False if timed out.
   */
  static timeoutableEvent(context, event, timeout) {
    /** @type {(() => void)|undefined} */
    let callback;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timeoutId;
    const cleanup = () => {
      clearTimeout(timeoutId);
      // Set: the promise sets it before anything can call this.
      context.off(event, /** @type {() => void} */ (callback));
    };

    return new Promise((resolve, reject) => {
      callback = () => {
        cleanup();
        resolve(true);
      };

      timeoutId = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeout);

      context.on(event, callback);
    });
  }

  /**
   * @param {number} timeout - ms.
   * @return {Promise<void>}
   */
  static asyncTimeout(timeout) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, timeout);
    });
  }

  /**
   * @param {Blob} blob
   * @param {string} filename
   * @return {Promise<void>} Once the download was handed to the browser.
   */
  static async downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const download = await Utils.downloadURL(url, filename);
    Utils.revokeWhenDownloaded(url, download);
  }

  /**
   * downloads.download() resolves before Firefox has read a blob: URL, so it stays until the
   * download is over (a minute without a download id).
   * @param {string} url - The blob: URL.
   * @param {*} download - What downloadURL resolved with: the download's id, or not.
   * @return {Promise<boolean>} Settles once revoked; true when Firefox said the download is over.
   */
  static revokeWhenDownloaded(url, download) {
    return Utils.whenDownloaded(download, () => URL.revokeObjectURL(url));
  }

  /**
   * Firefox says it is over, or a minute after a link click, or 30 minutes at most.
   * @param {*} download - What downloadURL resolved with: the download's id, or not.
   * @param {() => void} [atOver] - Run before the promise settles.
   * @return {Promise<boolean>} False when it stopped waiting without knowing.
   */
  static whenDownloaded(download, atOver = () => {}) {
    /** @type {PromiseWithResolvers<boolean>} */
    const {promise: over, resolve: revoked} = Promise.withResolvers();
    /** @param {boolean} known */
    const revoke = (known) => {
      atOver();
      revoked(known);
    };
    const downloads = globalThis.chrome?.downloads;
    if (typeof download !== 'number' || !downloads?.onChanged || !downloads.search) {
      setTimeout(() => revoke(false), 60000);
      return over;
    }
    let done = false;
    /** @param {boolean} known */
    const finish = (known) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      downloads.onChanged.removeListener(changed);
      revoke(known);
    };
    /** @type {(delta: chrome.downloads.DownloadDelta) => void} */
    const changed = (delta) => {
      if (delta.id === download && delta.state && delta.state.current !== 'in_progress') {
        finish(true);
      }
    };
    // A download that never ends keeps its data no longer than this.
    const timer = setTimeout(() => finish(false), 30 * 60 * 1000);
    downloads.onChanged.addListener(changed);
    downloads.search({id: download}).then(([item]) => {
      if (!item || item.state !== 'in_progress') finish(true);
    }).catch(() => finish(false));
    return over;
  }

  /**
   * @param {string} url
   * @param {string} filename
   * @param {boolean} [forceDirect=false] - A link click, not the background's downloads API.
   * @return {Promise<number|boolean|null|void>} Resolves when the download starts: its id, or
   *   true (a link click); false when the user cancelled Firefox's Save As, null when Firefox
   *   refused the download.
   */
  static async downloadURL(url, filename, forceDirect = false) {
    // Firefox does not download a blob: URL clicked in a sandboxed iframe (blob URL partitioning).
    if (EnvUtils.isExtension() && !forceDirect) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: MessageTypes.DOWNLOAD,
          url,
          filename,
        }, (response) => {
          resolve(response);
        });
      });
    } else {
      const aElement = document.createElement('a');
      aElement.href = url;
      aElement.download = filename;
      aElement.target = '_blank';
      document.body.appendChild(aElement);
      aElement.click();
      aElement.remove();
      return true;
    }
  }
}
