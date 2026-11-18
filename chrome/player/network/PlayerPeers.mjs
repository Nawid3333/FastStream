// @ts-check

// The other FastStream players open in this browser, and which of them needs the network.

import {mustWait} from './PlayerTurns.mjs';

const CHANNEL = 'faststream-players-v1';
const VERSION = 1;
// A hidden page's timers run up to 15 s late: a peer is forgotten only after this long.
export const PEER_TIMEOUT_MS = 20000;
// Short of video: less than this many seconds downloaded ahead of the playhead...
export const SHORT_S = 10;
// ...or less than this just after a seek, which starts from nothing.
export const SHORT_AFTER_SEEK_S = 20;
export const SEEK_WINDOW_MS = 3000;
// A hidden player that plays (music in a background tab) steps aside only with this much.
export const HIDDEN_PLAYING_KEEP_S = 30;
// Stepping aside lasts this long past the last short peer, so turns do not flap.
export const YIELD_TAIL_MS = 3000;
export const ANNOUNCE_REPEAT_MS = 250;
// A live stream has only what its server made: short means nearly dry.
export const LIVE_SHORT_S = 3;
// Less than this left to download: nothing more to wait for (a short clip that loops).
export const END_ROOM_S = 0.5;
// No byte for this long: it holds the others neither as short nor as the one whose turn it is.
export const STUCK_MS = 15000;
export const SPEED_WINDOW_MS = 5000;

/**
 * @typedef {Object} PeerState
 * @property {number} v
 * @property {string} id
 * @property {number} at
 * @property {boolean} visible
 * @property {boolean} playing
 * @property {boolean} needy
 * @property {number} ramBytes
 * @property {boolean} [wants]
 * @property {number} [speed]
 * @property {number} [rate]
 * @property {number} [seen]
 * @property {number} [born]
 * @property {boolean} [shared]
 * @property {string} [host]
 * @property {boolean} [bye]
 */

/**
 * @typedef {Object} OwnState
 * @property {boolean} playing
 * @property {number} ahead
 * @property {number} ramBytes
 * @property {boolean} [live]
 * @property {boolean} [buffering]
 * @property {number} [room] - Seconds beyond what it has ahead: 0 at the end, left out when unknown.
 * @property {boolean} [wants]
 * @property {number} [received]
 * @property {number} [rate] - 0 when unknown.
 * @property {boolean} [shared]
 * @property {string} [host]
 * @property {boolean} [saving]
 */

export class PlayerPeers {
  /**
   * @param {Object} options
   * @param {() => OwnState} options.state
   * @param {() => boolean} [options.visible]
   * @param {(name: string) => BroadcastChannel} [options.channel]
   * @param {() => number} [options.now]
   * @param {() => void} [options.onChange]
   * @param {{addEventListener: Function, removeEventListener: Function}} [options.page]
   */
  constructor({state, visible, channel, now, onChange, page}) {
    this.onChange = onChange || (() => {});
    this.page = page || (typeof window !== 'undefined' ? window : null);
    this.listening = false;
    this.onPageHide = () => this.leave();
    this.onPageShow = (/** @type {PageTransitionEvent} */ event) => {
      if (event?.persisted && this.listening) this.join();
    };
    this.state = state;
    this.visible = visible || (() => typeof document !== 'undefined' &&
      (document.visibilityState === 'visible' || !!document.pictureInPictureElement));
    this.makeChannel = channel || ((name) => new BroadcastChannel(name));
    this.now = now || (() => Date.now());
    this.id = Math.random().toString(36).slice(2) + this.now().toString(36);
    /** @type {Map<string, PeerState>} */
    this.peers = new Map();
    /** @type {BroadcastChannel | null} */
    this.channel = null;
    this.seekedAt = -Infinity;
    this.lastNeedyPeerAt = -Infinity;
    this.born = this.now();
    this.seenAt = 0;
    this.yieldingNow = false;
    // Kept: joining and leaving have different thresholds.
    this.waiting = false;
    /** @type {Array<{at: number, received: number}>} */
    this.samples = [];
    // When a byte last came, or it last expected none: what STUCK_MS counts from.
    this.progressAt = this.now();
    this.lastReceived = 0;
    this.lastSpeed = 0;
  }

