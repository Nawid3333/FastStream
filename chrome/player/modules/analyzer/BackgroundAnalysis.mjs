// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';

// What the two background analyses share: the audio analyzer's (the volume strip) and the
// seek-preview frame extractor's. Each plays the video again in a hidden player of its own,
// from where the main player is, and marks what it has done in ranges.

export const AnalyzerStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  FINISHED: 'finished',
  FAILED: 'failed',
};

/**
 * A stretch of the video analysed, in seconds.
 * @typedef {{start: number, end: number}} DoneRange
 */

/**
 * An analyzer with a background player (AudioAnalyzer, PreviewFrameExtractor).
 * @typedef {Object} BackgroundOwner
 * @property {import('../../FastStreamClient.mjs').FastStreamClient} client
 * @property {string} backgroundAnalyzerStatus - An AnalyzerStatus value.
 * @property {*} backgroundAnalyzerSource - The source analysed, or null.
 * @property {?import('../../FastStreamClient.mjs').Player} backgroundAnalyzerPlayer
 * @property {number} backgroundStarts - Counts the starts, so a stale one knows it is.
 * @property {DoneRange[]} backgroundDoneRanges
 * @property {(source: *, doneRanges: DoneRange[], onDone: (completed: boolean) => void) =>
 *   Promise<import('../../FastStreamClient.mjs').Player>} loadPlayer
 */

/**
 * Whether a range is the whole video, as far as an analysis goes: all of it but the last 5 s,
 * which a player may not reach, or but its last tenth for a video under 50 s. With the 5 s
 * alone, a video of 5 s or less counted as done at its first frame, and its strip stayed
 * empty (glm's review, 2026-11-16).
 * @param {DoneRange} range
 * @param {number} duration - The video's, in seconds; NaN (not known yet) is never covered.
 * @return {boolean}
 */
export function coversVideo(range, duration) {
  return range.end - range.start >= duration - Math.min(5, duration / 10);
}

/**
 * Ends an analysis player at its first fatal error. Before its analysis started (no metadata
 * yet: a link that expired, a manifest that failed), the analysis ends as failed here; once it
 * runs, the player's end ends it so. Without this, an error left the analysis "running" with a
 * dead player, and since a start needs it idle, it was never tried again for that video
 * (glm's review, 2026-11-16; the preview player had this, FastStreamClient's ERROR handler).
 * @param {import('../../FastStreamClient.mjs').Player} player
 * @param {string} label - For the console: [AudioAnalyzer], [FrameExtractor].
 * @param {() => boolean} running - Whether its analysis has started.
 * @param {(completed: boolean) => void} onDone - The analysis's end, before it started.
 */
export function failOnError(player, label, running, onDone) {
  let failed = false;
  player.on(DefaultPlayerEvents.ERROR, (/** @type {unknown} */ error) => {
    if (failed) return;
    failed = true;
    console.warn(`${label} The background player failed`, error);
    if (!running()) onDone(false);
    player.destroy();
  });
}

/**
 * Starts an analyzer's background player for a source, as the only one running: a stop or a
 * newer start while it loads makes it stale, and only the latest start keeps its player.
 * @param {BackgroundOwner} owner
 * @param {string} label - For the console: [AudioAnalyzer], [FrameExtractor].
 * @param {*} newSource - The main player's source.
 */
export async function startBackgroundPlayer(owner, label, newSource) {
  owner.backgroundAnalyzerSource = newSource;
  if (owner.backgroundAnalyzerPlayer) {
    owner.backgroundAnalyzerPlayer.destroy();
    owner.backgroundAnalyzerPlayer = null;
  }

  console.log(`${label} Starting background analyzer`);

  // A stop and a new start while this one loads (the tool closed and opened again, or a new
  // video) make this start stale: two starts for the same source used to both keep their
  // players, and the first ran on - seeking, downloading, drawing - for good (review of
  // 2026-10-14).
  const start = ++owner.backgroundStarts;
  /** @type {import('../../FastStreamClient.mjs').Player|undefined} */
  let player;
  // Set by an end that came before the load returned the player (an error, or the frame
  // extractor's video with no size). The check for "the running player" compared two unset
  // values and passed, and the load's return then kept the dead player as the running one,
  // which blocked every later start (glm's second look, 2026-10-13).
  /** @type {boolean|null} */
  let endedWhileLoading = null;
  try {
    player = await owner.loadPlayer(newSource, owner.backgroundDoneRanges, (completed) => {
      if (player === undefined) {
        endedWhileLoading = completed;
        return;
      }
      // Only the running player's end counts: a stale player, destroyed below, cleared the
      // running one's place, and nothing could stop that one any more.
      if (owner.backgroundAnalyzerPlayer !== player) {
        return;
      }
      console.log(`${label} Background analyzer finished`, completed ? 'successfully' : 'with errors');
      owner.backgroundAnalyzerStatus = completed ? AnalyzerStatus.FINISHED : AnalyzerStatus.FAILED;
      owner.client.interfaceController.updateMarkers();
      owner.backgroundAnalyzerPlayer = null;
    });
  } catch (e) {
    // Thrown on, it was an unhandled rejection. The source is forgotten, so the next start
    // (the next play, the tool opened again) tries again: one dropped request left the video
    // without its strip for good (glm's second look, 2026-10-13).
    console.warn(`${label} The background analyzer did not start`, e);
    if (start === owner.backgroundStarts && owner.backgroundAnalyzerSource === newSource) {
      owner.backgroundAnalyzerSource = null;
    }
    return;
  }

  if (start !== owner.backgroundStarts || newSource !== owner.backgroundAnalyzerSource) {
    player.destroy();
    return;
  }

  if (endedWhileLoading !== null) {
    owner.backgroundAnalyzerStatus = endedWhileLoading ? AnalyzerStatus.FINISHED : AnalyzerStatus.FAILED;
    owner.client.interfaceController.updateMarkers();
    return;
  }

  owner.backgroundAnalyzerStatus = AnalyzerStatus.RUNNING;
  owner.backgroundAnalyzerPlayer = player;
}
