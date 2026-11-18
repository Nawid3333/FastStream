// @ts-check
// No DOM, so the unit tests can import it.
export class SubtitleSyncUtils {
  /**
   * @param {Array<{startTime: number, endTime: number}>} cues
   * @param {number} minTime
   * @param {number} maxTime
   * @return {Array<{startTime: number, endTime: number}>}
   */
  static cuesInRange(cues, minTime, maxTime) {
    return cues.filter((cue) => {
      return cue.startTime <= maxTime && cue.endTime >= minTime;
    });
  }

  /**
   * Always signed, two decimals ("+1.40", "-0.20", "+0.00").
   * @param {number} seconds
   * @return {string}
   */
  static formatShift(seconds) {
    const rounded = Math.round(seconds * 100) / 100;
    const value = rounded === 0 ? 0 : rounded;
    return (value >= 0 ? '+' : '') + value.toFixed(2);
  }
}
