import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {END_ROOM_S, LIVE_SHORT_S, PlayerPeers, SPEED_WINDOW_MS, STUCK_MS} from '../../chrome/player/network/PlayerPeers.mjs';
import {goesBefore, JOIN_FACTOR, LEAVE_FACTOR, leavesRoom, mustWait, rankOf, SEEN_FACTOR} from '../../chrome/player/network/PlayerTurns.mjs';

// Players in several tabs (PlayerTurns): the one the user looks at downloads first, those in
// background tabs one after the other behind it, or all at once on a line fast enough. And
// what made players stop each other for good before (PlayerPeers.needy): a live stream, a
// short clip that loops, a watched video whose server is dead.

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
function player(channel, clock, own, onChange) {
  const peers = new PlayerPeers({
    state: () => ({ramBytes: 0, ahead: 0, playing: false, ...own}),
    visible: () => !!own.visible,
    channel,
    now: () => clock.now,
    onChange,
  });
  peers.start();
  return peers;
}

const RATE = 100000;
const turn = (fields) => ({id: 'x', visible: false, playing: false, wants: true, speed: 0, rate: RATE, seen: 0, born: 0,
  shared: true, host: 'a.example', ...fields});

describe('PlayerTurns: the order', () => {
  it('seen before playing unseen before the rest; then the one seen last; then the oldest; then the id', () => {
    expect(rankOf(turn({visible: true}))).toBe(2);
    expect(rankOf(turn({playing: true}))).toBe(1);
    expect(rankOf(turn({}))).toBe(0);
    expect(goesBefore(turn({id: 'a', visible: true}), turn({id: 'b', playing: true, seen: 9e9}))).toBe(true);
    expect(goesBefore(turn({id: 'a', playing: true}), turn({id: 'b', seen: 9e9}))).toBe(true);
    expect(goesBefore(turn({id: 'a', seen: 2000}), turn({id: 'b', seen: 1000}))).toBe(true);
    // Never seen (tabs opened in the background, in a row): in the order they were opened.
    expect(goesBefore(turn({id: 'z', born: 1}), turn({id: 'a', born: 2}))).toBe(true);
    expect(goesBefore(turn({id: 'a'}), turn({id: 'b'}))).toBe(true);
    expect(goesBefore(turn({id: 'b'}), turn({id: 'a'}))).toBe(false);
  });

  it('is total: of two players with different ids, exactly one goes before the other', () => {
    const state = fc.record({
      id: fc.string({minLength: 1, maxLength: 4}),
      visible: fc.boolean(),
      playing: fc.boolean(),
      seen: fc.oneof(fc.constant(0), fc.integer({min: 0, max: 5}), fc.constant(NaN), fc.constant(undefined)),
      born: fc.oneof(fc.integer({min: 0, max: 5}), fc.constant(undefined)),
    });
    fc.assert(fc.property(state, state, (a, b) => {
      fc.pre(a.id !== b.id);
      expect(goesBefore(a, b)).toBe(!goesBefore(b, a));
    }), {numRuns: 2000});
    // And transitive: a before b before c means a before c.
    fc.assert(fc.property(state, state, state, (a, b, c) => {
      fc.pre(a.id !== b.id && b.id !== c.id && a.id !== c.id);
      if (goesBefore(a, b) && goesBefore(b, c)) expect(goesBefore(a, c)).toBe(true);
    }), {numRuns: 2000});
  });
});

