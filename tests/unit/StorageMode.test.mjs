import {describe, expect, it} from 'vitest';

import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';
import {AutomaticRamBudget, migrateStorage, optionsForStorageMode, StorageModes, storageModeOf} from
  '../../chrome/player/options/StorageMode.mjs';
import {AheadSteps, BehindSteps, MaxSizeSteps, RamOnlySteps, SpeedSteps} from '../../chrome/player/options/SettingSteps.mjs';

// Two settings, "RAM for buffered video" and "Keep video on disk when this RAM is full", made three ways of keeping
// video, and two pairs that contradicted themselves: no limit with the disk on (the disk never used), and 0 with the
// disk off (nothing kept ahead, the video waiting for each part). "Where to keep downloaded video" names the three;
// "RAM, then disk" keeps an automatic amount in RAM, and only "RAM only" has a limit to pick, from a few steps.

const GB = 1e9;
const MB = 1e6;
const MBIT = 125000;

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

  it('reads the defaults as RAM, then disk, with the automatic amount', () => {
    expect(storageModeOf(DefaultOptions)).toBe(StorageModes.RAM_THEN_DISK);
    expect(DefaultOptions.ramBudget).toBe(AutomaticRamBudget);
  });
});

describe('optionsForStorageMode', () => {
  it('gives RAM, then disk the automatic amount, whatever was set before', () => {
    for (const ramBudget of [0, -1, 512 * MB, 4 * GB, 20 * GB]) {
      expect(optionsForStorageMode(StorageModes.RAM_THEN_DISK, {ramBudget}))
          .toEqual({ramBudget: AutomaticRamBudget, bufferToDisk: true});
    }
  });

  it('keeps RAM only\'s limit when it is one of its steps, else takes the automatic amount', () => {
    expect(optionsForStorageMode(StorageModes.RAM_ONLY, {ramBudget: 2 * GB})).toEqual({ramBudget: 2 * GB, bufferToDisk: false});
    for (const ramBudget of [0, -1, 3 * GB, 20 * GB]) {
      expect(optionsForStorageMode(StorageModes.RAM_ONLY, {ramBudget}))
          .toEqual({ramBudget: AutomaticRamBudget, bufferToDisk: false});
    }
  });

  it('makes disk only 0 in RAM with the disk', () => {
    expect(optionsForStorageMode(StorageModes.DISK_ONLY, {ramBudget: 2 * GB})).toEqual({ramBudget: 0, bufferToDisk: true});
  });

  it('gives back the mode picked, from any amount before', () => {
    for (const mode of Object.values(StorageModes)) {
      for (const ramBudget of [-1, 0, 512 * MB, 3 * GB]) {
        expect(storageModeOf(optionsForStorageMode(mode, {ramBudget}))).toBe(mode);
      }
    }
  });
});

