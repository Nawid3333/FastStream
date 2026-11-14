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
//
// A page going into the back-forward cache leaves the channel, and joins again when Back
// brings it out. Firefox takes a page out of that cache when a message reaches one of its
// open BroadcastChannels (BroadcastChannel::MessageReceived: CheckCurrentGlobalCorrectness
// fails for a window in the cache, and it calls RemoveDocFromBFCache), and the other players
// announce every second: on the Windows runner, Back loaded such a page again in 4 of 4
// attempts (PR #366). pagehide comes before the page is marked as cached, in the same task
// (BrowsingContext::DeactivateDocuments), so the goodbye does not take it out. close() lets go
// of the channel a task later (CloseRunnable): a message already queued then can still take
// the page out - a few milliseconds, not the whole time in the cache.

import {mustWait} from './PlayerTurns.mjs';

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
// A live stream has only what its server has made: short means nearly dry, not under 10 s
// (a stream that keeps 6 s ahead by design was "short" for as long as it was watched, and
// every player in a background tab stood still all that time).
export const LIVE_SHORT_S = 3;
// Less than this left to download before the video's end: nothing more to wait for. (A clip
// shorter than SHORT_S that loops was short for good.)
export const END_ROOM_S = 0.5;
// A player whose downloads brought no byte for this long does not hold the others: neither
// as short of video (a watched video on a dead server stopped every other player for as long
// as its tab was in front) nor as the one whose turn it is (PlayerTurns).
export const STUCK_MS = 15000;
// The speed a player tells the others is what it received over this long.
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
 * @property {boolean} [wants] - PlayerTurns: it has video to download, and its downloads get somewhere.
 * @property {number} [speed] - Bytes a second it downloads at.
 * @property {number} [rate] - Bytes a second its video plays at.
 * @property {number} [seen] - When the user last saw it.
 * @property {number} [born] - When it started.
 * @property {boolean} [shared] - Its downloads share one line (false: a server limiting each connection).
 * @property {string} [host] - The host it downloads from.
 * @property {boolean} [bye]
 */

/**
 * @typedef {Object} OwnState
 * @property {boolean} playing - The user plays it.
 * @property {number} ahead - Seconds of video ahead of the playhead (BufferAhead).
 * @property {number} ramBytes - What it holds in RAM.
 * @property {boolean} [live] - A live stream.
 * @property {boolean} [buffering] - Its video stands still for want of data.
 * @property {number} [room] - Seconds of video there are beyond what it has ahead (0 at the
 *   end; unknown: left out).
 * @property {boolean} [wants] - It has video to download ahead and may (not paused, not full).
 * @property {number} [received] - Bytes its downloads have received, counted up as they come.
 * @property {number} [rate] - Bytes a second its video plays at; 0 when unknown.
 * @property {boolean} [shared] - Its downloads share one line (false: a server that limits
 *   each connection).
 * @property {string} [host] - The host it downloads from.
 * @property {boolean} [saving] - The user saves this video: never made to wait.
 */

