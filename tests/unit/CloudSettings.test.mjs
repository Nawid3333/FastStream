import {createHash} from 'node:crypto';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CloudCopyError, ITEM_BYTES, META_KEY, chunkKey, readCloudCopy, readCloudMeta, saveCloudCopy, splitForSync,
} from '../../chrome/player/options/CloudSettings.mjs';
import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';
import {DefaultSubtitlesSettings} from '../../chrome/player/options/defaults/DefaultSubtitlesSettings.mjs';
import {DefaultToolSettings} from '../../chrome/player/options/defaults/ToolSettings.mjs';
import {settingsForExport} from '../../chrome/player/options/SettingsFile.mjs';
import {QUOTA_MESSAGE, QUOTA_STEPS, fakeStorageSync, itemBytes, utf8Bytes} from './helpers/fakeStorageSync.mjs';

// The settings' copy in storage.sync (CloudSettings.mjs), against a stand-in that keeps
// Firefox's quotas: the copy is cut into items of at most 8000 bytes (Firefox allows 8192),
// written in one set(), read back in one get(), and checked against its length and SHA-256.

const NOW = Date.UTC(2026, 10, 20, 12, 30);

/** The object the settings file holds, with the defaults. */
const defaults = () => ({
  ...settingsForExport(structuredClone(DefaultOptions)),
  subtitlesSettings: structuredClone(DefaultSubtitlesSettings),
  toolSettings: structuredClone(DefaultToolSettings),
});

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Characters JSON escapes or UTF-8 takes several bytes for, and pairs that must not be cut. */
const AWKWARD = ['"', '\\', '\n', '\t', '\u0001', '\u001f', 'é', 'ß', '例', '路', '\u2028', '\u{1F600}', '\u{1D538}', '/', '~'];

/**
 * Settings with lists of several hundred entries, all of AWKWARD in them.
 * @param {number} count - Entries in each list.
 */
function large(count) {
  const settings = defaults();
  const odd = (i) => AWKWARD[i % AWKWARD.length] + AWKWARD[(i * 7) % AWKWARD.length];
  settings.autoEnableURLs = Array.from({length: count}, (_, i) => `https://例え${i}.example/路径/${odd(i)}?q="${i}"`);
  settings.mpvAllowlist = Array.from({length: count}, (_, i) => `site-${i}.example ${odd(i + 3)} @anime`);
  settings.customSourcePatterns = Array.from({length: count},
      (_, i) => `# ${odd(i + 5)} pattern ${i}\nmp4 /^https:\\/\\/cdn${i}\\.example\\/.*\\.mp4(\\?.*)?$/i`).join('\n');
  return settings;
}

const chunkKeys = (area) => Object.keys(area.data).filter((key) => key !== META_KEY).sort();

describe('splitForSync', () => {
  it('cuts any text into items within 8000 bytes, key and JSON escapes counted, never inside a surrogate pair', () => {
    fc.assert(fc.property(
        // size 'max': else fast-check keeps to a few characters, and nothing is cut.
        fc.string({unit: fc.constantFrom(...AWKWARD, 'a', 'b'), maxLength: 30000, size: 'max'}),
        (text) => {
          const slices = splitForSync(text);
          expect(slices.join('')).toBe(text);
          slices.forEach((slice, i) => {
            expect(itemBytes(chunkKey(i), slice)).toBeLessThanOrEqual(ITEM_BYTES);
            expect(slice.isWellFormed()).toBe(true);
          });
          // Full items: the next character would not have fitted.
          for (let i = 0; i < slices.length - 1; i++) {
            const next = String.fromCodePoint(/** @type {number} */ (slices[i + 1].codePointAt(0)));
            expect(itemBytes(chunkKey(i), slices[i] + next)).toBeGreaterThan(ITEM_BYTES);
          }
        }), {numRuns: 60, endOnFailure: true}); // shrinking texts this long takes minutes
  });

  it('counts a lone surrogate as JSON.stringify writes it', () => {
    const text = '\ud800'.repeat(3000);
    const slices = splitForSync(text);
    expect(slices.join('')).toBe(text);
    slices.forEach((slice, i) => expect(itemBytes(chunkKey(i), slice)).toBeLessThanOrEqual(ITEM_BYTES));
  });

  it('cuts emoji only between them', () => {
    const text = '\u{1F600}'.repeat(5000);
    const slices = splitForSync(text);
    expect(slices.length).toBe(3);
    for (const slice of slices) expect(slice.isWellFormed()).toBe(true);
  });
});

