import {MessageTypes} from '../enums/MessageTypes.mjs';
import {DefaultOptions} from '../options/defaults/DefaultOptions.mjs';
import {migrateKeybinds} from '../options/KeybindUtils.mjs';
import {DefaultSubtitlesSettings} from '../options/defaults/DefaultSubtitlesSettings.mjs';
import {EnvUtils} from './EnvUtils.mjs';

/**
 * General utility functions for FastStream player.
 */
export class Utils {
  /**
   * Loads player options from storage.
   * @return {Promise<Object>} The loaded options object.
   */
  static async getOptionsFromStorage() {
    const stored = await Utils.readStoredConfig('options');
    return Utils.migrateKeybinds(Utils.mergeOptions(DefaultOptions, stored || {}), stored);
  }

  /**
   * Brings saved keybinds up to the current layout, once per saved options. See
   * KeybindUtils.migrateKeybinds for the rules.
   * @param {Object} options - Saved options merged over the defaults; changed in place.
   * @param {Object|null} stored - The options as saved, before the defaults were filled in.
   * @return {Object} The same options.
   */
  static migrateKeybinds(options, stored) {
    return migrateKeybinds(options, stored);
  }

  /**
   * Loads subtitle settings from storage.
   * @return {Object} The loaded subtitle settings object.
   */
  static getSubtitlesSettingsFromStorage() {
    return Utils.loadAndParseOptions('subtitlesSettings', DefaultSubtitlesSettings);
  }

  /**
   * Merges default options with new options.
   * @param {Object} defaultOptions - The default options.
   * @param {Object} newOptions - The new options to merge.
   * @return {Object} The merged options object.
   */
  static mergeOptions(defaultOptions, newOptions) {
    const options = {};
    for (const prop in defaultOptions) {
      if (Object.hasOwn(defaultOptions, prop)) {
        const opt = defaultOptions[prop];
        if (Array.isArray(opt)) {
          // A list takes only a list, of text lines (autoEnableURLs and mpvAllowlist are the
          // lists in the defaults). typeof null and of {} is 'object' too: an imported
          // `"autoEnableURLs": null` was kept, saved, and broke the options page for good.
          options[prop] = Object.hasOwn(newOptions, prop) && Array.isArray(newOptions[prop]) ?
            newOptions[prop].filter((item) => typeof item === 'string') : opt;
        } else if (typeof opt === 'object') {
          options[prop] = this.mergeOptions(opt, newOptions[prop] || {});
        } else {
          options[prop] = (Object.hasOwn(newOptions, prop) && typeof newOptions[prop] === typeof opt) ? newOptions[prop] : opt;
        }
      }
    }
    return options;
  }

  /**
   * Performs a binary search on an array.
   * @param {Array} array - The array to search.
   * @param {*} el - The element to search for.
   * @param {Function} compareFn - Comparison function.
   * @return {*} The found element or undefined.
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
   * Clamps a value between a minimum and maximum.
   * @param {number} value - The value to clamp.
   * @param {number} min - Minimum value.
   * @param {number} max - Maximum value.
   * @return {number} The clamped value.
   */
  static clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Gets the byte size of a string, ArrayBuffer, or Blob.
   * @param {string|ArrayBuffer|Blob} data - The data to measure.
   * @return {number} The byte size.
   */
  static getDataByteSize(data) {
    if (typeof data === 'string') return data.length * 2;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (data instanceof Blob) return data.size;
    return 0;
  }

