// @ts-check

// The other FastStream players open in this browser, and which of them needs the network.
//
// Each player page downloads on its own, up to six connections, and Firefox gives all tabs
// together six connections to one host. A player that the user watches had to share them with
// players in background tabs that load ahead: measured on a local server at 4x the stream's
// rate, a seek to 5:00 played after 4.5-9 s alone and after 17-21 s with three background
// players loading. So players tell each other how they are doing over a BroadcastChannel, and
// one that nobody watches steps aside (shouldYield) while one that is watched is short of
// video. Nobody short: everyone downloads at full speed.
//
// BroadcastChannel is per origin and kept apart between private and normal windows, as are
// Firefox's connection pools: the players that compete for connections hear each other.

const CHANNEL = 'faststream-players-v1';
const VERSION = 1;
// A hidden page's timers can run late (Firefox clamps them to 1 s, and after 30 s hidden its
// budget throttling can delay them up to 15 s): a peer is forgotten only after this long.
export const PEER_TIMEOUT_MS = 20000;
// Short of video: less than this many seconds downloaded ahead of the playhead...
export const SHORT_S = 10;
// ...or less than this just after a seek, which starts from nothing.
export const SHORT_AFTER_SEEK_S = 20;
export const SEEK_WINDOW_MS = 3000;
// A hidden player that plays (music in a background tab) steps aside only with this much.
export const HIDDEN_PLAYING_KEEP_S = 30;
// It goes on stepping aside this long after the last peer that was short, so that peers
// taking turns do not make it start and stop every second.
export const YIELD_TAIL_MS = 3000;
// The same state again goes out no sooner than this.
export const ANNOUNCE_REPEAT_MS = 250;

/**
 * @typedef {Object} PeerState
 * @property {number} v
 * @property {string} id
 * @property {number} at
 * @property {boolean} visible
 * @property {boolean} playing
 * @property {boolean} needy
 * @property {number} ramBytes
 * @property {boolean} [bye]
 */

/**
 * @typedef {Object} OwnState
 * @property {boolean} playing - The user plays it.
 * @property {number} ahead - Seconds of video ahead of the playhead (BufferAhead).
 * @property {number} ramBytes - What it holds in RAM.
 */

export class PlayerPeers {
  /**
   * @param {Object} options
   * @param {() => OwnState} options.state - This player's state, asked when needed.
   * @param {() => boolean} [options.visible] - Whether the user can see it (the tab,
   *   or picture-in-picture).
   * @param {(name: string) => Object} [options.channel] - Makes the channel (tests).
   * @param {() => number} [options.now]
   * @param {() => void} [options.onChange] - Called when a peer's message changed who needs
   *   the network: a hidden page's own timers run late (up to 15 s), its messages do not,
   *   so it steps aside when the message comes, not on its next tick.
   */
  constructor({state, visible, channel, now, onChange}) {
    this.onChange = onChange || (() => {});
    this.state = state;
    this.visible = visible || (() => typeof document !== 'undefined' &&
      (document.visibilityState === 'visible' || !!document.pictureInPictureElement));
    this.makeChannel = channel || ((name) => new BroadcastChannel(name));
    this.now = now || (() => Date.now());
    this.id = Math.random().toString(36).slice(2) + this.now().toString(36);
    /** @type {Map<string, PeerState>} */
    this.peers = new Map();
    this.channel = null;
    this.seekedAt = -Infinity;
    this.lastNeedyPeerAt = -Infinity;
  }

  /**
   * Starts listening. Without BroadcastChannel it stays alone: never yields.
   * @return {boolean} Whether it could.
   */
  start() {
    if (this.channel) return true;
    try {
      this.channel = this.makeChannel(CHANNEL);
    } catch (e) {
      this.channel = null;
      return false;
    }
    this.channel.onmessage = (event) => this.receive(event.data);
    // Not announced here: the player may not be built yet. Its first tick announces it.
    return true;
  }

