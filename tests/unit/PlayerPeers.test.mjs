import {describe, expect, it} from 'vitest';

import {aheadOfPlayhead, bufferedAhead, downloadedAhead} from '../../chrome/player/network/BufferAhead.mjs';
import {HIDDEN_PLAYING_KEEP_S, PEER_TIMEOUT_MS, PlayerPeers, YIELD_TAIL_MS} from '../../chrome/player/network/PlayerPeers.mjs';

// Players tell each other how they are doing (PlayerPeers), so that one the user does not
// see leaves the network to one the user watches that is short of video: three background
// players loading made a seek take 17-21 s to play instead of 4-9 s.

const COMPLETE = 3;
const WAITING = 0;
const fragment = (start, end, status = COMPLETE) => ({start, end, status});

describe('BufferAhead', () => {
  it('counts downloaded fragments from the playhead up to the first hole', () => {
    const fragments = [fragment(0, 4), fragment(4, 8), fragment(8, 12, WAITING), fragment(12, 16)];
    expect(downloadedAhead(fragments, 1)).toBe(7);
    expect(downloadedAhead(fragments, 9)).toBe(0);
    // A gap between two fragments is a hole too.
    expect(downloadedAhead([fragment(0, 4), fragment(6, 10)], 0)).toBe(4);
    // Holes in the array (a live window) are skipped.
    expect(downloadedAhead([undefined, fragment(0, 4), null, fragment(4, 8)], 2)).toBe(6);
    expect(downloadedAhead(undefined, 0)).toBe(0);
  });

  it('takes the shorter of video and audio, or what the element buffered when that is more', () => {
    const video = [fragment(0, 10), fragment(10, 20)];
    const audio = [fragment(0, 6), fragment(6, 12, WAITING)];
    expect(aheadOfPlayhead({video, audio, time: 0})).toBe(6);
    const buffered = {length: 1, start: () => 0, end: () => 9};
    expect(aheadOfPlayhead({video, audio, buffered, time: 0})).toBe(9);
    expect(bufferedAhead(buffered, 9)).toBe(0);
  });
});

/** Channels that deliver to each other, as BroadcastChannel does between pages. */
function network() {
  const channels = [];
  return (name) => {
    const channel = {
      name,
      onmessage: null,
      postMessage(data) {
        for (const other of channels) {
          if (other !== channel && other.name === name && other.onmessage) other.onmessage({data: structuredClone(data)});
        }
      },
      close() {
        channels.splice(channels.indexOf(channel), 1);
      },
    };
    channels.push(channel);
    return channel;
  };
}

/** A player as the peers see it: what the test sets is what it reports. */
function player(channel, clock, own) {
  const peers = new PlayerPeers({
    state: () => ({playing: own.playing, ahead: own.ahead, ramBytes: own.ramBytes || 0}),
    visible: () => own.visible,
    channel,
    now: () => clock.now,
  });
  peers.start();
  return peers;
}

