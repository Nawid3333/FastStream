import {afterEach, describe, expect, it} from 'vitest';

import {EpisodeMessages as HostEpisodeMessages, HeartbeatMs as HostHeartbeatMs, MaxNoticeSeconds as HostMaxNoticeSeconds,
  ReadableProperties, noticeSeconds as hostNoticeSeconds} from '../../native-host/faststream-mpv-host.mjs';
import {DecoderProperties, MpvBackend} from '../../chrome/background/MpvBackend.mjs';
import {EpisodeMessages, HeartbeatMs, MaxNoticeSeconds, noticeSeconds, relayWatch} from '../../chrome/background/MpvRelayWatch.mjs';

// MPV autoplay over the thin helper (host 15, 2026-10-13): the helper only relays mpv's lines
// and writes the allowlisted commands sent to it; what counts as a file's end is the
// extension's now (MpvRelayWatch.mjs), so a better end detection needs no helper reinstall.
// These are the helper's watchMpv cases (tests/unit/mpvWatch.test.mjs) over a fake port: mpv's
// JSON IPC as measured with the pinned mpv (headless, keep-open): observe_property sends the
// current value at once; at a file's end eof-reached goes false -> true; a loadfile replace
// sends end-file "stop", eof-reached and path unavailable, the new path, then eof-reached
// false; "script-message faststream-next" arrives as a client-message.

/**
 * A connectNative port to a fake helper.
 * @return {Object} sent: what the extension posted; emit(message): the helper's message;
 *   drop(lastError?): the port closes from the helper's side.
 */
function fakePort() {
  const listeners = {message: [], disconnect: []};
  const port = {
    sent: [],
    disconnected: false,
    onMessage: {addListener: (fn) => listeners.message.push(fn)},
    onDisconnect: {addListener: (fn) => listeners.disconnect.push(fn)},
    postMessage: (message) => {
      if (port.disconnected) throw new Error('Attempt to postMessage on disconnected port');
      port.sent.push(structuredClone(message));
    },
    disconnect: () => {
      port.disconnected = true;
    },
    emit: (message) => listeners.message.slice().forEach((fn) => fn(message)),
    drop: (lastError) => {
      port.disconnected = true;
      const before = globalThis.chrome;
      globalThis.chrome = {...before, runtime: {...before?.runtime, lastError}};
      listeners.disconnect.slice().forEach((fn) => fn());
      globalThis.chrome = before;
    },
  };
  return port;
}

const RELAY = {
  type: 'relay',
  heartbeat: {property: 'user-data/faststream/heartbeat', everyMs: 30000},
  onStop: [['set_property', 'user-data/faststream/connected', false]],
};

/** The mpv commands the extension sent through the helper, with their ids. */
const commands = (port) => port.sent.filter((m) => m.type === 'mpv');

/**
 * A relay watch that the helper has connected to mpv.
 * @return {{port: Object, events: Array<Object>, watch: Object, mpv: function(Object): void,
 *   reply: function(number, string, *): void}}
 */
function relaying() {
  const port = fakePort();
  const events = [];
  const watch = relayWatch(port, (event) => events.push(event));
  port.emit({type: 'relaying', hostVersion: 15, capabilities: ['play', 'ipc', 'relay']});
  return {
    port, events, watch,
    mpv: (data) => port.emit({type: 'mpv', data}),
    reply: (id, error, data) => port.emit({type: 'mpv-reply', id, error, data}),
  };
}

const pathEvent = (data) => ({event: 'property-change', id: 1, name: 'path', ...(data === undefined ? {} : {data})});
const eofEvent = (data) => ({event: 'property-change', id: 2, name: 'eof-reached', ...(data === undefined ? {} : {data})});
const pauseEvent = (data) => ({event: 'property-change', id: 3, name: 'pause', data});
const ended = (events) => events.filter((e) => e.type === 'ended');

