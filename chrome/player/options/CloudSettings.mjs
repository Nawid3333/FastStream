// @ts-check
import {Localize} from '../modules/Localize.mjs';

// The settings' copy in storage.sync, which Firefox Sync takes to the user's other computers
// (docs/notes/player.md, "Settings in the cloud"). Firefox's limits, measured on Firefox 160: an
// item's key and the JSON of its value at most 8192 UTF-8 bytes, the JSON of all items together
// at most 102400, 512 items; a set() over one of them writes nothing and throws.

export const META_KEY = 'fsCloudMeta';
const CHUNK_PREFIX = 'fsCloud';
const FORMAT = 1;
// Under Firefox's 8192 for an item.
export const ITEM_BYTES = 8000;

/**
 * @typedef {{v: number, savedAt: number, os: string, chunks: number, length: number, sha256: string}} CloudMeta
 */

/**
 * A storage.sync area, or a stand-in for it.
 * @typedef {Object} SyncArea
 * @property {(keys: ?(string|string[])) => Promise<Object<string, *>>} get
 * @property {(items: Object<string, *>) => Promise<void>} set
 * @property {(keys: string|string[]) => Promise<void>} remove
 * @property {{addListener: (fn: (changes: Object<string, *>) => void) => void}} [onChanged]
 */

/** Why the cloud copy cannot be read or written. */
export class CloudCopyError extends Error {
  /** @param {'none'|'quota'|'incomplete'} reason */
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * @param {number} index
 * @return {string}
 */
export function chunkKey(index) {
  return CHUNK_PREFIX + index;
}

/**
 * @param {string} key
 * @return {number} The chunk's index, -1 for a key that is no chunk.
 */
function chunkIndex(key) {
  const match = /^fsCloud(\d+)$/.exec(key);
  return match ? Number(match[1]) : -1;
}

/**
 * @param {string} key
 * @return {boolean} Whether the cloud copy has an item of that name.
 */
export function isCloudKey(key) {
  return key === META_KEY || chunkIndex(key) !== -1;
}

/**
 * The UTF-8 bytes one character takes inside a JSON string, its escape included.
 * @param {string} ch - One code point, or a lone surrogate.
 * @return {number}
 */
function jsonBytes(ch) {
  const code = /** @type {number} */ (ch.codePointAt(0));
  if (code === 0x22 || code === 0x5c) return 2;
  if (code < 0x20) return '\b\t\n\f\r'.includes(ch) ? 2 : 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  // JSON.stringify writes a lone surrogate as \uXXXX.
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  return code < 0x10000 ? 3 : 4;
}

/**
 * Cuts a text into slices whose items (key and the slice's JSON) stay within ITEM_BYTES. A
 * surrogate pair is never cut.
 * @param {string} text
 * @return {string[]}
 */
export function splitForSync(text) {
  /** @type {string[]} */
  const slices = [];
  let start = 0;
  let end = 0;
  let bytes = 0;
  for (const ch of text) {
    const cost = jsonBytes(ch);
    // The key, and the two quotes of the JSON string.
    if (bytes + cost > ITEM_BYTES - chunkKey(slices.length).length - 2) {
      slices.push(text.slice(start, end));
      start = end;
      bytes = 0;
    }
    bytes += cost;
    end += ch.length;
  }
  slices.push(text.slice(start));
  return slices;
}

/**
 * @param {string} text
 * @return {Promise<string>} The SHA-256 of its UTF-8 bytes, in hex.
 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {*} meta
 * @return {meta is CloudMeta}
 */
function isMeta(meta) {
  return !!meta && typeof meta === 'object' && meta.v === FORMAT && Number.isFinite(meta.savedAt) &&
    typeof meta.os === 'string' && Number.isSafeInteger(meta.chunks) && meta.chunks >= 1 && meta.chunks <= 512 &&
    Number.isSafeInteger(meta.length) && meta.length >= 0 &&
    typeof meta.sha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.sha256);
}

/**
 * Writes the settings over the cloud copy, all in one set(): over Firefox's quota nothing is
 * written, and the copy there stays as it was.
 * @param {SyncArea} area
 * @param {Object} settings - The object the settings file holds.
 * @param {string} os - runtime.getPlatformInfo().os.
 * @param {number} [now]
 * @return {Promise<CloudMeta>}
 * @throws {CloudCopyError} 'quota' when it does not fit.
 */