describe('the cloud copy', () => {
  it('takes the default settings there and back', async () => {
    const area = fakeStorageSync();
    const settings = defaults();
    const meta = await saveCloudCopy(area, settings, 'win', NOW);
    const text = JSON.stringify(settings);
    expect(meta).toEqual({v: 1, savedAt: NOW, os: 'win', chunks: meta.chunks, length: text.length, sha256: sha256(text)});
    expect(area.data[META_KEY]).toEqual(meta);
    expect(chunkKeys(area)).toHaveLength(meta.chunks);
    // One set(), nothing removed.
    expect(area.calls.filter(([call]) => call === 'set')).toHaveLength(1);
    expect(area.calls.filter(([call]) => call === 'remove')).toHaveLength(0);
    const read = await readCloudCopy(area);
    expect(read.settings).toEqual(settings);
    expect(read.meta).toEqual(meta);
    // Nothing stored about the computer but its system.
    expect(Object.keys(meta).sort()).toEqual(['chunks', 'length', 'os', 'savedAt', 'sha256', 'v']);
  });

  it('cuts a large copy into items under Firefox\'s limit and puts it back together exactly', async () => {
    const area = fakeStorageSync();
    const settings = large(300);
    const text = JSON.stringify(settings);
    expect(utf8Bytes(text)).toBeGreaterThan(50000);
    const meta = await saveCloudCopy(area, settings, 'linux', NOW);
    expect(meta.chunks).toBeGreaterThan(6);
    for (const key of chunkKeys(area)) expect(itemBytes(key, area.data[key])).toBeLessThanOrEqual(ITEM_BYTES);
    expect(Object.values(area.data).filter((v) => typeof v === 'string').join('')).not.toBe('');
    const read = await readCloudCopy(area);
    expect(read.settings).toEqual(settings);
    expect(JSON.stringify(read.settings)).toBe(text);
  });

  it('removes the chunks an older, longer copy left', async () => {
    const area = fakeStorageSync();
    const long = await saveCloudCopy(area, large(300), 'win', NOW);
    expect(chunkKeys(area)).toHaveLength(long.chunks);
    const settings = defaults();
    const short = await saveCloudCopy(area, settings, 'mac', NOW + 1000);
    expect(short.chunks).toBeLessThan(long.chunks);
    expect(chunkKeys(area)).toEqual(Array.from({length: short.chunks}, (_, i) => chunkKey(i)).sort());
    expect((await readCloudCopy(area)).settings).toEqual(settings);
  });

  it('says a copy too large for Firefox does not fit, and leaves the copy there as it was', async () => {
    const area = fakeStorageSync();
    const before = defaults();
    await saveCloudCopy(area, before, 'win', NOW);
    const stored = structuredClone(area.data);
    // About 130 KB: each item fits, all of them together do not.
    const error = await saveCloudCopy(area, large(700), 'win', NOW + 1000).catch((e) => e);
    expect(error).toBeInstanceOf(CloudCopyError);
    expect(error.reason).toBe('quota');
    expect(area.data).toEqual(stored);
    expect((await readCloudCopy(area)).settings).toEqual(before);
  });

  it('passes on an error that is not about the quota', async () => {
    const area = fakeStorageSync();
    area.set = async () => {
      throw new Error('An unexpected error occurred');
    };
    const error = await saveCloudCopy(area, defaults(), 'win', NOW).catch((e) => e);
    expect(error).not.toBeInstanceOf(CloudCopyError);
    expect(error.message).toBe('An unexpected error occurred');
  });

  it('takes Firefox\'s quota error for what it is', async () => {
    const area = fakeStorageSync();
    area.set = async () => {
      throw new Error(QUOTA_MESSAGE);
    };
    expect((await saveCloudCopy(area, defaults(), 'win', NOW).catch((e) => e)).reason).toBe('quota');
  });

  it('finds no copy when there is no meta', async () => {
    expect((await readCloudCopy(fakeStorageSync()).catch((e) => e)).reason).toBe('none');
    // Chunks without their meta: still none.
    const area = fakeStorageSync();
    await saveCloudCopy(area, defaults(), 'win', NOW);
    delete area.data[META_KEY];
    expect((await readCloudCopy(area).catch((e) => e)).reason).toBe('none');
    expect(await readCloudMeta(area)).toBe(null);
  });

  it('calls a copy with a chunk missing incomplete', async () => {
    const area = fakeStorageSync();
    const meta = await saveCloudCopy(area, large(200), 'win', NOW);
    delete area.data[chunkKey(meta.chunks - 1)];
    expect((await readCloudCopy(area).catch((e) => e)).reason).toBe('incomplete');
  });

  it('calls two copies mixed incomplete, also when their lengths agree', async () => {
    // As two computers' copies can mix when Sync merges them item by item.
    const a = fakeStorageSync();
    const b = fakeStorageSync();
    const settingsA = large(200);
    const settingsB = large(200);
    settingsB.autoEnableURLs[150] = settingsB.autoEnableURLs[150].replace('https', 'hxxps');
    const metaA = await saveCloudCopy(a, settingsA, 'win', NOW);
    const metaB = await saveCloudCopy(b, settingsB, 'linux', NOW + 1000);
    expect(metaB.length).toBe(metaA.length);
    expect(metaB.chunks).toBe(metaA.chunks);
    const mixed = fakeStorageSync({...a.data, [META_KEY]: metaB});
    expect((await readCloudCopy(mixed).catch((e) => e)).reason).toBe('incomplete');
    // B's meta and chunks are B again.
    expect((await readCloudCopy(fakeStorageSync({...a.data, ...b.data}))).settings).toEqual(settingsB);
  });

  it('calls a copy whose length or meta is wrong incomplete', async () => {
    const area = fakeStorageSync();
    const meta = await saveCloudCopy(area, defaults(), 'win', NOW);
    area.data[META_KEY] = {...meta, length: meta.length + 1};
    expect((await readCloudCopy(area).catch((e) => e)).reason).toBe('incomplete');
    for (const broken of [{...meta, v: 2}, {...meta, chunks: 0}, {...meta, sha256: 'x'}, 'text', null]) {
      area.data[META_KEY] = broken;
      expect((await readCloudCopy(area).catch((e) => e)).reason, JSON.stringify(broken)).toBe('incomplete');
    }
  });

  it('calls a copy that is no settings object incomplete', async () => {
    for (const text of ['[1,2]', 'null', '{"cut": ']) {
      const area = fakeStorageSync({
        [META_KEY]: {v: 1, savedAt: NOW, os: 'win', chunks: 1, length: text.length, sha256: sha256(text)},
        [chunkKey(0)]: text,
      });
      expect((await readCloudCopy(area).catch((e) => e)).reason, text).toBe('incomplete');
    }
  });

  it('reads a copy another computer wrote, cut its own way', async () => {
    const settings = large(100);
    const text = JSON.stringify(settings);
    const cuts = [0, 1000, 1001, 5000, text.length];
    const items = {
      [META_KEY]: {v: 1, savedAt: NOW, os: 'mac', chunks: cuts.length - 1, length: text.length, sha256: sha256(text)},
    };
    for (let i = 0; i < cuts.length - 1; i++) items[chunkKey(i)] = text.slice(cuts[i], cuts[i + 1]);
    const area = fakeStorageSync(items);
    const read = await readCloudCopy(area);
    expect(read.settings).toEqual(settings);
    expect(read.meta.os).toBe('mac');
    expect(await readCloudMeta(area)).toEqual(items[META_KEY]);
  });
});

describe('the stand-in storage.sync', () => {
  it('keeps Firefox\'s quotas: an item, all items, the number of items, and writes nothing over one', async () => {
    const area = fakeStorageSync();
    for (const [i, step] of QUOTA_STEPS.entries()) {
      if (step.clear) {
        await area.clear();
        continue;
      }
      const error = await area.set(step.set).then(() => null, (e) => e.message);
      expect(error, `step ${i}`).toBe(step.quota ? QUOTA_MESSAGE : null);
      if (step.keys) expect(Object.keys(area.data).sort(), `step ${i}`).toEqual(step.keys);
    }
  });
});
