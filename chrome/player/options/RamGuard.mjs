// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';

const GB = 1e9;

/** The memory sizes offered, in GB; the last one stands for that or more. */
export const ComputerMemorySizes = [4, 8, 16, 32];

/**
 * RAM for buffered video on a computer with this much memory: an eighth of it, at most 4 GB.
 * Windows and Firefox need most of the rest; the video beyond it goes to disk.
 * @param {number} gigabytes
 * @return {number} Bytes.
 */
export function ramBudgetFor(gigabytes) {
  return Math.min(gigabytes, 32) / 8 * GB;
}

/**
 * Whether this much RAM for buffered video can freeze the computer: no limit, more than 4 GB, or
 * more than a quarter of the memory the user gave.
 * @param {number} bytes - The limit as saved: -1 for none.
 * @param {number} gigabytes - The computer's memory as the user gave it, 0 when not given.
 * @return {boolean}
 */
export function ramBudgetRisky(bytes, gigabytes) {
  if (bytes < 0) return true;
  const limit = gigabytes > 0 ? Math.min(4, gigabytes / 4) * GB : 4 * GB;
  return bytes > limit;
}

/**
 * What an answer to "how much memory does this computer have" sets: the RAM for buffered video
 * to suit it, and the rest of the video on disk.
 * @param {number} gigabytes - 0: no answer, and the RAM for buffered video stays as it is.
 * @return {{computerMemory: number, ramBudget?: number, bufferToDisk?: boolean}}
 */
export function optionsForComputerMemory(gigabytes) {
  if (!(gigabytes > 0)) return {computerMemory: 0};
  return {computerMemory: gigabytes, ramBudget: ramBudgetFor(gigabytes), bufferToDisk: true};
}

/**
 * A size as offered: "8 GB", the last one "32 GB or more", in the page's language.
 * @param {number} gigabytes - One of ComputerMemorySizes.
 * @return {string}
 */
export function memorySizeLabel(gigabytes) {
  const size = StringUtils.formatSize(gigabytes * GB);
  return gigabytes === ComputerMemorySizes[ComputerMemorySizes.length - 1] ?
    Localize.getMessage('options_general_ramsize_more', [size]) : size;
}
