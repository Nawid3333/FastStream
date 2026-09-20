/**
 * Puts a 33-bit MPEG-TS timestamp on the same side of a rollover as a reference.
 *
 * Transport stream PTS and DTS values are 33 bits wide and wrap at 2^33 (about 26.5 hours at
 * 90 kHz). A stream that crosses the wrap has samples whose timestamps look 2^33 apart, and
 * anything that takes a minimum or a difference has to move one of them across first. This
 * is hls.js's own PTSNormalize, which its bundle keeps to itself.
 *
 * @param {number} value - The timestamp to bring across.
 * @param {number|null} reference - The timestamp to stay close to; null leaves value alone.
 * @return {number} value, shifted by whole wraps until it is within half a wrap of reference.
 */
export function normalizePts(value, reference) {
  if (reference === null) {
    return value;
  }

  const offset = reference < value ? -8589934592 : 8589934592;
  while (Math.abs(value - reference) > 4294967296) {
    value += offset;
  }
  return value;
}