  /** @return {boolean} */
  start() {
    if (!this.listening) {
      this.listening = true;
      this.page?.addEventListener('pagehide', this.onPageHide);
      this.page?.addEventListener('pageshow', this.onPageShow);
    }
    return this.join();
  }

  /** @return {boolean} */
  join() {
    if (this.channel) return true;
    try {
      this.channel = this.makeChannel(CHANNEL);
    } catch (e) {
      this.channel = null;
      return false;
    }
    this.channel.onmessage = (event) => this.receive(event.data);
    // Not announced here: the player may not be built yet. Its first tick announces it.
    this.lastAnnounced = null;
    return true;
  }

  leave() {
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
    this.waiting = false;
    this.yieldingNow = false;
  }

  /** Leaves the channel for good: a later pageshow does not join it again. */
  stop() {
    this.listening = false;
    this.page?.removeEventListener('pagehide', this.onPageHide);
    this.page?.removeEventListener('pageshow', this.onPageShow);
    this.leave();
  }

  /**
   * A quiet state when it cannot be read: a throw here switched the channel off for good.
   * @return {OwnState}
   */
  readState() {
    try {
      return this.state();
    } catch (e) {
      return {playing: false, ahead: Infinity, ramBytes: 0};
    }
  }

  /**
   * @param {OwnState} state
   * @param {boolean} expecting
   * @return {number}
   */
  measure(state, expecting) {
    const now = this.now();
    const received = Math.max(0, Number(state.received) || 0);
    if (received !== this.lastReceived || !expecting) this.progressAt = now;
    this.lastReceived = received;
    const samples = this.samples;
    if (!samples.length || now > samples[samples.length - 1].at) samples.push({at: now, received});
    while (samples.length > 2 && now - samples[1].at >= SPEED_WINDOW_MS) samples.shift();
    const first = samples[0];
    // A cancelled download takes its bytes back out of the count: never a negative speed.
    if (now > first.at) this.lastSpeed = Math.max(0, (received - first.received) / (now - first.at) * 1000);
    return this.lastSpeed;
  }

  /** @return {boolean} */
  isStuck() {
    return this.now() - this.progressAt > STUCK_MS;
  }

  noteSeek() {
    this.seekedAt = this.now();
  }

  /** @return {boolean} */
  isNeedy() {
    return this.needy(this.readState());
  }

  /**
   * @param {OwnState} state
   * @return {boolean}
   */
  couldUseMore(state) {
    if (!this.visible()) return false;
    if (!state.playing && this.now() - this.seekedAt >= SEEK_WINDOW_MS) return false;
    // All there is is ahead already: the others stepping aside would bring nothing.
    return !(state.room !== undefined && !(state.room > END_ROOM_S));
  }

  /**
   * @param {OwnState} state
   * @return {boolean}
   */
  needy(state) {
    if (!this.couldUseMore(state)) return false;
    // Nothing has come for a long time: a server that does not answer. The others go on.
    if (this.isStuck()) return false;
    if (state.live) return !!state.buffering || state.ahead < LIVE_SHORT_S;
    const justSeeked = this.now() - this.seekedAt < SEEK_WINDOW_MS;
    return state.ahead < (justSeeked ? SHORT_AFTER_SEEK_S : SHORT_S);
  }

