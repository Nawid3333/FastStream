// @ts-check

// The steps the options page offers for downloading and storage: pickers in plain units, so no value can be typed
// that stops the video (0 seconds ahead, a speed of 0) or freezes the computer (20 GB of RAM). A value saved
// before, or read from a settings file, goes to the nearest step (StorageMode.migrateStorage).

/** "Load ahead": seconds, or the whole video (downloadAll). */
export const AheadSteps = [30, 60, 120, 300, 600, 1200, 1800, 3600];
export const WholeVideo = 'whole';
/** "Largest video loaded whole", bytes; -1: no limit. */
export const MaxSizeSteps = [1e9, 2e9, 5e9, 10e9, 20e9, -1];
/** "Keep video already played", seconds; -1: all of it. */
export const BehindSteps = [20, 60, 300, 1800, -1];
/** "Download speed limit", bytes a second (Mbit/s as speed tests give it); -1: no limit. */
export const SpeedSteps = [-1, ...[2, 5, 10, 20, 50, 100].map((mbit) => mbit * 125000)];
/** "RAM only"'s limit for all players, bytes. */
export const RamOnlySteps = [512e6, 1e9, 2e9, 4e9];

/**
 * The step closest to a value, by ratio: 3000 s is an hour's step, not half an hour's. No limit (or a value with no
 * size) is the no-limit step where there is one, else the largest; 0 is the smallest.
 * @param {number} value
 * @param {number[]} steps
 * @return {number} One of the steps.
 */
export function nearestStep(value, steps) {
  if (steps.includes(value)) return value;
  const sized = steps.filter((step) => step >= 0);
  if (!(value >= 0) || value === Infinity) return steps.includes(-1) ? -1 : Math.max(...sized);
  if (value === 0) return Math.min(...sized);
  const distance = (/** @type {number} */ step) => Math.abs(Math.log(step / value));
  return sized.reduce((best, step) => distance(step) < distance(best) ? step : best);
}