describe('the relay watch', () => {
  it('observes only properties the helper lets an observer read (the decoder\'s too)', () => {
    for (const name of ['path', 'eof-reached', 'pause', ...DecoderProperties]) {
      expect(ReadableProperties.has(name)).toBe(true);
    }
  });

  it('keeps the helper\'s constants', () => {
    // Plus Space's message, which only the relay (host 15) maps: a helper's own watch, before
    // host 15, never had a countdown key, and adding it there would move the host's version.
    expect(EpisodeMessages).toEqual({...HostEpisodeMessages, 'faststream-pause': 'pause'});
    expect(HeartbeatMs).toBe(HostHeartbeatMs);
    expect(MaxNoticeSeconds).toBe(HostMaxNoticeSeconds);
    for (const seconds of [5, 99, 6.04, 0, -1, NaN, Infinity, '5', null, 0.01, 0.06, 2.25, 60]) {
      expect(noticeSeconds(seconds)).toBe(hostNoticeSeconds(seconds));
    }
  });

  it('asks the helper to relay, with the heartbeat and what to write when the extension lets go', () => {
    const port = fakePort();
    const events = [];
    relayWatch(port, (event) => events.push(event));
    expect(port.sent).toEqual([RELAY]);
    expect(events).toEqual([]);
  });

  it('asks mpv for its file and its end, marks the window followed, and says it watches', () => {
    const {port, events} = relaying();
    expect(port.sent).toEqual([
      RELAY,
      {type: 'mpv', command: ['observe_property', 1, 'path']},
      {type: 'mpv', command: ['observe_property', 2, 'eof-reached']},
      // Host 14: a pause at the end is an end too.
      {type: 'mpv', command: ['observe_property', 3, 'pause']},
      // Host 9: the mpv setup's episode buttons show while this holds.
      {type: 'mpv', command: ['set_property', 'user-data/faststream/connected', true]},
    ]);
    expect(events).toEqual([{type: 'watching'}]);
  });

  it('observes the decoder\'s properties it is given, and tells each change once, as replies', () => {
    const port = fakePort();
    const events = [];
    relayWatch(port, (event) => events.push(event), {decoderProperties: ['hwdec-current', 'width']});
    port.emit({type: 'relaying'});
    expect(commands(port).map((m) => m.command).slice(3, 5)).toEqual([
      ['observe_property', 10, 'hwdec-current'],
      ['observe_property', 11, 'width'],
    ]);
    const mpv = (data) => port.emit({type: 'mpv', data});
    mpv({event: 'property-change', id: 10, name: 'hwdec-current'});
    mpv({event: 'property-change', id: 11, name: 'width'});
    mpv({event: 'property-change', id: 10, name: 'hwdec-current', data: 'vulkan'});
    mpv({event: 'property-change', id: 11, name: 'width', data: 1280});
    mpv({event: 'property-change', id: 11, name: 'width', data: 1280});
    const told = events.filter((e) => e.type === 'decoder-replies').map((e) => e.replies);
    expect(told).toEqual([
      [{error: 'property unavailable'}, {error: 'property unavailable'}],
      [{error: 'success', data: 'vulkan'}, {error: 'property unavailable'}],
      [{error: 'success', data: 'vulkan'}, {error: 'success', data: 1280}],
    ]);
  });

  it('holds what is sent before the helper relays, and sends it after', () => {
    const port = fakePort();
    const watch = relayWatch(port, () => {});
    watch.state({autoplay: true});
    watch.hide();
    expect(port.sent).toEqual([RELAY]);
    port.emit({type: 'relaying'});
    expect(commands(port).map((m) => m.command).slice(4)).toEqual([
      ['set_property', 'user-data/faststream/autoplay', true],
      ['script-message-to', 'notify', 'hide', 'faststream'],
    ]);
  });

  it('tells a file\'s end once, and not one that had ended before the watch began', () => {
    const {events, mpv} = relaying();
    // The watch began on a file that had ended already: its eof-reached is true at once.
    mpv(pathEvent('https://cdn.test/ep1.m3u8#fs-id=1'));
    mpv(eofEvent(true));
    expect(ended(events)).toEqual([]);

    // The next episode loaded into the window (loadfile replace), played to its end.
    mpv({event: 'end-file', reason: 'stop'});
    mpv(eofEvent());
    mpv(pathEvent());
    mpv(pathEvent('https://cdn.test/ep2.m3u8#fs-id=2'));
    mpv(eofEvent(false));
    mpv(eofEvent(true));
    // Paused at the end and played again from there: the same file ends once.
    mpv(eofEvent(false));
    mpv(eofEvent(true));
    expect(ended(events)).toEqual([{type: 'ended', path: 'https://cdn.test/ep2.m3u8#fs-id=2'}]);
    // The same file loaded again (the episode played anew) ends again.
    mpv(eofEvent());
    mpv(pathEvent());
    mpv(pathEvent('https://cdn.test/ep2.m3u8#fs-id=2'));
    mpv(eofEvent(false));
    mpv(eofEvent(true));
    expect(ended(events)).toHaveLength(2);
    expect(events.filter((e) => e.type === 'path').map((e) => e.path))
        .toEqual(['https://cdn.test/ep1.m3u8#fs-id=1', 'https://cdn.test/ep2.m3u8#fs-id=2', 'https://cdn.test/ep2.m3u8#fs-id=2']);
  });

  it('tells the end of an mpv without keep-open (end-file eof)', () => {
    const {events, mpv} = relaying();
    mpv(pathEvent('https://cdn.test/ep3.mp4'));
    mpv(eofEvent(false));
    mpv({event: 'end-file', reason: 'eof'});
    expect(ended(events)).toEqual([{type: 'ended', path: 'https://cdn.test/ep3.mp4'}]);
  });

  // Host 14: a skip past the end of an HLS stream with discontinuities stopped mpv at the
  // end, paused (keep-open), with eof-reached never set (measured with the pinned mpv,
  // 2026-10-13). An end is also mpv at the last half second of its file when it pauses there
  // or a seek lands there.
  describe('an end mpv does not mark (eof-reached unset)', () => {
    /** The last question for the time left: its id. */
    const timeLeftAsked = (port) => {
      const asks = commands(port).filter((m) => m.command[0] === 'get_property' && m.command[1] === 'time-remaining');
      expect(asks.length).toBeGreaterThan(0);
      expect(Number.isInteger(asks.at(-1).id)).toBe(true);
      return asks.at(-1).id;
    };

    it('tells it when mpv pauses at the end', () => {
      const {port, events, mpv, reply} = relaying();
      mpv(pathEvent('https://cdn.test/ep4.m3u8'));
      mpv(eofEvent(false));
      mpv(pauseEvent(false));
      mpv(pauseEvent(true));
      reply(timeLeftAsked(port), 'success', 0);
      expect(ended(events)).toEqual([{type: 'ended', path: 'https://cdn.test/ep4.m3u8'}]);
    });

    it('tells it when a seek lands at the end, paused or not', () => {
      const {port, events, mpv, reply} = relaying();
      mpv(pathEvent('https://cdn.test/ep5.m3u8'));
      mpv(eofEvent(false));
      mpv(pauseEvent(false));
      mpv({event: 'playback-restart'});
      reply(timeLeftAsked(port), 'success', 0.3);
      expect(ended(events)).toEqual([{type: 'ended', path: 'https://cdn.test/ep5.m3u8'}]);
      // Asked no more once it ended.
      const asked = commands(port).length;
      mpv({event: 'playback-restart'});
      expect(commands(port)).toHaveLength(asked);
    });

    it('does not for a pause or a seek elsewhere in the file, or an answer that is no time', () => {
      const {port, events, mpv, reply} = relaying();
      mpv(pathEvent('https://cdn.test/ep6.m3u8'));
      mpv(eofEvent(false));
      mpv(pauseEvent(false));
      mpv(pauseEvent(true));
      reply(timeLeftAsked(port), 'success', 600);
      mpv({event: 'playback-restart'});
      reply(timeLeftAsked(port), 'success', 2);
      mpv({event: 'playback-restart'});
      reply(timeLeftAsked(port), 'property unavailable', 0);
      mpv({event: 'playback-restart'});
      port.emit({type: 'mpv-refused', id: timeLeftAsked(port), reason: 'not allowed'});
      // An answer to a question never asked.
      reply(99999, 'success', 0);
      expect(ended(events)).toEqual([]);
    });

    it('does not ask about the pause mpv was in when the watch began', () => {
      const {port, mpv} = relaying();
      mpv(pathEvent('https://cdn.test/ep7.m3u8'));
      mpv(eofEvent(false));
      mpv(pauseEvent(true));
      expect(commands(port).filter((m) => m.command[1] === 'time-remaining')).toEqual([]);
    });
  });

  it('passes on the keys for the next and the previous episode, autoplay and pause, and nothing else', () => {
    const {events, mpv} = relaying();
    mpv({event: 'client-message', args: ['faststream-next']});
    mpv({event: 'client-message', args: ['faststream-previous']});
    mpv({event: 'client-message', args: ['something-else']});
    mpv({event: 'client-message', args: ['toString']});
    mpv({event: 'client-message'});
    mpv({event: 'client-message', args: ['faststream-autoplay']});
    mpv({event: 'client-message', args: ['faststream-pause']});
    mpv('not an object');
    mpv(null);
    expect(events.filter((e) => e.type === 'request')).toEqual([
      {type: 'request', action: 'next'}, {type: 'request', action: 'previous'}, {type: 'request', action: 'autoplay'},
      {type: 'request', action: 'pause'},
    ]);
  });

  it('shows a notice through notify.lua, or mpv\'s own text when this mpv has none', () => {
    const {port, watch, reply} = relaying();
    watch.notify('Next episode', 'loading');
    const notice = commands(port).at(-1);
    expect(notice.command).toEqual(['script-message-to', 'notify', 'show', 'faststream', 'Next episode', 'loading']);
    reply(notice.id, 'error running command');
    expect(commands(port).at(-1)).toEqual({type: 'mpv', command: ['show-text', 'Next episode: loading', 4000]});
    // Shown by notify.lua: nothing more.
    watch.notify('Autoplay', 'on');
    const shown = commands(port).at(-1);
    reply(shown.id, 'success');
    expect(commands(port).at(-1)).toBe(shown);
    // Refused by the helper: mpv's own text, which it may take.
    watch.notify('Title only');
    port.emit({type: 'mpv-refused', id: commands(port).at(-1).id, reason: 'not allowed'});
    expect(commands(port).at(-1)).toEqual({type: 'mpv', command: ['show-text', 'Title only', 4000]});
  });

  it('says how long a notice stays, in whole seconds, and takes it down early', () => {
    // Before host 11, every notice went after notify.lua's 2 s: "next episode in 5 s" was gone
    // 3 s before the episode came. The helper takes a string of digits.
    const {port, watch, reply} = relaying();
    watch.notify('Autoplay', 'next episode in 5 s', 5);
    watch.notify('Next video', 'none found', 99);
    watch.notify('Next video', 'loading', 6.04);
    watch.notify('Half', 'second', 2.5);
    // Never "0": notify.lua reads it as "stay until hidden".
    watch.notify('Short', '', 0.4);
    for (const bad of [0, -1, NaN, Infinity, '5', null, 0.01]) watch.notify('x', '', bad);
    watch.hide();
    const sent = commands(port).filter((m) => m.command[0] === 'script-message-to');
    expect(sent.map((m) => m.command.slice(2))).toEqual([
      ['show', 'faststream', 'Autoplay', 'next episode in 5 s', '5'],
      ['show', 'faststream', 'Next video', 'none found', '60'],
      ['show', 'faststream', 'Next video', 'loading', '6'],
      ['show', 'faststream', 'Half', 'second', '3'],
      ['show', 'faststream', 'Short', '', '1'],
      ...Array(7).fill(['show', 'faststream', 'x', '']),
      ['hide', 'faststream'],
    ]);
    // Every notice has its own id; the hide has none: an mpv without notify.lua has nothing to
    // take down.
    expect(new Set(sent.slice(0, -1).map((m) => m.id)).size).toBe(12);
    expect(sent.at(-1).id).toBeUndefined();
    // Without notify.lua: mpv's own text, for as long, in whole milliseconds.
    reply(sent[0].id, 'error running command');
    expect(commands(port).at(-1).command).toEqual(['show-text', 'Autoplay: next episode in 5 s', 5000]);
    reply(sent[3].id, 'error running command');
    expect(commands(port).at(-1).command).toEqual(['show-text', 'Half: second', 3000]);
  });

  it('sends a notice the helper takes: one line, no ${, not too long', () => {
    const {port, watch} = relaying();
    watch.notify('A' + String.fromCharCode(10) + 'B' + String.fromCharCode(127), '${path} ' + 'x'.repeat(3000));
    const [, , , , title, detail] = commands(port).at(-1).command;
    expect(title).toBe('A B ');
    expect(detail.startsWith('$ {path} x')).toBe(true);
    expect(detail.length).toBe(2048);
  });

  it('tells mpv\'s autoplay button the setting, and only a yes or a no', () => {
    const {port, watch} = relaying();
    watch.state({autoplay: false});
    watch.state({autoplay: 'yes'});
    watch.state({});
    watch.state(null);
    watch.state({autoplay: true});
    expect(commands(port).slice(4).map((m) => m.command)).toEqual([
      ['set_property', 'user-data/faststream/autoplay', false],
      ['set_property', 'user-data/faststream/autoplay', true],
    ]);
  });

  it('lets go when stopped: closes the port (the helper unmarks the window), with no closed event', () => {
    const {port, events, watch} = relaying();
    watch.stop();
    expect(port.disconnected).toBe(true);
    watch.notify('x', 'y');
    watch.stop();
    port.emit({type: 'closed', reason: 'stopped'});
    expect(events).toEqual([{type: 'watching'}]);
  });

  it('ends, saying why, when mpv quits or there is none', () => {
    let {port, events} = relaying();
    port.emit({type: 'closed', reason: 'mpv closed'});
    port.drop();
    port.emit({type: 'mpv', data: pathEvent('https://cdn.test/late.m3u8')});
    expect(events).toEqual([{type: 'watching'}, {type: 'closed', reason: 'mpv closed'}]);

    port = fakePort();
    events = [];
    relayWatch(port, (event) => events.push(event));
    port.emit({type: 'closed', reason: 'no mpv'});
    expect(events).toEqual([{type: 'closed', reason: 'no mpv'}]);

    // A relay message the helper refused: its reason, and why.
    port = fakePort();
    events = [];
    relayWatch(port, (event) => events.push(event));
    port.emit({type: 'closed', reason: 'refused', error: 'heartbeat.everyMs'});
    expect(events).toEqual([{type: 'closed', reason: 'refused (heartbeat.everyMs)'}]);
  });

  it('takes a reply mpv could not give (too large, none) for no answer', () => {
    const {port, events, watch, mpv, reply} = relaying();
    mpv(pathEvent('https://cdn.test/ep8.m3u8'));
    mpv(eofEvent(false));
    mpv({event: 'playback-restart'});
    const ask = commands(port).at(-1);
    expect(ask.command).toEqual(['get_property', 'time-remaining']);
    reply(ask.id, 'reply too large');
    expect(ended(events)).toEqual([]);
    watch.notify('Autoplay', 'on', 2);
    reply(commands(port).at(-1).id, 'no reply');
    expect(commands(port).at(-1).command).toEqual(['show-text', 'Autoplay: on', 2000]);
  });

  it('ends, saying why, when the helper goes', () => {
    let {port, events} = relaying();
    port.drop({message: 'Native application tried to send a message of 2000000 bytes'});
    expect(events.at(-1)).toEqual({type: 'closed', reason: 'Native application tried to send a message of 2000000 bytes'});
    ({port, events} = relaying());
    port.drop();
    expect(events.at(-1)).toEqual({type: 'closed', reason: 'the mpv host went'});
  });

  it('hands an older helper back to the caller, which follows mpv the old way', () => {
    const port = fakePort();
    const events = [];
    let legacy = 0;
    relayWatch(port, (event) => events.push(event), {onLegacy: () => legacy++});
    port.emit({ok: false, error: 'unknown message', hostVersion: 14});
    port.drop();
    expect(legacy).toBe(1);
    expect(port.disconnected).toBe(true);
    expect(events).toEqual([]);
  });

  it('ends with the helper\'s reason for any other refusal', () => {
    const port = fakePort();
    const events = [];
    let legacy = 0;
    relayWatch(port, (event) => events.push(event), {onLegacy: () => legacy++});
    port.emit({ok: false, error: 'heartbeat refused', hostVersion: 15, capabilities: ['play', 'ipc', 'relay']});
    expect(legacy).toBe(0);
    expect(events).toEqual([{type: 'closed', reason: 'heartbeat refused'}]);
  });
});