  /**
   * Zips timed fragments from multiple tracks into a sorted array.
   * @param {Map} tracks - Map of track to fragments.
   * @return {Array} Sorted array of zipped fragments.
   */
  static zipTimedFragments(tracks) {
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
   * The bitrate the downloaded fragments show, or null while it cannot be told: fewer than
   * five downloaded, or no time between them. An MP4's ranges start on whole seconds, so
   * on a high-bitrate one the first few share a second and last 0 s; that gave Infinity, a
   * false "not enough storage" warning, and every downloaded fragment kept for the session.
   * @param {Array<Object>} fragments - Fragments with dataSize (null until downloaded)
   *     and duration.
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
   * Loads and parses options from storage, merging with defaults.
   * @param {string} key - Storage key.
   * @param {Object} defaultOptions - Default options object.
   * @return {Promise<Object>} Merged options object.
   */
  static async loadAndParseOptions(key, defaultOptions) {
    return Utils.mergeOptions(defaultOptions, (await Utils.readStoredConfig(key)) || {});
  }

  /**
   * Reads a saved config as it was saved, before any defaults are filled in.
   * @param {string} key - Storage key.
   * @return {Promise<Object|null>} The saved object, or null when nothing usable was saved.
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
   * Gets a config value from extension or localStorage.
   * @param {string} key - Config key.
   * @return {Promise<string|null>} The config value or null.
   */
  static getConfig(key) {
    return new Promise((resolve, reject)=> {
      if (EnvUtils.isExtension()) {
        chrome.storage.local.get(key, (result) => {
          resolve(result[key]);
        });
      } else {
        resolve(localStorage.getItem(key));
      }
    });
  }

  /**
   * Sets a config value in extension or localStorage.
   * @param {string} key - Config key.
   * @param {string} value - Value to set.
   * @return {Promise<void>} Resolves when set.
   */
  static setConfig(key, value) {
    return new Promise((resolve, reject)=> {
      if (EnvUtils.isExtension()) {
        chrome.storage.local.set({[key]: value}, () => {
          resolve();
        });
      } else {
        localStorage.setItem(key, value);
        resolve();
      }
    });
  }

  /**
   * Prints a welcome message to the console.
   * @param {string} version - FastStream version string.
   */
  static printWelcome(version) {
    console.log('\n %c %c FastStream -%c ' + version + ' %c By Andrews54757 \n',
        'background: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAgMAAAAhHED1AAAABGdBTUEAALGPC/xhBQAAAAFzUkdCAK7OHOkAAAIzaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIgogICAgICAgICAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyI+CiAgICAgICAgIDxleGlmOlBpeGVsWURpbWVuc2lvbj41Nzc8L2V4aWY6UGl4ZWxZRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFhEaW1lbnNpb24+MzI1MjwvZXhpZjpQaXhlbFhEaW1lbnNpb24+CiAgICAgICAgIDxleGlmOkNvbG9yU3BhY2U+MTwvZXhpZjpDb2xvclNwYWNlPgogICAgICAgICA8dGlmZjpPcmllbnRhdGlvbj4xPC90aWZmOk9yaWVudGF0aW9uPgogICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KsQcJDwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAAlQTFRFgICAc3Nzn97yzhLoyQAAAAN0Uk5T/wL+LN1NqgAAA8tJREFUeNrV3E9ymzAUBvAPTdl41Sy4Q8en0KIHoDNwH5aZnkJLxqfsog4GjN5fycTaJv5F+iRibL9njNT4DQAf5K+A+FnEffwwAT1Wo9MDAzaj1QI9dqPTAQMgFDIADoYGiEdAIwd6HI5WDCAzpEDMAY0MGJAdnQiIeaCRAMQEjqYAzQSOpgDVBA6mANUEDqYA6RnInQXIDmH+OEI5gacpQBXhQYxQRXgQI7Qr2K8BugifY4R2Bfs1QBnhU4xQr2C3BqhXsFsDtHuw3wfoV7BdA/Qr2K4BhhVs1gD1Ju42EoYINiHAEMEmBFgiWIcASwTrEGCJYB0CLBGsQ4ApglUIMEWwCgGmCFYhwBTBKgTYIniEAFsEjxBgi+ARAmwRFACaHQAYU4QxwyVFGDNcQoAxgiWEUgBgTRHWDL9SLAT0FqBdAdECNCUBwLwNMGd4T7EM0NuAdgHiSUCzAIB9G4oA2U0It8eYMttQBOitQKsBQADZXbwwQKMAZgqAFQAHXGXAIAFS7nosAfQSYMpdjyRwKwiAAKIdaGggcLt4B2AHIAZSTWCQXApT9qnhVQAIoPcALQlc2V0sA0QBkPLPblWBmwyAAJiqAaCAwB+DIsAgAOaKQAfJtZSqApKLcaoItJBcjG4AZwMzCQiuZjeQqBvulwCTDQjlAJwEXCS7iAaCa+nvr3nOBSGZAZmkaAZG4LoF9C/JZIB4BrN3BgZgu4L0/sCkfnzwHoPCgGEXL2WB9I7A1XkMSgPEL0YJMBv+K4uPQZQAyfDEcjoQhLtYFfj8XBZiu0N5JDFXBKj7xAeQqBk4AdkMpvcHYHvNtADz6UCqC4w8QP1LHl8CoDIQPUAjAWYvkGoC9Fthd2D69sDA3etRf6CrDYC7RezIt4X/z4AERgYAd4c3CmbAA5GeAfnanQMC99Kb+YCCBdrqANhjQH9MhOAFwOxix3xUhsAeAwYAc6PPfVyIwB6DMkBPADNzDMoAgxXoBECSAKMVGAXAJAKIN+S4XXQBLV9CEWYZMNiArhyQ3YbA7iJTShMStwkcMAmB3gK036oiyl3UdUpdWlu2tM5d3OcuLxytGZarkHQXebrLTN2Frv5SW3exr7vc2F3w7C+5jqYISpaduwvf/aX37uJ/d/uBuwHC34LhbgJxt6H4G2HcrTiDfgWF25H8DVHulix/U5i7Lc3dGOdvzXM3B/rbE90Nku4WTX+TqLtN1d8o627V9TcL+9uV3Q3T/pbto51Qtq0Pgh2kG+d72eOJ1v1B9HjyywN+fj3c9uUB4ziOfwDu6wv+AVGfgdzlM/6SAAAAAElFTkSuQmCC") no-repeat; background-size: 20px 20px; padding: 4px 8px; margin-right: 4px',
        'color: rgb(200,200,200); background: rgb(50,50,50); padding:5px 0;',
        'color: #afbc2a; background: rgb(50,50,50); padding:5px 0;',
        'color: black; background: #e9e9e9; padding:5px 0;',
    );
    console.log('Please report all issues to the GitHub repository: https://github.com/Nawid3333/FastStream/issues');
  }

  /**
   * Resolves when an event occurs or a timeout is reached.
   * @param {Object} context - Event context (must support on/off).
   * @param {string} event - Event name.
   * @param {number} timeout - Timeout in ms.
   * @return {Promise<boolean>} True if event occurred, false if timed out.
   */
  static timeoutableEvent(context, event, timeout) {
    let callback; let timeoutId;
    const cleanup = () => {
      clearTimeout(timeoutId);
      context.off(event, callback);
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
   * Returns a promise that resolves after a timeout.
   * @param {number} timeout - Timeout in ms.
   * @return {Promise<void>} Resolves after timeout.
   */
  static asyncTimeout(timeout) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, timeout);
    });
  }

  /**
   * Revokes a download's blob: URL once the download no longer needs it.
   *
   * downloads.download() resolves before Firefox has read a blob: URL: revoked at once, 8
   * of 60 small downloads failed (interrupted, CRASH) and no file came, with no message -
   * a subtitle saved from the menu, the end of a save. So the URL stays until Firefox says
   * the download is over. A link click reads the blob at once (40 of 40 survived a revoke
   * right after it); with no download to ask about (a link click, the web build), it
   * stays a minute.
   * @param {string} url - The blob: URL.
   * @param {*} download - What downloadURL resolved with: the download's id, or not.
   * @return {Promise<void>} Settles once the URL is revoked: whatever else the download
   *     reads from (a save's OPFS session) can be let go then too.
   */
  static revokeWhenDownloaded(url, download) {
    let revoked;
    const over = new Promise((resolve) => (revoked = resolve));
    const revoke = () => {
      URL.revokeObjectURL(url);
      revoked();
    };
    const downloads = globalThis.chrome?.downloads;
    if (typeof download !== 'number' || !downloads?.onChanged || !downloads.search) {
      setTimeout(revoke, 60000);
      return over;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      downloads.onChanged.removeListener(changed);
      revoke();
    };
    const changed = (delta) => {
      if (delta.id === download && delta.state && delta.state.current !== 'in_progress') {
        finish();
      }
    };
    // A download that never ends keeps its data no longer than this.
    const timer = setTimeout(finish, 30 * 60 * 1000);
    downloads.onChanged.addListener(changed);
    // It may have ended before the listener was there.
    downloads.search({id: download}).then(([item]) => {
      if (!item || item.state !== 'in_progress') finish();
    }).catch(finish);
    return over;
  }

  /**
   * Downloads a file from a URL, using extension APIs if available.
   * @param {string} url - The file URL.
   * @param {string} filename - The filename to save as.
   * @param {boolean} [forceDirect=false] - Force direct download (bypass extension).
   * @return {Promise<void>|void} Resolves when download starts.
   */
  static async downloadURL(url, filename, forceDirect = false) {
    // Firefox has a bug where it doesn't download filed from sandboxed iframes
    // Caused by bloburl partitioning issues. See gecko's dom/file/uri/BlobURLProtocolHandler.cpp#L775C1-L786C6
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
