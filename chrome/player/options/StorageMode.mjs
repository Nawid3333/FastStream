// @ts-check
import {DefaultOptions} from './defaults/DefaultOptions.mjs';
import {AheadSteps, BehindSteps, MaxSizeSteps, nearestStep, RamOnlySteps, SpeedSteps} from './SettingSteps.mjs';

/**
 * Where downloaded video is kept (Options > Download and storage). No option of its own: it is what ramBudget and
 * bufferToDisk do together, and every pair of the two is one of these.
 * - RAM_THEN_DISK: RAM up to AutomaticRamBudget, the rest on the disk.
 * - RAM_ONLY: RAM up to one of RamOnlySteps; what does not fit is let go of and downloaded again.
 * - DISK_ONLY: ramBudget 0 with the disk: all but the next seconds go to the disk at once.
 */
export const StorageModes = Object.freeze({
  RAM_THEN_DISK: 'ramdisk',
  RAM_ONLY: 'ramonly',
  DISK_ONLY: 'disk',
});

/**
 * The RAM all players together keep with "RAM, then disk". Not a setting: measured, more RAM bought only fewer SSD
 * writes, and the same playback (docs/notes/storage.md, "Where downloaded video is kept").
 */
export const AutomaticRamBudget = DefaultOptions.ramBudget;

/**
 * @param {{ramBudget: number, bufferToDisk?: boolean}} options
 * @return {string} One of StorageModes.
 */
export function storageModeOf({ramBudget, bufferToDisk}) {
  if (bufferToDisk === false || ramBudget < 0) return StorageModes.RAM_ONLY;
  return ramBudget === 0 ? StorageModes.DISK_ONLY : StorageModes.RAM_THEN_DISK;
}

/**
 * The options a mode is picked with: "RAM only" keeps its limit when it had one.
 * @param {string} mode - One of StorageModes.
 * @param {{ramBudget: number}} options - The options now.
 * @return {{ramBudget: number, bufferToDisk: boolean}}
 */
export function optionsForStorageMode(mode, {ramBudget}) {
  if (mode === StorageModes.DISK_ONLY) return {ramBudget: 0, bufferToDisk: true};
  if (mode === StorageModes.RAM_ONLY) {
    return {ramBudget: RamOnlySteps.includes(ramBudget) ? ramBudget : AutomaticRamBudget, bufferToDisk: false};
  }
  return {ramBudget: AutomaticRamBudget, bufferToDisk: true};
}

/**
 * Settings saved or imported from before the pickers, as the options page offers them. Once (storageVersion): what
 * is saved since is kept as it is, as a test's small RAM budget with the disk on.
 * - The contradicting pairs from before the modes as what they did: "no limit" with the disk on kept all in RAM (RAM
 *   only), and 0 with the disk off kept nothing ahead (RAM only with the automatic amount).
 * - "RAM, then disk" takes the automatic amount; "RAM only" the nearest of its steps (no limit: the largest).
 * - "Seconds ahead" left empty downloaded the whole video: the whole video, with no largest size. A largest size of
 *   0 predownloaded nothing: the time ahead alone.
 * - With the whole video, the time ahead is the default: what a video too large for the room keeps at least.
 * - Every other number goes to the nearest step of its picker (SettingSteps.mjs).
 * @param {Object<string, *>} options - Saved options merged over the defaults; changed in place.
 * @param {Object<string, *>|null} stored - The options as saved, before the defaults were filled in.
 * @return {Object<string, *>} The same options, with storageVersion set.
 */
export function migrateStorage(options, stored) {
  if (stored?.storageVersion === DefaultOptions.storageVersion) return options;
  options.storageVersion = DefaultOptions.storageVersion;
  if (options.ramBudget < 0 && options.bufferToDisk !== false) {
    options.bufferToDisk = false;
  } else if (options.ramBudget === 0 && options.bufferToDisk === false) {
    options.ramBudget = AutomaticRamBudget;
  }
  const mode = storageModeOf({ramBudget: options.ramBudget, bufferToDisk: options.bufferToDisk});
  if (mode === StorageModes.RAM_THEN_DISK) {
    options.ramBudget = AutomaticRamBudget;
  } else if (mode === StorageModes.RAM_ONLY) {
    options.ramBudget = nearestStep(options.ramBudget, RamOnlySteps);
  }

  if (options.bufferAhead < 0) {
    options.downloadAll = true;
    options.maxVideoSize = -1;
  }
  if (options.maxVideoSize === 0) {
    options.downloadAll = false;
    options.maxVideoSize = DefaultOptions.maxVideoSize;
  }
  options.bufferAhead = options.downloadAll ? DefaultOptions.bufferAhead : nearestStep(options.bufferAhead, AheadSteps);
  options.maxVideoSize = nearestStep(options.maxVideoSize, MaxSizeSteps);
  options.bufferBehind = nearestStep(options.bufferBehind, BehindSteps);
  options.maxSpeed = nearestStep(options.maxSpeed, SpeedSteps);
  return options;
}