// MpvBackend.watch keeps its events and interface (background.mjs did not change): over the
// relay when the helper has it, with the watch message for an older one.
describe('the backend\'s watch', () => {
  let ports;

  afterEach(() => {
    delete globalThis.chrome;
  });

  const stubBrowser = ({failConnect = false} = {}) => {
    ports = [];
    globalThis.chrome = {runtime: {
      lastError: undefined,
      connectNative: () => {
        if (failConnect) throw new Error('nativeMessaging permission missing');
        const port = fakePort();
        ports.push(port);
        return port;
      },
    }};
  };

  it('follows mpv over the relay when the helper has it', () => {
    stubBrowser();
    const backend = new MpvBackend();
    backend.capabilities = ['play', 'ipc', 'relay'];
    const events = [];
    const watch = backend.watch((event) => events.push(event));
    expect(ports).toHaveLength(1);
    expect(ports[0].sent).toEqual([RELAY]);
    ports[0].emit({type: 'relaying'});
    ports[0].emit({type: 'mpv', data: pathEvent('https://cdn.test/a.m3u8')});
    ports[0].emit({type: 'mpv', data: eofEvent(false)});
    ports[0].emit({type: 'mpv', data: eofEvent(true)});
    ports[0].emit({type: 'mpv', data: {event: 'client-message', args: ['faststream-next']}});
    expect(events).toEqual([{type: 'watching'}, {type: 'path', path: 'https://cdn.test/a.m3u8'},
      {type: 'ended', path: 'https://cdn.test/a.m3u8'}, {type: 'request', action: 'next'}]);
    watch.state({autoplay: true});
    expect(ports[0].sent.at(-1)).toEqual({type: 'mpv', command: ['set_property', 'user-data/faststream/autoplay', true]});
    expect(backend.watcher).toBe(watch);
    ports[0].emit({type: 'closed', reason: 'mpv closed'});
    expect(events.at(-1)).toEqual({type: 'closed', reason: 'mpv closed'});
    expect(backend.watcher).toBe(null);
  });

  it('follows it with the watch message for a helper before host 15', () => {
    stubBrowser();
    const backend = new MpvBackend();
    backend.capabilities = [];
    const events = [];
    const watch = backend.watch((event) => events.push(event));
    expect(ports[0].sent).toEqual([{type: 'watch'}]);
    ports[0].emit({type: 'watching'});
    ports[0].emit({type: 'ended', path: 'https://cdn.test/a.m3u8'});
    watch.notify('Autoplay', 'next episode in 5 s', 5);
    watch.hide();
    watch.state({autoplay: false});
    expect(ports[0].sent.slice(1)).toEqual([{type: 'notify', title: 'Autoplay', detail: 'next episode in 5 s', seconds: 5},
      {type: 'hide'}, {type: 'state', autoplay: false}]);
    expect(events).toEqual([{type: 'watching'}, {type: 'ended', path: 'https://cdn.test/a.m3u8'}]);
    // A host before 7 ("unknown message" to watch too): the watch ends, saying so.
    stubBrowser();
    backend.watch((event) => events.push(event));
    ports[0].emit({ok: false, error: 'unknown message'});
    expect(events.at(-1)).toEqual({type: 'closed', reason: 'unknown message'});
  });

  it('tries the relay while nothing is known, and goes the old way for an older helper', () => {
    stubBrowser();
    const backend = new MpvBackend();
    expect(backend.capabilities).toBe(null);
    const events = [];
    const watch = backend.watch((event) => events.push(event));
    expect(ports[0].sent).toEqual([RELAY]);
    ports[0].emit({ok: false, error: 'unknown message', hostVersion: 14});
    ports[0].drop();
    expect(backend.capabilities).toEqual([]);
    expect(ports).toHaveLength(2);
    expect(ports[1].sent).toEqual([{type: 'watch'}]);
    ports[1].emit({type: 'watching'});
    watch.notify('Next video', 'loading', 6);
    expect(ports[1].sent.at(-1)).toEqual({type: 'notify', title: 'Next video', detail: 'loading', seconds: 6});
    expect(events).toEqual([{type: 'watching'}]);
    watch.stop();
    expect(ports[1].disconnected).toBe(true);
    expect(backend.watcher).toBe(null);
    // And the next watch goes the old way at once.
    backend.watch(() => {});
    expect(ports).toHaveLength(3);
    expect(ports[2].sent).toEqual([{type: 'watch'}]);
  });

  it('starts no second port for a watch stopped before the older helper answered', () => {
    stubBrowser();
    const backend = new MpvBackend();
    const watch = backend.watch(() => {});
    watch.stop();
    expect(ports[0].disconnected).toBe(true);
    ports[0].emit({ok: false, error: 'unknown message'});
    expect(ports).toHaveLength(1);
  });

  it('follows one mpv at a time: a second watch ends the first', () => {
    stubBrowser();
    const backend = new MpvBackend();
    backend.capabilities = ['relay'];
    const first = [];
    backend.watch((event) => first.push(event));
    const second = backend.watch(() => {});
    expect(ports[0].disconnected).toBe(true);
    expect(first).toEqual([]);
    expect(backend.watcher).toBe(second);
  });

  it('says why when the port cannot be opened', () => {
    stubBrowser({failConnect: true});
    const backend = new MpvBackend();
    const events = [];
    const watch = backend.watch((event) => events.push(event));
    expect(events).toEqual([{type: 'closed', reason: 'Error: nativeMessaging permission missing'}]);
    expect(backend.watcher).toBe(null);
    // Its handle does nothing.
    watch.notify('x');
    watch.stop();
  });
});