describe('PlayerTurns: who waits', () => {
  it('a player the user sees never waits; one in a background tab waits behind one that is seen and downloads', () => {
    const seen = turn({id: 'seen', visible: true, speed: RATE});
    const back = turn({id: 'back'});
    expect(mustWait(seen, [back], false)).toBe(false);
    expect(mustWait(back, [seen], false)).toBe(true);
    // The one in front has its video (or its RAM is full, or the user paused its downloads).
    expect(mustWait(back, [{...seen, wants: false}], true)).toBe(false);
  });

  it('on a fast line the next one downloads beside it, and stays until the first is slow', () => {
    const back = turn({id: 'back', seen: 1});
    const first = (speed) => turn({id: 'first', seen: 2, speed});
    // Behind another one in a background tab: joins at JOIN_FACTOR times its video's rate...
    expect(mustWait(back, [first(JOIN_FACTOR * RATE - 1)], true)).toBe(true);
    expect(mustWait(back, [first(JOIN_FACTOR * RATE)], true)).toBe(false);
    // ...and stays, sharing the line, down to LEAVE_FACTOR times.
    expect(mustWait(back, [first(LEAVE_FACTOR * RATE)], false)).toBe(false);
    expect(mustWait(back, [first(LEAVE_FACTOR * RATE - 1)], false)).toBe(true);
    // The one the user looks at keeps twice that for itself.
    const front = (speed) => turn({id: 'seen', visible: true, speed});
    expect(mustWait(back, [front(SEEN_FACTOR * JOIN_FACTOR * RATE - 1)], true)).toBe(true);
    expect(mustWait(back, [front(SEEN_FACTOR * JOIN_FACTOR * RATE)], true)).toBe(false);
    expect(mustWait(back, [front(SEEN_FACTOR * LEAVE_FACTOR * RATE)], false)).toBe(false);
    expect(mustWait(back, [front(SEEN_FACTOR * LEAVE_FACTOR * RATE - 1)], false)).toBe(true);
    // A rate not known yet says nothing of the line: wait.
    expect(mustWait(back, [turn({id: 'seen', visible: true, speed: 9e9, rate: 0})], true)).toBe(true);
  });

  it('a server that limits each connection leaves room for players on other hosts, not on its own', () => {
    const limited = turn({id: 'seen', visible: true, speed: RATE, shared: false, host: 'slow.example'});
    expect(leavesRoom(limited, turn({host: 'other.example'}), true)).toBe(true);
    // The same host: Firefox's six connections to it are shared between the tabs.
    expect(leavesRoom(limited, turn({host: 'slow.example'}), true)).toBe(false);
    // A host not known (nothing downloaded yet) is not taken for another one.
    expect(leavesRoom(limited, turn({host: ''}), true)).toBe(false);
    expect(leavesRoom({...limited, host: ''}, turn({host: 'other.example'}), true)).toBe(false);
  });

  it('those in background tabs go one after the other: the one seen last first', () => {
    const first = turn({id: 'c', seen: 3000});
    const second = turn({id: 'a', seen: 2000});
    const third = turn({id: 'b', seen: 1000});
    expect(mustWait(first, [second, third], false)).toBe(false);
    expect(mustWait(second, [first, third], false)).toBe(true);
    expect(mustWait(third, [first, second], false)).toBe(true);
    // The first has its video: the second's turn, the third still waits.
    const done = {...first, wants: false};
    expect(mustWait(second, [done, third], true)).toBe(false);
    expect(mustWait(third, [done, second], true)).toBe(true);
  });

  it('never leaves everyone waiting: of the players that want the network, one downloads', () => {
    const state = fc.record({
      visible: fc.boolean(),
      playing: fc.boolean(),
      wants: fc.boolean(),
      speed: fc.oneof(fc.constant(0), fc.integer({min: 0, max: 10 * RATE})),
      rate: fc.oneof(fc.constant(0), fc.constant(RATE)),
      seen: fc.integer({min: 0, max: 3}),
      born: fc.integer({min: 0, max: 3}),
      shared: fc.boolean(),
      host: fc.constantFrom('', 'a.example', 'b.example'),
      waiting: fc.boolean(),
    });
    fc.assert(fc.property(fc.array(state, {minLength: 1, maxLength: 7}), (list) => {
      const players = list.map((fields, index) => ({...fields, id: 'p' + index}));
      const wanting = players.filter((own) => own.wants);
      fc.pre(wanting.length > 0);
      const downloading = wanting.filter((own) => !mustWait(own, players.filter((peer) => peer !== own), own.waiting));
      expect(downloading.length).toBeGreaterThan(0);
      // Seen ones never wait, whatever the others say.
      for (const own of players.filter((one) => one.visible)) {
        expect(mustWait(own, players.filter((peer) => peer !== own), own.waiting)).toBe(false);
      }
      // One that does not wait while waiting (it may join) does not wait once it downloads.
      for (const own of players) {
        const peers = players.filter((peer) => peer !== own);
        if (!mustWait(own, peers, true)) expect(mustWait(own, peers, false)).toBe(false);
      }
      // A player that wants nothing holds nobody.
      for (const own of players) {
        const others = players.filter((peer) => peer !== own).map((peer) => ({...peer, wants: false}));
        expect(mustWait(own, others, own.waiting)).toBe(false);
      }
    }), {numRuns: 3000});
  });

  it('does not throw on what is not a peer\'s state', () => {
    fc.assert(fc.property(fc.array(fc.anything(), {maxLength: 5}), fc.boolean(), (peers, waiting) => {
      expect(typeof mustWait(turn({}), /** @type {any} */ (peers.filter((peer) => peer && typeof peer === 'object')), waiting)).toBe('boolean');
    }), {numRuns: 1000});
  });
});

