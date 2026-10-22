// @ts-check

/**
 * The keyboard's next- and previous-track keys, and the same buttons in Windows' media
 * overlay: they go to the next and the previous episode, as the player's own buttons do (his
 * report, 2026-10-22: play and pause worked, next and previous did nothing). Firefox gives a
 * tab's media keys to the Media Session of the frame whose media plays
 * (dom/media/mediacontrol/MediaStatusManager.cpp: the active audible controllable context),
 * which is the player's frame while it plays: FastStream holds the page's own media then.
 * Play and pause stay Firefox's own, which already pause and play the video.
 */
export class MediaKeys {
  /**
   * @param {import('../FastStreamClient.mjs').FastStreamClient} client - The player.
   * @param {?MediaSession} [session] - navigator.mediaSession; none in a browser without it.
   */
  constructor(client, session = typeof navigator !== 'undefined' ? navigator.mediaSession : null) {
    this.client = client;
    this.session = session || null;
    /** What the keys do now: an action not offered is greyed out in the overlay. */
    this.offered = {nexttrack: false, previoustrack: false};
  }

  /**
   * Offers each key while there is an episode for it, and takes it back when there is none.
   */
  update() {
    this.offer('nexttrack', this.client.hasNextVideo(), () => this.client.nextVideo());
    this.offer('previoustrack', this.client.hasPreviousVideo(), () => this.client.previousVideo());
  }

  /**
   * @param {'nexttrack'|'previoustrack'} action
   * @param {boolean} available - Whether there is an episode for it.
   * @param {() => void} go - Goes there.
   */
  offer(action, available, go) {
    if (!this.session || this.offered[action] === available) return;
    try {
      this.session.setActionHandler(action, available ? go : null);
      this.offered[action] = available;
    } catch (e) {
      // A Firefox without this action: the key stays as it was.
    }
  }
}