  /**
   * @param {OwnState} state
   * @return {{visible: boolean, playing: boolean, needy: boolean, ramBytes: number, wants: boolean,
   *   speed: number, rate: number, seen: number, born: number, shared: boolean, host: string}}
   */
  describe(state) {
    const visible = this.visible();
    if (visible) this.seenAt = this.now();
    const wantsAhead = !!state.wants;
    // Bytes are expected only while it could use them and nothing holds its downloads back.
    const short = this.couldUseMore(state) && state.ahead < SHORT_AFTER_SEEK_S;
    const speed = this.measure(state, (wantsAhead || short) && !this.waiting && !this.yieldingNow);
    return {
      visible, playing: !!state.playing, needy: this.needy(state),
      ramBytes: Math.max(0, state.ramBytes || 0),
      wants: wantsAhead && !this.isStuck(),
      speed: Math.round(speed), rate: Math.max(0, Math.round(Number(state.rate) || 0)),
      seen: this.seenAt, born: this.born,
      shared: state.shared !== false, host: typeof state.host === 'string' ? state.host : '',
    };
  }

  /** At once when it changed, else at most every ANNOUNCE_REPEAT_MS: a scrub seeks many times a second. */
  announce() {
    const fields = this.describe(this.readState());
    const last = this.lastAnnounced;
    const now = this.now();
    if (last && now - last.at < ANNOUNCE_REPEAT_MS && last.visible === fields.visible &&
        last.playing === fields.playing && last.needy === fields.needy && last.wants === fields.wants) {
      return;
    }
    this.lastAnnounced = {...fields, at: now};
    this.post(fields);
  }

  /** @param {Object} fields */
  post(fields) {
    if (!this.channel) return;
    try {
      this.channel.postMessage({v: VERSION, id: this.id, at: this.now(), ...fields});
    } catch (e) {
      this.channel = null;
    }
  }

  /** @param {*} message */
  receive(message) {
    if (!message || message.v !== VERSION || typeof message.id !== 'string' || message.id === this.id) return;
    const before = this.peers.get(message.id);
    // As it stood: a peer's word can change it, and a hidden page's next tick may be 15 s away.
    const waited = this.waiting;
    if (message.bye) {
      this.peers.delete(message.id);
      if (before?.needy || this.shouldWait() !== waited) this.onChange();
      return;
    }
    // Stamped on arrival: a message may sit in a throttled queue.
    this.peers.set(message.id, {...message, at: this.now()});
    if (message.needy) this.lastNeedyPeerAt = this.now();
    if (!!before?.needy !== !!message.needy || this.shouldWait() !== waited) this.onChange();
  }

  /** @return {PeerState[]} */
  livePeers() {
    const now = this.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.at > PEER_TIMEOUT_MS) this.peers.delete(id);
    }
    return [...this.peers.values()];
  }

  /** @return {boolean} */
  shouldYield() {
    this.yieldingNow = this.decideYield();
    return this.yieldingNow;
  }

  /** @return {boolean} */
  decideYield() {
    if (!this.channel || this.visible()) return false;
    const state = this.readState();
    // Playing unseen (music in a background tab): it still needs its own next seconds.
    if (state.playing && state.ahead < HIDDEN_PLAYING_KEEP_S) return false;
    const needyNow = this.livePeers().some((peer) => peer.needy);
    return needyNow || this.now() - this.lastNeedyPeerAt < YIELD_TAIL_MS;
  }

  /**
   * Soft, unlike shouldYield: what runs finishes, and its own playback's requests go.
   * @return {boolean}
   */
  shouldWait() {
    this.waiting = this.decideWait();
    return this.waiting;
  }

  /**
   * Paused with its next SHORT_S seconds, a waiting player holds its playback's requests too.
   * @return {boolean}
   */
  waitHoldsPlayback() {
    if (!this.waiting) return false;
    const state = this.readState();
    return !state.playing && state.ahead >= SHORT_S;
  }

  /** @return {boolean} */
  decideWait() {
    if (!this.channel || this.visible()) return false;
    const state = this.readState();
    if (state.saving) return false;
    if (state.playing && state.ahead < HIDDEN_PLAYING_KEEP_S) return false;
    const own = {id: this.id, visible: false, playing: !!state.playing, seen: this.seenAt, born: this.born,
      host: typeof state.host === 'string' ? state.host : ''};
    return mustWait(own, this.livePeers(), this.waiting);
  }
}
