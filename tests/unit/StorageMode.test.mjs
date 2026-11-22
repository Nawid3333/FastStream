import {describe, expect, it} from 'vitest';

import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';
import {BufferAheadMaxSeconds, migrateStorage, optionsForStorageMode, recommendedRamBudget, StorageModes, storageModeOf} from
  '../../chrome/player/options/StorageMode.mjs';

// Two settings, "RAM for buffered video" and "Keep video on disk when this RAM is full", made three ways of keeping
// video, and two pairs that contradicted themselves: no limit with the disk on (the disk never used), and 0 with the
// disk off (nothing kept ahead, the video waiting for each part). "Where to keep downloaded video" names the three.

const GB = 1e9;
const MB = 1e6;

describe('storageModeOf', () => {
  it('reads the three modes from the two settings', () => {
    expect(storageModeOf({ramBudget: 2 * GB, bufferToDisk: true})).toBe(StorageModes.RAM_THEN_DISK);
    expect(storageModeOf({ramBudget: 2 * GB, bufferToDisk: false})).toBe(StorageModes.RAM_ONLY);
    expect(storageModeOf({ramBudget: -1, bufferToDisk: false})).toBe(StorageModes.RAM_ONLY);
    expect(storageModeOf({ramBudget: 0, bufferToDisk: true})).toBe(StorageModes.DISK_ONLY);
  });

  it('reads no limit with the disk on as RAM only: the disk was never used', () => {
    expect(storageModeOf({ramBudget: -1, bufferToDisk: true})).toBe(StorageModes.RAM_ONLY);
  });

  it('reads the defaults as RAM, then disk', () => {
    expect(storageModeOf(DefaultOptions)).toBe(StorageModes.RAM_THEN_DISK);
  });
});

describe('recommendedRamBudget', () => {
  it('is an eighth of the memory, at most 4 GB, and the default when the memory is not given', () => {
    expect([4, 8, 16, 32, 64].map(recommendedRamBudget)).toEqual([0.5 * GB, 1 * GB, 2 * GB, 4 * GB, 4 * GB]);
    expect(recommendedRamBudget(0)).toBe(DefaultOptions.ramBudget);
    expect(recommendedRamBudget(NaN)).toBe(DefaultOptions.ramBudget);
  });
});

describe('optionsForStorageMode', () => {
  it('keeps the amount the user set where the mode uses it', () => {
    expect(optionsForStorageMode(StorageModes.RAM_ONLY, {ramBudget: 3 * GB, computerMemory: 16}))
        .toEqual({ramBudget: 3 * GB, bufferToDisk: false});
    expect(optionsForStorageMode(StorageModes.RAM_THEN_DISK, {ramBudget: 3 * GB, computerMemory: 16}))
        .toEqual({ramBudget: 3 * GB, bufferToDisk: true});
  });

  it('sets 0 for disk only, and the recommended amount when leaving it', () => {
    expect(optionsForStorageMode(StorageModes.DISK_ONLY, {ramBudget: 3 * GB, computerMemory: 16}))
        .toEqual({ramBudget: 0, bufferToDisk: true});
    expect(optionsForStorageMode(StorageModes.RAM_THEN_DISK, {ramBudget: 0, computerMemory: 8}))
        .toEqual({ramBudget: 1 * GB, bufferToDisk: true});
    expect(optionsForStorageMode(StorageModes.RAM_ONLY, {ramBudget: 0, computerMemory: 0}))
        .toEqual({ramBudget: DefaultOptions.ramBudget, bufferToDisk: false});
  });

  it('never takes no limit into RAM, then disk, where the disk would never be used', () => {
    expect(optionsForStorageMode(StorageModes.RAM_THEN_DISK, {ramBudget: -1, computerMemory: 8}))
        .toEqual({ramBudget: 1 * GB, bufferToDisk: true});
    expect(optionsForStorageMode(StorageModes.RAM_ONLY, {ramBudget: -1, computerMemory: 8}))
        .toEqual({ramBudget: -1, bufferToDisk: false});
  });

  it('gives back the mode it was asked for, from any settings', () => {
    for (const mode of Object.values(StorageModes)) {
      for (const ramBudget of [-1, 0, 500 * MB, 8 * GB]) {
        for (const computerMemory of [0, 8]) {
          expect(storageModeOf(optionsForStorageMode(mode, {ramBudget, computerMemory}))).toBe(mode);
        }
      }
    }
  });
});

describe('migrateStorage', () => {
  const migrated = (options) => migrateStorage({...DefaultOptions, ...options});

  it('takes no limit with the disk on as RAM only, as it worked', () => {
    expect(migrated({ramBudget: -1, bufferToDisk: true})).toMatchObject({ramBudget: -1, bufferToDisk: false});
  });

  it('takes 0 with the disk off, which kept nothing ahead, as RAM only with the recommended amount', () => {
    expect(migrated({ramBudget: 0, bufferToDisk: false, computerMemory: 16})).toMatchObject({ramBudget: 2 * GB, bufferToDisk: false});
    expect(migrated({ramBudget: 0, bufferToDisk: false, computerMemory: 0}))
        .toMatchObject({ramBudget: DefaultOptions.ramBudget, bufferToDisk: false});
  });

  it('leaves the three modes as they are', () => {
    for (const pair of [{ramBudget: 1 * GB, bufferToDisk: true}, {ramBudget: 1 * GB, bufferToDisk: false},
      {ramBudget: -1, bufferToDisk: false}, {ramBudget: 0, bufferToDisk: true}]) {
      expect(migrated(pair)).toMatchObject(pair);
    }
  });

  it('takes "Seconds ahead" with no limit as predownload of the whole video, as it downloaded', () => {
    expect(migrated({bufferAhead: -1, downloadAll: false, maxVideoSize: 5 * GB}))
        .toMatchObject({bufferAhead: DefaultOptions.bufferAhead, downloadAll: true, maxVideoSize: -1});
  });

  it('holds "Seconds ahead" at an hour, and leaves a number below it alone', () => {
    expect(migrated({bufferAhead: 86400}).bufferAhead).toBe(BufferAheadMaxSeconds);
    expect(migrated({bufferAhead: 0, downloadAll: false, maxVideoSize: 5 * GB}))
        .toMatchObject({bufferAhead: 0, downloadAll: false, maxVideoSize: 5 * GB});
  });

  it('is what the players and the background read: saved options are migrated when they are loaded', async () => {
    const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
    const read = Utils.readStoredConfig;
    Utils.readStoredConfig = async () => ({ramBudget: -1, bufferToDisk: true, bufferAhead: -1});
    try {
      expect(await Utils.getOptionsFromStorage()).toMatchObject({ramBudget: -1, bufferToDisk: false, bufferAhead: 300,
        downloadAll: true, maxVideoSize: -1});
    } finally {
      Utils.readStoredConfig = read;
    }
  });
});