describe('PlayerPeers: turns between tabs', () => {
  it('a player in a background tab waits while the visible one downloads, and starts when it is done', () => {
    const channel = network();
    const clock = {now: 1000};
    const front = {visible: true, playing: true, ahead: 60, room: 500, wants: true, received: 0, rate: RATE, host: 'a.example'};
    const back = {visible: false, ahead: 0, room: 500, wants: true, received: 0, rate: RATE, host: 'a.example'};
    const watched = player(channel, clock, front);
    const changes = [];
    const hidden = player(channel, clock, back, () => changes.push(hidden.shouldWait()));

    watched.announce();
    // Told by the message, not at its own next tick (a hidden page's can be 15 s away).
    expect(changes).toEqual([true]);
    expect(hidden.shouldWait()).toBe(true);
    // Not the hard rule: the watched one has plenty ahead, nothing is cancelled.
    expect(hidden.shouldYield()).toBe(false);
    hidden.announce();
    expect(watched.shouldWait()).toBe(false);

    // The watched one downloads on, at its video's rate: still its turn.
    for (let second = 1; second <= 6; second++) {
      clock.now += 1000;
      front.received += RATE;
      watched.announce();
    }
    expect(hidden.shouldWait()).toBe(true);

    // It has everything now.
    front.wants = false;
    watched.announce();
    expect(changes.at(-1)).toBe(false);
    expect(hidden.shouldWait()).toBe(false);
  });

  it('a paused player that waits holds its own playback\'s requests once it has its next seconds', () => {
    // What a paused player's own playback asks for past its next seconds is buffering ahead
    // by another name (an MP4 player's own loading reads 30 MB ahead of the playhead).
    const channel = network();
    const clock = {now: 1000};
    const front = {visible: true, playing: true, ahead: 60, room: 500, wants: true, received: 0, rate: RATE, host: 'a.example'};
    const back = {visible: false, playing: false, ahead: 4, room: 500, wants: true, received: 0, rate: RATE, host: 'a.example'};
    const watched = player(channel, clock, front);
    const hidden = player(channel, clock, back);
    // Not waiting: nothing is held.
    expect(hidden.waitHoldsPlayback()).toBe(false);
    watched.announce();
    expect(hidden.shouldWait()).toBe(true);
    // Short of its next seconds: its playback still gets them, to play at once when seen.
    expect(hidden.waitHoldsPlayback()).toBe(false);
    back.ahead = 10;
    expect(hidden.waitHoldsPlayback()).toBe(true);
    // Playing unseen (music): its playback's requests are never held.
    back.playing = true;
    back.ahead = 45;
    expect(hidden.shouldWait()).toBe(true);
    expect(hidden.waitHoldsPlayback()).toBe(false);
    // The watched one never waits, so it holds nothing.
    expect(watched.shouldWait()).toBe(false);
    expect(watched.waitHoldsPlayback()).toBe(false);
  });

  it('on a fast line both download: the one in front tells its speed, measured from what it received', () => {
    const channel = network();
    const clock = {now: 1000};
    const front = {visible: true, playing: true, ahead: 60, room: 500, wants: true, received: 0, rate: RATE, host: 'a.example'};
    const watched = player(channel, clock, front);
    const hidden = player(channel, clock, {visible: false, ahead: 0, room: 500, wants: true, rate: RATE, host: 'a.example'});
    watched.announce();
    expect(hidden.shouldWait()).toBe(true);
    // Ten times its video's rate, for a few seconds.
    for (let second = 1; second <= 4; second++) {
      clock.now += 1000;
      front.received += 10 * RATE;
      watched.announce();
    }
    expect(hidden.shouldWait()).toBe(false);
    // Sharing the line now, it is down to 5 times: the other stays (no start and stop).
    for (let second = 1; second <= SPEED_WINDOW_MS / 1000 + 2; second++) {
      clock.now += 1000;
      front.received += 5 * RATE;
      watched.announce();
    }
    expect(hidden.shouldWait()).toBe(false);
    // Down to its video's own rate: the other waits again.
    for (let second = 1; second <= SPEED_WINDOW_MS / 1000 + 2; second++) {
      clock.now += 1000;
      front.received += RATE;
      watched.announce();
    }
    expect(hidden.shouldWait()).toBe(true);
  });

  it('a player whose downloads bring nothing does not keep the others waiting', () => {
    const channel = network();
    const clock = {now: 1000};
    const front = {visible: true, playing: false, ahead: 60, room: 500, wants: true, received: 5000, rate: RATE, host: 'a.example'};
    const watched = player(channel, clock, front);
    const hidden = player(channel, clock, {visible: false, ahead: 0, room: 500, wants: true, rate: RATE, host: 'a.example'});
    watched.announce();
    expect(hidden.shouldWait()).toBe(true);
    // A dead server: it wants its video, and no byte comes.
    clock.now += STUCK_MS;
    watched.announce();
    expect(hidden.shouldWait()).toBe(true);
    clock.now += 1000;
    watched.announce();
    expect(hidden.shouldWait()).toBe(false);
    // A byte comes: its turn again.
    clock.now += 1000;
    front.received += 1;
    watched.announce();
    expect(hidden.shouldWait()).toBe(true);
  });

  it('a waiting player is not taken for stuck: after its wait it holds the next one', () => {
    const channel = network();
    const clock = {now: 1000};
    const front = {visible: true, playing: false, ahead: 60, room: 500, wants: true, received: 0, rate: RATE, host: 'a.example'};
    const second = {visible: false, ahead: 0, room: 500, wants: true, received: 0, rate: RATE, host: 'a.example'};
    const third = {visible: false, ahead: 0, room: 500, wants: true, received: 0, rate: RATE, host: 'a.example'};
    const watched = player(channel, clock, front);
    const next = player(channel, clock, second);
    clock.now += 10;
    const last = player(channel, clock, third);
    const tick = () => {
      for (const peers of [watched, next, last]) {
        peers.announce();
        peers.shouldYield();
        peers.shouldWait();
      }
    };
    // The watched one downloads for a minute; the two behind it wait all that time.
    for (let seconds = 0; seconds < 60; seconds++) {
      clock.now += 1000;
      front.received += RATE;
      tick();
    }
    expect([next.waiting, last.waiting]).toEqual([true, true]);
    // Done: the older of the two starts, and the other goes on waiting for it.
    front.wants = false;
    tick();
    tick();
    expect([next.waiting, last.waiting]).toEqual([false, true]);
  });

  it('a save in a background tab is not made to wait, nor is music that plays there and runs short', () => {
    const channel = network();
    const clock = {now: 1000};
    const watched = player(channel, clock, {visible: true, playing: true, ahead: 60, room: 500, wants: true, rate: RATE});
    const saving = player(channel, clock, {visible: false, ahead: 0, wants: true, saving: true});
    const music = {visible: false, playing: true, ahead: 5, wants: true};
    const playing = player(channel, clock, music);
    watched.announce();
    expect(saving.shouldWait()).toBe(false);
    expect(playing.shouldWait()).toBe(false);
    // With its next half minute in hand, the music waits like the rest.
    music.ahead = 40;
    expect(playing.shouldWait()).toBe(true);
  });

  it('alone, or without a channel, never waits', () => {
    const clock = {now: 1000};
    const alone = player(network(), clock, {visible: false, wants: true});
    expect(alone.shouldWait()).toBe(false);
    const none = new PlayerPeers({state: () => ({playing: false, ahead: 0, ramBytes: 0, wants: true}), visible: () => false,
      channel: () => {
        throw new Error('no BroadcastChannel');
      }, now: () => clock.now});
    none.start();
    expect(none.shouldWait()).toBe(false);
  });
});

