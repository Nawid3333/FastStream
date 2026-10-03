/**
 * A number from a stored or imported audio profile, made safe to hand to Web Audio: an
 * AudioParam throws on NaN and Infinity, and a profile file can hold anything.
 * @param {*} value - The value as stored.
 * @param {number} fallback - What to use when it is not a finite number.
 * @param {number} [min=-Infinity] - The smallest value allowed.
 * @param {number} [max=Infinity] - The largest value allowed.
 * @return {number}
 */
export function finiteOr(value, fallback, min = -Infinity, max = Infinity) {
  const number = parseFloat(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