describe('PlayerPeers', () => {
  it('a hidden paused player yields while a watched one is short, and takes the network back after', () => {
    const channel = network();
    const clock = {now: 1000};
    const front = {visible: true, playing: true, ahead: 3};
    const back = {visible: false, playing: false, ahead: 200};
    const watched = player(channel, clock, front);
    const hidden = player(channel, clock, back);

    watched.announce();
    expect(hidden.shouldYield()).toBe(true);
    // The watched one never yields.
    hidden.announce();
    expect(watched.shouldYield()).toBe(false);

    // Enough video now: the hidden one goes on yielding a moment, then not.
    front.ahead = 30;
    watched.announce();
    expect(hidden.shouldYield()).toBe(true);
    clock.now += YIELD_TAIL_MS;
    expect(hidden.shouldYield()).toBe(false);
  });

  it('steps aside when the message comes, not on its own next tick', () => {
    // A hidden page's timers run late (up to 15 s); a message arrives at once.
    const channel = network();
    const clock = {now: 1000};
    const front = {visible: true, playing: true, ahead: 30};
    const watched = player(channel, clock, front);
    const changes = [];
    const hidden = new PlayerPeers({
      state: () => ({playing: false, ahead: 100, ramBytes: 0}),
      visible: () => false,
      channel,
      now: () => clock.now,
      onChange: () => changes.push(hidden.shouldYield()),
    });
    hidden.start();
    watched.announce();
    expect(changes).toEqual([]);
    front.ahead = 2;
    watched.announce();
    expect(changes).toEqual([true]);
    // Still short: nothing new to tell.
    watched.announce();
    expect(changes).toEqual([true]);
    watched.stop();
    expect(changes).toHaveLength(2);
  });

  it('a seek makes a watched player short until it has more video', () => {
    const channel = network();
    const clock = {now: 1000};
    const front = {visible: true, playing: false, ahead: 15};
    const watched = player(channel, clock, front);
    const hidden = player(channel, clock, {visible: false, playing: false, ahead: 0});
    watched.announce();
    // Paused with 15 s: nobody needs to step aside.
    expect(hidden.shouldYield()).toBe(false);
    watched.noteSeek();
    watched.announce();
    expect(watched.isNeedy()).toBe(true);
    expect(hidden.shouldYield()).toBe(true);
  });

  it('a hidden player that plays keeps its own next seconds', () => {
    const channel = network();
    const clock = {now: 1000};
    const watched = player(channel, clock, {visible: true, playing: true, ahead: 2});
    const music = {visible: false, playing: true, ahead: HIDDEN_PLAYING_KEEP_S - 1};
    const background = player(channel, clock, music);
    watched.announce();
    expect(background.shouldYield()).toBe(false);
    music.ahead = HIDDEN_PLAYING_KEEP_S + 1;
    expect(background.shouldYield()).toBe(true);
  });

  it('forgets a peer that went: at its goodbye, or when it has not been heard from', () => {
    const channel = network();
    const clock = {now: 1000};
    const watched = player(channel, clock, {visible: true, playing: true, ahead: 2, ramBytes: 500});
    const hidden = player(channel, clock, {visible: false, playing: false, ahead: 100});
    watched.announce();
    expect(hidden.peersRamBytes()).toBe(500);
    watched.stop();
    expect(hidden.livePeers()).toEqual([]);
    clock.now += YIELD_TAIL_MS;
    expect(hidden.shouldYield()).toBe(false);

    const other = player(channel, clock, {visible: true, playing: true, ahead: 2});
    other.announce();
    expect(hidden.livePeers()).toHaveLength(1);
    clock.now += PEER_TIMEOUT_MS + 1;
    expect(hidden.livePeers()).toEqual([]);
  });

  it('stays alone, never yielding, without BroadcastChannel', () => {
    const peers = new PlayerPeers({
      state: () => ({playing: false, ahead: 0, ramBytes: 0}),
      visible: () => false,
      channel: () => {
        throw new ReferenceError('BroadcastChannel is not defined');
      },
    });
    expect(peers.start()).toBe(false);
    expect(peers.shouldYield()).toBe(false);
    expect(() => peers.announce()).not.toThrow();
  });

  it('keeps its channel when its player cannot say how it is doing yet', () => {
    // The client starts its peers while it is being built: reading its state threw, and
    // start() took that for a missing BroadcastChannel - every player was alone.
    const channel = network();
    const clock = {now: 1000};
    let built = false;
    const early = new PlayerPeers({
      state: () => {
        if (!built) throw new TypeError('fragmentsStore is undefined');
        return {playing: true, ahead: 2, ramBytes: 0};
      },
      visible: () => true,
      channel,
      now: () => clock.now,
    });
    expect(early.start()).toBe(true);
    expect(() => early.announce()).not.toThrow();
    const hidden = player(channel, clock, {visible: false, playing: false, ahead: 100});
    built = true;
    early.announce();
    expect(hidden.shouldYield()).toBe(true);
  });

  it('ignores what is not a peer\'s message', () => {
    const peers = new PlayerPeers({state: () => ({playing: false, ahead: 0}), visible: () => false, channel: network()});
    peers.start();
    for (const message of [null, 'x', {v: 2, id: 'a', needy: true}, {v: 1, needy: true}, {v: 1, id: peers.id, needy: true}]) {
      peers.receive(message);
    }
    expect(peers.livePeers()).toEqual([]);
    expect(peers.shouldYield()).toBe(false);
  });
});
