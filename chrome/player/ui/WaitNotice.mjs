// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {StatusTypes} from './StatusManager.mjs';

/**
 * Which of the user's limits keeps a waiting video from video downloaded ahead, if one does. Playback's own requests
 * still go (the players' buffers of 10-30 s), so the limit is why a short slowdown of the line stops the video.
 * @param {{maxSpeed?: number, bufferAhead?: number, ramBudget?: number}} options - maxSpeed in bytes/s; 0 is a limit of 0.
 * @param {{rate: number, ramOnly: boolean, aheadKept: number, live: boolean}} video - rate: the video's bytes/s, 0
 *   when not known; ramOnly: nothing is kept on disk (a private window, "Keep video on disk" off, no disk);
 *   aheadKept: the seconds the client keeps ahead now.
 * @return {?{key: string, args?: Array<string>}} The message's key and its placeholders.
 */
export function waitCause(options, {rate, ramOnly, aheadKept, live}) {
  // A live stream waits for the next segment to exist.
  if (live) return null;
  if (options.maxSpeed === 0) return {key: 'player_wait_speed_zero'};
  if (typeof options.maxSpeed === 'number' && options.maxSpeed > 0 && rate > options.maxSpeed) {
    const mbit = (/** @type {number} */ bytes) => (Math.round(bytes * 8 / 1e5) / 10).toLocaleString();
    return {key: 'player_wait_speed_low', args: [mbit(options.maxSpeed), mbit(rate)]};
  }
  if (options.bufferAhead === 0 && aheadKept === 0) return {key: 'player_wait_ahead_zero'};
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
  }

  /**
   * Called on the interface's tick.
   * @param {number} [now]
   */
  check(now = Date.now()) {
    const client = this.client;
    if (!client.state.buffering || !client.state.playing) {
      this.since = null;
      return;
    }
    if (this.since === null) this.since = now;
    if (now - this.since < WaitNotice.AfterMs || this.toldFor === client.source) return;
    const ramOnly = EnvUtils.isIncognito() || client.options.bufferToDisk === false ||
      client.downloadManager?.blobStore?.diskGone === true;
    const cause = waitCause(client.options, {
      rate: client.videoRate(), ramOnly, aheadKept: client.state.bufferAhead, live: client.isLive(),
    });
    if (!cause) return;
    this.toldFor = client.source;
    client.interfaceController.setStatusMessage(StatusTypes.INFO, Localize.getMessage(cause.key, cause.args), 'info', 12000);
  }
}
