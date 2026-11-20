// A stand-in for Firefox's storage.sync that keeps its quotas as Firefox 160 does
// (measured: tests/e2e/ext-specs/cloud-settings.e2e.mjs checks the same rules in Firefox):
// - an item's key and the JSON of its value: at most 8192 UTF-8 bytes;
// - the JSON of all items together: at most 102400 UTF-8 bytes;
// - at most 512 items;
// a set() over any of them writes nothing and rejects with Firefox's error.

export const QUOTA_MESSAGE = 'QuotaExceededError: storage.sync API call exceeded its quota limitations.';
export const QUOTA_BYTES = 102400;
export const QUOTA_BYTES_PER_ITEM = 8192;
export const MAX_ITEMS = 512;

const encoder = new TextEncoder();

/**
 * @param {string} text
 * @return {number} Its UTF-8 bytes.
 */
export const utf8Bytes = (text) => encoder.encode(text).length;

/**
 * @param {string} key
 * @param {*} value
 * @return {number} The bytes Firefox counts for one item.
 */
export const itemBytes = (key, value) => utf8Bytes(key) + utf8Bytes(JSON.stringify(value));

const items = (count, value, prefix, from = 0) =>
  Object.fromEntries(Array.from({length: count}, (_, i) => [prefix + (from + i), value]));
const TOTAL_BASE = items(12, 'x'.repeat(7870), 'k', 10);
const TOTAL_KEYS = [...Object.keys(TOTAL_BASE), 'k22'].sort();

/**
 * Firefox's quota rules, one set() a step on the area as the steps before left it ({clear}
 * empties it): `quota` whether Firefox 160 refused it (measured), `keys` what the area then
 * holds. cloud-settings.e2e.mjs runs them in Firefox, CloudSettings.test.mjs on the stand-in.
 * @type {Array<{clear: true}|{set: Object<string, *>, quota: boolean, keys?: string[]}>}
 */
export const QUOTA_STEPS = [
  {clear: true},
  // An item: its key and its value's JSON, 8192 bytes at most.
  {set: {k: 'x'.repeat(8189)}, quota: false},
  {set: {k: 'x'.repeat(8190)}, quota: true},
  {set: {k: '"'.repeat(4094) + 'x'}, quota: false},
  {set: {k: '"'.repeat(4095)}, quota: true},
  {set: {k: '\u0001'.repeat(1364) + 'xxxx'}, quota: false},
  {set: {k: '\u0001'.repeat(1365)}, quota: true},
  {set: {k: '\u{1F600}'.repeat(2047)}, quota: false},
  {set: {k: '\u{1F600}'.repeat(2048)}, quota: true},
  {set: {'é': 'x'.repeat(8188)}, quota: false},
  {set: {'é': 'x'.repeat(8189)}, quota: true},
  {clear: true},
  // Over a quota, nothing of the set() is written.
  {set: {a: 'small', b: 'x'.repeat(9000)}, quota: true, keys: []},
  // All items: their JSON together, 102400 bytes at most.
  {set: TOTAL_BASE, quota: false},
  {set: {k22: 'x'.repeat(7842)}, quota: false, keys: TOTAL_KEYS},
  {set: {k22: 'x'.repeat(7843)}, quota: true},
  {set: {zz: 'y', k22: 'x'.repeat(7900)}, quota: true, keys: TOTAL_KEYS},
  {clear: true},
  // 512 items at most; one of them can still be replaced.
  {set: items(512, 1, 'i'), quota: false},
  {set: {extra: 1}, quota: true},
  {set: {i0: 2}, quota: false},
  {clear: true},
];

/**
 * @param {Object} [initial] - Items already there.
 * @return {Object} The area: get, set, remove, clear, onChanged, and `data` (what it holds).
 */
export function fakeStorageSync(initial = {}) {
  const listeners = [];
  const area = {
    data: structuredClone(initial),
    calls: [],
    async get(keys) {
      area.calls.push(['get', keys]);
      const names = keys === null || keys === undefined ? Object.keys(area.data) : [].concat(keys);
      const result = {};
      for (const key of names) {
        if (Object.hasOwn(area.data, key)) result[key] = structuredClone(area.data[key]);
      }
      return result;
    },
    async set(items) {
      area.calls.push(['set', Object.keys(items)]);
      const next = {...area.data};
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        const had = Object.hasOwn(next, key);
        if (!had && Object.keys(next).length >= MAX_ITEMS) throw new Error(QUOTA_MESSAGE);
        if (itemBytes(key, value) > QUOTA_BYTES_PER_ITEM) throw new Error(QUOTA_MESSAGE);
        changes[key] = {...(had ? {oldValue: next[key]} : {}), newValue: structuredClone(value)};
        next[key] = structuredClone(value);
      }
      if (utf8Bytes(JSON.stringify(next)) > QUOTA_BYTES) throw new Error(QUOTA_MESSAGE);
      area.data = next;
      notify(changes);
    },
    async remove(keys) {
      area.calls.push(['remove', [].concat(keys)]);
      const changes = {};
      for (const key of [].concat(keys)) {
        if (Object.hasOwn(area.data, key)) {
          changes[key] = {oldValue: area.data[key]};
          delete area.data[key];
        }
      }
      notify(changes);
    },
    async clear() {
      await area.remove(Object.keys(area.data));
    },
    onChanged: {
      addListener: (fn) => listeners.push(fn),
    },
    /** Writes as another computer's copy arrives through Sync: no quota, as a merge. */
    arrive(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        if (value === undefined) {
          changes[key] = {oldValue: area.data[key]};
          delete area.data[key];
        } else {
          changes[key] = {newValue: value};
          area.data[key] = structuredClone(value);
        }
      }
      notify(changes);
    },
  };
  const notify = (changes) => {
    if (Object.keys(changes).length) setTimeout(() => listeners.forEach((fn) => fn(changes, 'sync')), 0);
  };
  return area;
}