export async function saveCloudCopy(area, settings, os, now = Date.now()) {
  const text = JSON.stringify(settings);
  const slices = splitForSync(text);
  /** @type {CloudMeta} */
  const meta = {v: FORMAT, savedAt: now, os, chunks: slices.length, length: text.length, sha256: await sha256Hex(text)};
  /** @type {Object<string, *>} */
  const items = {[META_KEY]: meta};
  slices.forEach((slice, i) => {
    items[chunkKey(i)] = slice;
  });
  // The chunks of an older, longer copy are emptied in the same set(): Firefox counts the total over
  // what is stored, and kept whole beside the new chunks they could push a copy that fits over it.
  const stale = () => area.get(null).then((all) => Object.keys(all).filter((key) => chunkIndex(key) >= slices.length));
  for (const key of await stale()) items[key] = '';
  try {
    await area.set(items);
  } catch (e) {
    throw String(/** @type {*} */ (e)?.message ?? e).includes('QuotaExceededError') ? new CloudCopyError('quota') : e;
  }
  // The copy is written: what is left over is only tidied away.
  try {
    const left = await stale();
    if (left.length) await area.remove(left);
  } catch (e) {
    console.warn('The cloud copy\'s old chunks were not removed', e);
  }
  return meta;
}

/**
 * @param {SyncArea} area
 * @return {Promise<?CloudMeta>} Null when there is no readable copy.
 */
export async function readCloudMeta(area) {
  const meta = (await area.get(META_KEY))?.[META_KEY];
  return isMeta(meta) ? meta : null;
}

/**
 * Reads the whole copy, in one get(): its meta and chunks as they were at one moment.
 * @param {SyncArea} area
 * @return {Promise<{meta: CloudMeta, settings: Object<string, *>}>}
 * @throws {CloudCopyError} 'none', or 'incomplete' for a chunk missing or a text that is not
 *     what the meta says (a copy synced in part, or two computers' copies mixed).
 */
