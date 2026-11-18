// @ts-check
/**
 * Puts a 33-bit MPEG-TS timestamp on the same side of a rollover as a reference (hls.js's PTSNormalize).
 * @param {number} value
 * @param {number|null} reference - Null leaves value alone.
 * @return {number}
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