  /** Says goodbye, so peers stop counting this one at once, and stops listening. */
  stop() {
    if (this.channel) {
      this.post({bye: true});
      try {
        this.channel?.close();
      } catch (e) {
        // Already closed with its page.
      }
    }
    this.channel = null;
    this.peers.clear();
    this.lastNeedyPeerAt = -Infinity;
  }

  /**
   * This player's state, or a quiet one when it cannot be read (a player being built or torn
   * down): a throw here switched the channel off for good, from inside start().
   * @return {OwnState}
   */
  readState() {
    try {
      return this.state();
    } catch (e) {
      return {playing: false, ahead: Infinity, ramBytes: 0};
    }
  }

  /** A seek: the player starts again from nothing there. */
  noteSeek() {
    this.seekedAt = this.now();
  }

  /**
   * Whether this player is watched and short of video: what makes the others step aside.
   * @return {boolean}
   */
  isNeedy() {
    const state = this.readState();
    if (!this.visible()) return false;
    const justSeeked = this.now() - this.seekedAt < SEEK_WINDOW_MS;
    if (!state.playing && !justSeeked) return false;
    return state.ahead < (justSeeked ? SHORT_AFTER_SEEK_S : SHORT_S);
  }

  /**
   * Tells the others how this player is doing: at once when that changed, else at most every
   * ANNOUNCE_REPEAT_MS (a scrub seeks many times a second).
   */
  announce() {
    const state = this.readState();
    const fields = {visible: this.visible(), playing: !!state.playing, needy: this.isNeedy(),
      ramBytes: Math.max(0, state.ramBytes || 0)};
    const last = this.lastAnnounced;
    const now = this.now();
    if (last && now - last.at < ANNOUNCE_REPEAT_MS && last.visible === fields.visible &&
        last.playing === fields.playing && last.needy === fields.needy) {
      return;
    }
    this.lastAnnounced = {...fields, at: now};
    this.post(fields);
  }

  /**
   * @param {Object} fields
   */
  post(fields) {
    if (!this.channel) return;
    try {
      this.channel.postMessage({v: VERSION, id: this.id, at: this.now(), ...fields});
    } catch (e) {
      // A closed channel: alone from now on.
      this.channel = null;
    }
  }

  /**
   * @param {*} message
   */
  receive(message) {
    if (!message || message.v !== VERSION || typeof message.id !== 'string' || message.id === this.id) return;
    const before = this.peers.get(message.id);
    if (message.bye) {
      this.peers.delete(message.id);
      if (before?.needy) this.onChange();
      return;
    }
    // Stamped on arrival: another page's clock is the same one, but its message may sit in
    // a throttled queue; when it arrives is what says it is alive.
    this.peers.set(message.id, {...message, at: this.now()});
    if (message.needy) this.lastNeedyPeerAt = this.now();
    if (!!before?.needy !== !!message.needy) this.onChange();
  }

  /**
   * The peers heard from lately.
   * @return {PeerState[]}
   */
  livePeers() {
    const now = this.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.at > PEER_TIMEOUT_MS) this.peers.delete(id);
    }
    return [...this.peers.values()];
  }

  /**
   * Whether this player should leave the network to a watched one that is short of video:
   * it is not seen itself, and some peer is needy (or was within YIELD_TAIL_MS).
   * @return {boolean}
   */
  shouldYield() {
    if (!this.channel || this.visible()) return false;
    const state = this.readState();
    // Playing unseen (music in a background tab): it still needs its own next seconds.
    if (state.playing && state.ahead < HIDDEN_PLAYING_KEEP_S) return false;
    const needyNow = this.livePeers().some((peer) => peer.needy);
    return needyNow || this.now() - this.lastNeedyPeerAt < YIELD_TAIL_MS;
  }

  /**
   * What the other players hold in RAM, together.
   * @return {number}
   */
  peersRamBytes() {
    return this.livePeers().reduce((sum, peer) => sum + (peer.ramBytes || 0), 0);
  }
}
