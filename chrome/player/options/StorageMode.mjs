// @ts-check
import {DefaultOptions} from './defaults/DefaultOptions.mjs';

/**
 * Where downloaded video is kept (Options > General, "Where to keep downloaded video"). No option of its own: it is
 * what ramBudget and bufferToDisk do together, and every pair of the two is one of these.
 * - RAM_THEN_DISK: RAM up to ramBudget (> 0), the rest on the disk.
 * - RAM_ONLY: RAM up to ramBudget (> 0, or -1 for no limit); what does not fit is let go of and downloaded again.
 * - DISK_ONLY: ramBudget 0 with the disk: all but the next seconds go to the disk at once.
 */
export const StorageModes = Object.freeze({
  RAM_THEN_DISK: 'ramdisk',
  RAM_ONLY: 'ramonly',
  DISK_ONLY: 'disk',
});

/** The seconds the "ahead" field takes at most: more is the whole video, which is predownload's. */
export const BufferAheadMaxSeconds = 3600;

/**
 * @param {{ramBudget: number, bufferToDisk?: boolean}} options
 * @return {string} One of StorageModes.
 */
export function storageModeOf({ramBudget, bufferToDisk}) {
  if (bufferToDisk === false || ramBudget < 0) return StorageModes.RAM_ONLY;
  return ramBudget === 0 ? StorageModes.DISK_ONLY : StorageModes.RAM_THEN_DISK;
}

/**
 * RAM for buffered video on a computer with this much memory: an eighth of it, at most 4 GB. Windows and Firefox need
 * most of the rest; the video beyond it goes to the disk.
 * @param {number} gigabytes - 0 when not given: the default.
 * @return {number} Bytes.
 */
export function recommendedRamBudget(gigabytes) {
  if (!(gigabytes > 0)) return DefaultOptions.ramBudget;
  return Math.min(gigabytes, 32) / 8 * 1e9;
}

/**
 * The options a mode is picked with: the RAM amount stays where the mode uses it, else the recommended one.
 * @param {string} mode - One of StorageModes.
 * @param {{ramBudget: number, computerMemory: number}} options - The options now.
 * @return {{ramBudget: number, bufferToDisk: boolean}}
 */
export function optionsForStorageMode(mode, {ramBudget, computerMemory}) {
  const recommended = recommendedRamBudget(computerMemory);
  if (mode === StorageModes.DISK_ONLY) return {ramBudget: 0, bufferToDisk: true};
  if (mode === StorageModes.RAM_ONLY) return {ramBudget: ramBudget === 0 ? recommended : ramBudget, bufferToDisk: false};
  return {ramBudget: ramBudget > 0 ? ramBudget : recommended, bufferToDisk: true};
}

/**
 * Saved settings from before the modes, as what they did: "no limit" with the disk on kept all in RAM (RAM only), and
 * 0 with the disk off kept nothing ahead (now RAM only with the recommended amount). "Seconds ahead" left empty
 * downloaded the whole video: now predownload on, with no maximum size, and the default seconds.
 * @param {Object<string, *>} options - Saved options merged over the defaults; changed in place.
 * @return {Object<string, *>} The same options.
 */
export function migrateStorage(options) {
  if (options.ramBudget < 0 && options.bufferToDisk !== false) {
    options.bufferToDisk = false;
  } else if (options.ramBudget === 0 && options.bufferToDisk === false) {
    options.ramBudget = recommendedRamBudget(options.computerMemory);
  }
  if (options.bufferAhead < 0) {
    options.bufferAhead = DefaultOptions.bufferAhead;
    options.downloadAll = true;
    options.maxVideoSize = -1;
  } else if (options.bufferAhead > BufferAheadMaxSeconds) {
    options.bufferAhead = BufferAheadMaxSeconds;
  }
  return options;
}