describe('migrateStorage', () => {
  // As saved before the pickers: no storageVersion.
  const migrated = (options) => migrateStorage({...DefaultOptions, ...options}, options);

  it('leaves the defaults as they are', () => {
    expect(migrated({})).toEqual({...DefaultOptions});
  });

  it('runs once: what is saved with storageVersion stays as it is', () => {
    const saved = {ramBudget: 2 * MB, bufferToDisk: true, downloadAll: false, bufferAhead: 45, storageVersion: DefaultOptions.storageVersion};
    expect(migrateStorage({...DefaultOptions, ...saved}, saved)).toMatchObject(saved);
    const before = {ramBudget: 2 * MB, bufferToDisk: true, downloadAll: false, bufferAhead: 45};
    expect(migrateStorage({...DefaultOptions, ...before}, before))
        .toMatchObject({ramBudget: AutomaticRamBudget, bufferAhead: 60, storageVersion: DefaultOptions.storageVersion});
  });

  it('takes no limit with the disk on as RAM only, now with its largest limit', () => {
    expect(migrated({ramBudget: -1, bufferToDisk: true})).toMatchObject({ramBudget: 4 * GB, bufferToDisk: false});
    expect(migrated({ramBudget: -1, bufferToDisk: false})).toMatchObject({ramBudget: 4 * GB, bufferToDisk: false});
  });

  it('takes 0 with the disk off, which kept nothing ahead, as RAM only with the automatic amount', () => {
    expect(migrated({ramBudget: 0, bufferToDisk: false})).toMatchObject({ramBudget: AutomaticRamBudget, bufferToDisk: false});
  });

  it('gives RAM, then disk the automatic amount, however much was set by hand', () => {
    for (const ramBudget of [300 * MB, 4 * GB, 20 * GB]) {
      expect(migrated({ramBudget, bufferToDisk: true})).toMatchObject({ramBudget: AutomaticRamBudget, bufferToDisk: true});
    }
  });

  it('moves RAM only\'s limit to the nearest step, and leaves disk only at 0', () => {
    expect(migrated({ramBudget: 3 * GB, bufferToDisk: false}).ramBudget).toBe(4 * GB);
    expect(migrated({ramBudget: 20 * GB, bufferToDisk: false}).ramBudget).toBe(4 * GB);
    expect(migrated({ramBudget: 100 * MB, bufferToDisk: false}).ramBudget).toBe(512 * MB);
    expect(migrated({ramBudget: 0, bufferToDisk: true})).toMatchObject({ramBudget: 0, bufferToDisk: true});
  });

  it('takes "Seconds ahead" with no limit as the whole video, as it downloaded', () => {
    expect(migrated({bufferAhead: -1, downloadAll: false, maxVideoSize: 5 * GB}))
        .toMatchObject({bufferAhead: DefaultOptions.bufferAhead, downloadAll: true, maxVideoSize: -1});
  });

  it('takes a largest size of 0, which predownloaded nothing, as the time ahead alone', () => {
    expect(migrated({maxVideoSize: 0, downloadAll: true, bufferAhead: 600}))
        .toMatchObject({downloadAll: false, maxVideoSize: DefaultOptions.maxVideoSize, bufferAhead: 600});
  });

  it('sets the time ahead to its default with the whole video, the least a video too large for the room keeps', () => {
    expect(migrated({downloadAll: true, bufferAhead: 3600}).bufferAhead).toBe(DefaultOptions.bufferAhead);
  });

  it('moves each number to the nearest step of its picker, by ratio', () => {
    expect(migrated({downloadAll: false, bufferAhead: 0}).bufferAhead).toBe(30);
    expect(migrated({downloadAll: false, bufferAhead: 3000}).bufferAhead).toBe(3600);
    expect(migrated({downloadAll: false, bufferAhead: 86400}).bufferAhead).toBe(3600);
    expect(migrated({downloadAll: false, bufferAhead: 400}).bufferAhead).toBe(300);
    expect(migrated({maxVideoSize: 3 * GB}).maxVideoSize).toBe(2 * GB);
    expect(migrated({maxVideoSize: 50 * GB}).maxVideoSize).toBe(20 * GB);
    expect(migrated({maxVideoSize: -1}).maxVideoSize).toBe(-1);
    expect(migrated({bufferBehind: 0}).bufferBehind).toBe(20);
    expect(migrated({bufferBehind: 120}).bufferBehind).toBe(60);
    expect(migrated({bufferBehind: -1}).bufferBehind).toBe(-1);
    expect(migrated({maxSpeed: 0}).maxSpeed).toBe(2 * MBIT);
    expect(migrated({maxSpeed: 30 * MBIT}).maxSpeed).toBe(20 * MBIT);
    expect(migrated({maxSpeed: -1}).maxSpeed).toBe(-1);
  });

  it('leaves every value on a step, whatever was saved', () => {
    const odd = [-1, 0, 1, 7, 45, 999, 1e5, 3.5e9, 1e12, Infinity, NaN];
    for (const value of odd) {
      for (const downloadAll of [true, false]) {
        for (const bufferToDisk of [true, false]) {
          const options = migrated({bufferAhead: value, maxVideoSize: value, bufferBehind: value, maxSpeed: value, ramBudget: value,
            downloadAll, bufferToDisk});
          expect(AheadSteps).toContain(options.bufferAhead);
          expect(MaxSizeSteps).toContain(options.maxVideoSize);
          expect(BehindSteps).toContain(options.bufferBehind);
          expect(SpeedSteps).toContain(options.maxSpeed);
          expect([0, AutomaticRamBudget, ...RamOnlySteps]).toContain(options.ramBudget);
          expect(migrateStorage({...options})).toEqual(options);
        }
      }
    }
  });

  it('is what the players and the background read: saved options are migrated when they are loaded', async () => {
    const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
    const read = Utils.readStoredConfig;
    Utils.readStoredConfig = async () => ({ramBudget: -1, bufferToDisk: true, bufferAhead: -1, computerMemory: 8});
    try {
      const options = await Utils.getOptionsFromStorage();
      expect(options).toMatchObject({ramBudget: 4 * GB, bufferToDisk: false, bufferAhead: 300, downloadAll: true, maxVideoSize: -1});
      expect(options).not.toHaveProperty('computerMemory');
    } finally {
      Utils.readStoredConfig = read;
    }
  });
});
