// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {StatusTypes} from './StatusManager.mjs';

/** Downloads this close to the speed limit are held at it: they stop above it and start again below it. */
export const LimitReachedShare = 0.8;

/**
 * Which of the user's limits keeps a waiting video from video downloaded ahead, if one does. Playback's own requests
 * still go (the players' buffers of 10-30 s), so the limit is why a short slowdown of the line stops the video.
 * @param {{maxSpeed?: number, ramBudget?: number}} options - maxSpeed in bytes/s, -1 for none.
 * @param {{rate: number, speed: number, ramOnly: boolean, live: boolean}} video - rate: the video's bytes/s, 0 when
 *   not known; speed: the downloads' bytes/s now; ramOnly: nothing is kept on disk (a private window, "RAM only", no
 *   disk).
 * @return {?{key: string, args?: Array<string>}} The message's key and its placeholders.
 */
export function waitCause(options, {rate, speed, ramOnly, live}) {
  // A live stream waits for the next segment to exist.
  if (live) return null;
  // The limit holds downloads back only while they reach it: a line slower than the limit is the line's doing.
  if (typeof options.maxSpeed === 'number' && options.maxSpeed > 0 && rate > options.maxSpeed &&
    speed >= options.maxSpeed * LimitReachedShare) {
    const mbit = (/** @type {number} */ bytes) => (Math.round(bytes * 8 / 1e5) / 10).toLocaleString();
    return {key: 'player_wait_speed_low', args: [mbit(options.maxSpeed), mbit(rate)]};
  }
  if (options.ramBudget === 0 && ramOnly) return {key: 'player_wait_ram_zero'};
  return null;
}

/** Once per video, after it stopped to load for WaitNotice.AfterMs while playing: the limit behind it (waitCause). */
export class WaitNotice {
  static AfterMs = 2000;

  /** @param {import('../FastStreamClient.mjs').FastStreamClient} client */
  constructor(client) {
    this.client = client;
    /** @type {?number} */
    this.since = null;
    /** @type {*} The source it was told for. */
    this.toldFor = null;
    this.shown = false;
  }

  /**
   * Called on the interface's tick.
   * @param {number} [now]
   */
  check(now = Date.now()) {
    const client = this.client;
    // Paused downloads (the pause key) have their own message, which names the key that resumes them: under this
    // one, so this one goes.
    if (client.downloadManager?.paused && this.shown) {
      this.shown = false;
      client.interfaceController.setStatusMessage(StatusTypes.WAIT, null, 'info');
    }
    if (!client.state.buffering || !client.state.playing || client.downloadManager?.paused) {
      this.since = null;
      return;
    }
    if (this.since === null) this.since = now;
    if (now - this.since < WaitNotice.AfterMs || this.toldFor === client.source) return;
    const ramOnly = EnvUtils.isIncognito() || client.options.bufferToDisk === false ||
      client.downloadManager?.blobStore?.diskGone === true;
    const cause = waitCause(client.options, {
      rate: client.videoRate(), speed: client.downloadManager?.getSpeed() ?? 0, ramOnly, live: client.isLive(),
    });
    if (!cause) return;
    this.toldFor = client.source;
    this.shown = true;
    client.interfaceController.setStatusMessage(StatusTypes.WAIT, Localize.getMessage(cause.key, cause.args), 'info', 12000);
  }
}
