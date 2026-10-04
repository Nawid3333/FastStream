// @ts-check
/**
 * Pure helpers for the subtitle resync tool (SubtitleSyncer). No DOM, so the
 * unit tests can import them.
 */
export class SubtitleSyncUtils {
  /**
   * The cues that overlap [minTime, maxTime], i.e. the ones the resync
   * timeline has to draw for that stretch.
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
   * A shift in seconds the way the tool shows it: always signed, two
   * decimals ("+1.40", "-0.20", "+0.00").
   * @param {number} seconds
   * @return {string}
   */
  static formatShift(seconds) {
    const rounded = Math.round(seconds * 100) / 100;
    // -0.001 rounds to -0: show it as +0.00, not -0.00
    const value = rounded === 0 ? 0 : rounded;
    return (value >= 0 ? '+' : '') + value.toFixed(2);
  }
}