describe('PlayerPeers: short of video, but nothing the others could give', () => {
  /**
   * Whether a watched player in this state makes one in a background tab step aside.
   * @param {Object} front - The watched player's state.
   * @param {(clock: {now: number}, watched: PlayerPeers, front: Object) => void} [then]
   * @return {boolean}
   */
  function stopsTheOthers(front, then) {
    const channel = network();
    const clock = {now: 1000};
    const watched = player(channel, clock, front);
    const hidden = player(channel, clock, {visible: false, ahead: 100});
    watched.announce();
    then?.(clock, watched, front);
    return hidden.shouldYield();
  }

  it('a video with less than 10 s ahead still does, as before', () => {
    expect(stopsTheOthers({visible: true, playing: true, ahead: 3, room: 500})).toBe(true);
    // Without a known length too (what a player that says nothing of it gets).
    expect(stopsTheOthers({visible: true, playing: true, ahead: 3})).toBe(true);
  });

  it('a live stream that keeps 6 s ahead by design does not: only one nearly dry, or standing still', () => {
    expect(stopsTheOthers({visible: true, playing: true, ahead: 6, live: true})).toBe(false);
    expect(stopsTheOthers({visible: true, playing: true, ahead: LIVE_SHORT_S - 1, live: true})).toBe(true);
    expect(stopsTheOthers({visible: true, playing: true, ahead: 6, live: true, buffering: true})).toBe(true);
  });

  it('a clip shorter than 10 s that loops, or a video in its last seconds, does not', () => {
    // An 8 s clip, all of it downloaded, playing round and round.
    expect(stopsTheOthers({visible: true, playing: true, ahead: 6, room: 0})).toBe(false);
    expect(stopsTheOthers({visible: true, playing: true, ahead: 4, room: END_ROOM_S})).toBe(false);
    expect(stopsTheOthers({visible: true, playing: true, ahead: 4, room: END_ROOM_S + 1})).toBe(true);
  });

  it('a watched video whose server is dead stops the others for 15 s, not for as long as it is watched', () => {
    const dead = {visible: true, playing: true, ahead: 0, room: 500, received: 4000};
    expect(stopsTheOthers(dead)).toBe(true);
    expect(stopsTheOthers(dead, (clock, watched) => {
      clock.now += STUCK_MS + 1000;
      watched.announce();
      // The others go on stepping aside a moment after the last word (YIELD_TAIL_MS).
      clock.now += 5000;
    })).toBe(false);
    // A slow line is not a dead server: bytes keep coming, and the others keep stepping aside.
    expect(stopsTheOthers(dead, (clock, watched, front) => {
      for (let second = 0; second < 40; second++) {
        clock.now += 1000;
        front.received += 10;
        watched.announce();
      }
    })).toBe(true);
  });
});
