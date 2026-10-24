// @ts-check

/** Seconds a seek button of the overlay moves when it names no offset itself. */
const SEEK_OFFSET = 10;
/** The overlay's picture of the video: a frame this wide, the height as the video's. */
const ARTWORK_WIDTH = 320;
/** How often the time line is set again while the video plays: Firefox runs it on in between. */
const POSITION_EVERY_MS = 5000;

/**
 * What the tab's title tells: MediaTitle.guessMediaInfo, as the background sends it.
 * @typedef {{name?: string, year?: ?number, season?: ?number, episode?: ?number}} MediaInfo
 */

/**
 * The keyboard's media keys and Windows' media overlay (and other systems' like it): the
 * video's name and a frame of it, its time line, and keys that go back, forward, to a time,
 * and to the next and the previous episode, as the player's own buttons do (his report,
 * 2026-10-22: play and pause worked, next and previous did nothing; 2026-10-24: the overlay
 * showed only "FastStream"). Firefox gives a tab's media keys and overlay to the Media Session
 * of the frame whose media plays (dom/media/mediacontrol/MediaStatusManager.cpp: the active
 * audible controllable context), which is the player's frame while it plays: FastStream holds
 * the page's own media then. Play and pause stay Firefox's own, which already pause and play
 * the video.
 */
export class MediaKeys {
  /**
   * @param {import('../FastStreamClient.mjs').FastStreamClient} client - The player.
   * @param {?MediaSession} [session] - navigator.mediaSession; none in a browser without it.
   * @param {?typeof MediaMetadata} [Metadata] - The MediaMetadata class.
   */
  constructor(client, session = typeof navigator !== 'undefined' ? navigator.mediaSession : null,
      Metadata = typeof MediaMetadata !== 'undefined' ? MediaMetadata : null) {
    this.client = client;
    this.session = session || null;
    this.Metadata = Metadata || null;
    /** What the keys do now: an action not offered is greyed out in the overlay. */
    this.offered = {nexttrack: false, previoustrack: false};
    this.seekOffered = false;
    /** @type {?MediaInfo} */
    this.info = null;
    /** @type {?{url: string, width: number, height: number}} The frame shown, an object URL. */
    this.artwork = null;
    this.positionSetAt = 0;
  }

  /**
   * Offers each episode key while there is an episode for it, and takes it back when there is
   * none.
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

  /**
   * Back and forward by the overlay's own step (or SEEK_OFFSET), and to the time its time
   * line was dragged to: offered once, when the first video plays (the client's PLAYING).
   */
  offerSeeking() {
    if (!this.session || this.seekOffered) return;
    this.seekOffered = true;
    /** @type {Array<[MediaSessionAction, MediaSessionActionHandler]>} */
    const handlers = [
      ['seekbackward', (details) => this.seekTo(this.client.currentTime - (details?.seekOffset || SEEK_OFFSET))],
      ['seekforward', (details) => this.seekTo(this.client.currentTime + (details?.seekOffset || SEEK_OFFSET))],
      ['seekto', (details) => {
        if (Number.isFinite(details?.seekTime)) this.seekTo(/** @type {number} */ (details.seekTime));
      }],
    ];
    for (const [action, handler] of handlers) {
      try {
        this.session.setActionHandler(action, handler);
      } catch (e) {
        // A Firefox without this action: that key stays as it was.
      }
    }
  }

  /**
   * Seeks as the player's arrow keys do: the client keeps the time inside the video.
   * @param {number} time
   */
  seekTo(time) {
    this.client.setSeekSave(false);
    this.client.currentTime = time;
    this.client.setSeekSave(true);
    this.updatePosition(true);
  }

  /**
   * The name the overlay shows, from the tab's title; null (no name known) leaves Firefox's
   * own, the tab's title.
   * @param {?MediaInfo} info
   */
  setInfo(info) {
    this.info = info && info.name ? info : null;
    this.applyMetadata();
  }

  /**
   * A frame of the playing video as the overlay's picture. A video that taints the canvas
   * (another origin's, without CORS) gives none, and the overlay stays without one.
   * @param {HTMLVideoElement} video
   * @param {(video: HTMLVideoElement, width: number, height: number) => Promise<?Blob>} [capture]
   */
  async setArtwork(video, capture = captureFrame) {
    if (!this.session || !this.Metadata || !video.videoWidth || !video.videoHeight) return;
    const width = ARTWORK_WIDTH;
    const height = Math.max(1, Math.round(ARTWORK_WIDTH * video.videoHeight / video.videoWidth));
    let blob = null;
    try {
      blob = await capture(video, width, height);
    } catch (e) {
      // A tainted canvas, or no frame decoded yet.
    }
    if (!blob) return;
    this.dropArtwork();
    this.artwork = {url: URL.createObjectURL(blob), width, height};
    this.applyMetadata();
  }

  dropArtwork() {
    if (this.artwork) URL.revokeObjectURL(this.artwork.url);
    this.artwork = null;
  }

  applyMetadata() {
    if (!this.session || !this.Metadata) return;
    if (!this.info) {
      this.session.metadata = null;
      return;
    }
    this.session.metadata = new this.Metadata({
      title: /** @type {string} */ (this.info.name),
      artist: describe(this.info),
      artwork: this.artwork ? [{src: this.artwork.url, sizes: `${this.artwork.width}x${this.artwork.height}`, type: 'image/jpeg'}] : [],
    });
  }

  /**
   * The overlay's time line: where the video is, how long it is and how fast it plays. A
   * live stream, or a video whose length is not known, has none.
   * @param {boolean} [now] - Set it now, not only every POSITION_EVERY_MS (a time update).
   */
  updatePosition(now = true) {
    if (!this.session || typeof this.session.setPositionState !== 'function') return;
    const at = Date.now();
    if (!now && at - this.positionSetAt < POSITION_EVERY_MS) return;
    this.positionSetAt = at;
    const duration = this.client.duration;
    try {
      if (!Number.isFinite(duration) || duration <= 0 || this.client.isLive()) {
        this.session.setPositionState();
        return;
      }
      const rate = this.client.playbackRate;
      this.session.setPositionState({
        duration,
        playbackRate: rate > 0 ? rate : 1,
        position: Math.min(Math.max(this.client.currentTime || 0, 0), duration),
      });
    } catch (e) {
      // A state Firefox refuses (a position past a changed length): the old one stays.
    }
  }

  /**
   * A video goes: its picture and time line go with it. The name stays: it is the page's
   * (setInfo, once the player page has loaded), and the page's next source plays under it.
   */
  reset() {
    this.dropArtwork();
    this.applyMetadata();
    if (!this.session) return;
    try {
      this.session.setPositionState?.();
    } catch (e) {
      // nothing set
    }
  }
}

/**
 * What the overlay shows under the name: the season and episode (S01E03), the episode
 * alone (E12), or the year; nothing when the title tells none of them.
 * @param {MediaInfo} info
 * @return {string}
 */
export function describe(info) {
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  if (info.episode != null) return `${info.season != null ? `S${two(info.season)}` : ''}E${two(info.episode)}`;
  if (info.season != null) return `S${two(info.season)}`;
  return info.year != null ? String(info.year) : '';
}

/**
 * The video's current frame as a JPEG.
 * @param {HTMLVideoElement} video
 * @param {number} width
 * @param {number} height
 * @return {Promise<?Blob>}
 */
function captureFrame(video, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
    } catch (e) {
      reject(e);
    }
  });
}