export class PlayerPeers {
  /**
   * @param {Object} options
   * @param {() => OwnState} options.state - This player's state, asked when needed.
   * @param {() => boolean} [options.visible] - Whether the user can see it (the tab,
   *   or picture-in-picture).
   * @param {(name: string) => BroadcastChannel} [options.channel] - Makes the channel (tests).
   * @param {() => number} [options.now]
   * @param {() => void} [options.onChange] - Called when a peer's message changed who needs
   *   the network: a hidden page's own timers run late (up to 15 s), its messages do not,
   *   so it steps aside when the message comes, not on its next tick.
   * @param {{addEventListener: Function, removeEventListener: Function}} [options.page] - Where
   *   pagehide and pageshow come from (the window; tests give their own).
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
    // When the user last saw this player (0: never), for the order of turns.
    this.seenAt = 0;
    // What shouldYield last said.
    this.yieldingNow = false;
    // Waiting for its turn to download ahead (shouldWait): kept, as joining and leaving have
    // different thresholds.
    this.waiting = false;
    // What it had received, and when, over the last SPEED_WINDOW_MS (measure).
    /** @type {Array<{at: number, received: number}>} */
    this.samples = [];
    // When a byte last came, or when it last had no reason to expect one (not short of video
    // and nothing to download, or waiting, or stepping aside): what STUCK_MS counts from.
    this.progressAt = this.now();
    this.lastReceived = 0;
    this.lastSpeed = 0;
  }

  /**
   * Starts listening. Without BroadcastChannel it stays alone: never yields.
   * @return {boolean} Whether it could.
   */
  start() {
    if (!this.listening) {
      this.listening = true;
      this.page?.addEventListener('pagehide', this.onPageHide);
      this.page?.addEventListener('pageshow', this.onPageShow);
    }
    return this.join();
  }

  /**
   * Opens the channel, unless it is open.
   * @return {boolean} Whether it is open.
   */
  join() {
    if (this.channel) return true;
    try {
      this.channel = this.makeChannel(CHANNEL);
    } catch (e) {
      this.channel = null;
      return false;
    }
    this.channel.onmessage = (event) => this.receive(event.data);
    // Not announced here: the player may not be built yet. Its first tick announces it, also
    // after the page came back from the back-forward cache.
    this.lastAnnounced = null;
    return true;
  }

  /**
   * Says goodbye, so peers stop counting this one at once, and closes the channel: for now
   * (a page going into the back-forward cache) or for good (stop).
   */
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

  /**
   * Notes what the player has received by now: its speed over the last SPEED_WINDOW_MS, and
   * when a byte last came.
   * @param {OwnState} state
   * @param {boolean} expecting - Whether its downloads should be bringing bytes now. When they
   *   need not (nothing to get, or held back), no byte is no sign of a dead server.
   * @return {number} Bytes a second.
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

  /**
   * Whether its downloads have brought nothing for STUCK_MS though they should have.
   * @return {boolean}
   */
  isStuck() {
    return this.now() - this.progressAt > STUCK_MS;
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
    return this.needy(this.readState());
  }

  /**
   * Whether more video could come for a watched player: it plays (or was just seeked), and
   * what it has ahead is not all there is.
   * @param {OwnState} state
   * @return {boolean}
   */
  couldUseMore(state) {
    if (!this.visible()) return false;
    if (!state.playing && this.now() - this.seekedAt >= SEEK_WINDOW_MS) return false;
    // All there is to have is ahead already (the end of the video, a clip shorter than
    // SHORT_S): the others stepping aside would bring it nothing.
    return !(state.room !== undefined && !(state.room > END_ROOM_S));
  }

  /**
   * @param {OwnState} state
   * @return {boolean} Whether the others should step aside for this player (isNeedy).
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
   * This player's part of a message: how it is doing, and what turns go by (PlayerTurns).
   * @param {OwnState} state
   * @return {{visible: boolean, playing: boolean, needy: boolean, ramBytes: number, wants: boolean,
   *   speed: number, rate: number, seen: number, born: number, shared: boolean, host: string}}
   */
  describe(state) {
    const visible = this.visible();
    if (visible) this.seenAt = this.now();
    const wantsAhead = !!state.wants;
    // Bytes are expected while it has video to download, or is watched and short of it, and
    // nothing holds its downloads back: only then does no byte count towards "stuck".
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

  /**
   * Tells the others how this player is doing: at once when that changed, else at most every
   * ANNOUNCE_REPEAT_MS (a scrub seeks many times a second).
   */
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
    // Whether this player waits for its turn, as it stood: a peer's word can change it
    // (PlayerTurns), and a hidden page's own next tick may be 15 s away.
    const waited = this.waiting;
    if (message.bye) {
      this.peers.delete(message.id);
      if (before?.needy || this.shouldWait() !== waited) this.onChange();
      return;
    }
    // Stamped on arrival: another page's clock is the same one, but its message may sit in
    // a throttled queue; when it arrives is what says it is alive.
    this.peers.set(message.id, {...message, at: this.now()});
    if (message.needy) this.lastNeedyPeerAt = this.now();
    if (!!before?.needy !== !!message.needy || this.shouldWait() !== waited) this.onChange();
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
    this.yieldingNow = this.decideYield();
    return this.yieldingNow;
  }

  /** @return {boolean} shouldYield's answer. */
  decideYield() {
    if (!this.channel || this.visible()) return false;
    const state = this.readState();
    // Playing unseen (music in a background tab): it still needs its own next seconds.
    if (state.playing && state.ahead < HIDDEN_PLAYING_KEEP_S) return false;
    const needyNow = this.livePeers().some((peer) => peer.needy);
    return needyNow || this.now() - this.lastNeedyPeerAt < YIELD_TAIL_MS;
  }

  /**
   * Whether this player waits for its turn to download ahead (PlayerTurns.mustWait): it is not
   * seen, and a player that goes before it still downloads without leaving room. Soft, unlike
   * shouldYield: what runs finishes, and its own playback's requests go.
   * @return {boolean}
   */
  shouldWait() {
    this.waiting = this.decideWait();
    return this.waiting;
  }

  /**
   * Whether a player that waits for its turn holds what its own playback asks for too: it is
   * paused and has its next SHORT_S seconds, so it plays at once when the user comes back to
   * it (visible, it never waits). What playback asks for beyond that is buffering ahead by
   * another name: an MP4 player's own loading reads 30 MB ahead of the playhead.
   * @return {boolean}
   */
  waitHoldsPlayback() {
    if (!this.waiting) return false;
    const state = this.readState();
    return !state.playing && state.ahead >= SHORT_S;
  }

  /** @return {boolean} shouldWait's answer. */
  decideWait() {
    if (!this.channel || this.visible()) return false;
    const state = this.readState();
    // The user asked for this video's file: a save is never held back.
    if (state.saving) return false;
    // Playing unseen: its own next seconds, as in shouldYield.
    if (state.playing && state.ahead < HIDDEN_PLAYING_KEEP_S) return false;
    const own = {id: this.id, visible: false, playing: !!state.playing, seen: this.seenAt, born: this.born,
      host: typeof state.host === 'string' ? state.host : ''};
    return mustWait(own, this.livePeers(), this.waiting);
  }
}