export async function readCloudCopy(area) {
  const all = await area.get(null);
  const meta = all[META_KEY];
  if (meta === undefined) throw new CloudCopyError('none');
  if (!isMeta(meta)) throw new CloudCopyError('incomplete');
  // A chunk missing or of another copy fails the length or the hash.
  const text = Array.from({length: meta.chunks}, (_, i) => String(all[chunkKey(i)] ?? '')).join('');
  if (text.length !== meta.length || await sha256Hex(text) !== meta.sha256) throw new CloudCopyError('incomplete');
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (e) {
    throw new CloudCopyError('incomplete');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new CloudCopyError('incomplete');
  return {meta, settings};
}

/** @type {Object<string, string>} runtime.getPlatformInfo's names. */
const OS_NAMES = {
  win: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android', cros: 'ChromeOS', openbsd: 'OpenBSD',
  fuchsia: 'Fuchsia',
};

/**
 * @param {CloudMeta} meta
 * @return {string[]} When and on which system it was saved, as the messages take them.
 */
function savedOn(meta) {
  const when = new Date(meta.savedAt).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
  return [when, Object.hasOwn(OS_NAMES, meta.os) ? OS_NAMES[meta.os] : meta.os];
}

/**
 * @param {*} error
 * @return {string} What to tell the user.
 */
function errorMessage(error) {
  switch (error instanceof CloudCopyError ? error.reason : null) {
    case 'none': return Localize.getMessage('options_cloud_none');
    case 'quota': return Localize.getMessage('options_cloud_quota');
    case 'incomplete': return Localize.getMessage('options_cloud_incomplete');
    default: return Localize.getMessage('options_cloud_failed', [String(error?.message ?? error)]);
  }
}

/**
 * The options page's "Export to cloud" and "Import from cloud", and the copy's status. The import
 * asks on the page, not with window.confirm: the page is embedded in about:addons and framed in
 * the player inside web pages, where a dialog is not known to work.
 */
export class CloudSettings {
  /**
   * @param {Object} parts
   * @param {HTMLElement} parts.box - The buttons, the question, the status, the result and the hint.
   * @param {HTMLButtonElement} parts.exportButton
   * @param {HTMLButtonElement} parts.importButton
   * @param {HTMLElement} parts.question - Whether to replace the settings; hidden until asked.
   * @param {HTMLElement} parts.questionText
   * @param {HTMLButtonElement} parts.replaceButton
   * @param {HTMLButtonElement} parts.cancelButton
   * @param {HTMLElement} parts.status - When the copy was saved, or that there is none.
   * @param {HTMLElement} parts.result - What the last click did.
   * @param {SyncArea|undefined} parts.area - storage.sync; none in the web build.
   * @param {() => Promise<Object>} parts.settings - The object the file export writes.
   * @param {(settings: Object<string, *>) => void} parts.apply - The file import's way in.
   * @param {() => Promise<string>} parts.os
   * @param {() => boolean} parts.isAndroid
   */
  constructor({box, exportButton, importButton, question, questionText, replaceButton, cancelButton, status, result,
    area, settings, apply, os, isAndroid}) {
    this.box = box;
    this.exportButton = exportButton;
    this.importButton = importButton;
    this.question = question;
    this.questionText = questionText;
    this.replaceButton = replaceButton;
    this.status = status;
    this.result = result;
    this.area = area;
    this.settings = settings;
    this.apply = apply;
    this.os = os;
    this.isAndroid = isAndroid;
    this.seen = false;
    /** @type {?Object<string, *>} The copy the open question is about. */
    this.asked = null;

    exportButton.addEventListener('click', () => this.exportCopy());
    importButton.addEventListener('click', () => this.importCopy());
    replaceButton.addEventListener('click', () => this.replace());
    cancelButton.addEventListener('click', () => this.closeQuestion(true));
    area?.onChanged?.addListener((changes) => {
      if (Object.keys(changes).some(isCloudKey)) this.refresh();
    });
    this.showWhereItWorks();
  }

  /**
   * Firefox for Android keeps storage.sync on the phone (browser-compat-data: "Data isn't
   * synchronized with the user's Mozilla account"): not offered there. Decided again once
   * Firefox has said which system it is.
   */
  showWhereItWorks() {
    this.box.hidden = !this.area || this.isAndroid();
    if (this.seen) this.refresh();
  }

  /** Read when first seen: the page is an iframe in every player. */
  pageSeen() {
    if (this.seen) return;
    this.seen = true;
    this.refresh();
  }

  /** @return {Promise<void>} */
  async refresh() {
    if (!this.area || this.box.hidden) return;
    try {
      const meta = await readCloudMeta(this.area);
      this.status.textContent = meta ?
        Localize.getMessage('options_cloud_status_saved', savedOn(meta)) :
        Localize.getMessage('options_cloud_status_none');
    } catch (e) {
      this.status.textContent = errorMessage(e);
    }
  }

  /** @return {Promise<void>} */
  async exportCopy() {
    this.closeQuestion();
    await this.#busy(async (area) => {
      await saveCloudCopy(area, await this.settings(), await this.os());
      this.result.textContent = Localize.getMessage('options_cloud_export_done');
    });
  }

  /**
   * Reads the copy and asks whether to replace the settings with it; a question already open
   * goes, unanswered.
   * @return {Promise<void>}
   */
  async importCopy() {
    this.closeQuestion();
    await this.#busy(async (area) => {
      const {meta, settings} = await readCloudCopy(area);
      this.asked = settings;
      this.questionText.textContent = Localize.getMessage('options_cloud_confirm', savedOn(meta));
      this.question.hidden = false;
      this.replaceButton.focus();
    });
  }

  /** The answer "Replace": the copy the question was about goes in. */
  replace() {
    const settings = this.asked;
    this.closeQuestion(true);
    if (!settings) return;
    try {
      this.apply(settings);
      this.result.textContent = Localize.getMessage('options_cloud_import_done');
    } catch (e) {
      this.result.textContent = errorMessage(e);
    }
  }

  /**
   * Takes the question down, with no change.
   * @param {boolean} [answered] - From one of its buttons: the focus goes back to "Import from cloud".
   */
  closeQuestion(answered = false) {
    const open = !this.question.hidden;
    this.asked = null;
    this.question.hidden = true;
    if (answered && open) this.importButton.focus();
  }

  /**
   * One click at a time.
   * @param {(area: SyncArea) => Promise<void>} work
   */
  async #busy(work) {
    if (!this.area || this.exportButton.disabled) return;
    this.exportButton.disabled = true;
    this.importButton.disabled = true;
    this.result.textContent = '';
    try {
      await work(this.area);
    } catch (e) {
      this.result.textContent = errorMessage(e);
    } finally {
      this.exportButton.disabled = false;
      this.importButton.disabled = false;
      this.refresh();
    }
  }
}
