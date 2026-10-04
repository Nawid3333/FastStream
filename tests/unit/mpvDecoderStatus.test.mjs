import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MaxStatusWaitMs, decoderFromReplies, mpvIpcRequest, queryDecoder} from '../../native-host/faststream-mpv-host.mjs';
import {MpvBackend, RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {loadBackground} from './backgroundHarness.mjs';

// "Is mpv on my GPU?" FastStream never sets mpv's hardware decoding (mpv.conf is the
// user's); it asks the mpv the host started which decoder it uses (hwdec-current over the
// single-instance pipe) and says so: on the toolbar button's tooltip after a hand-off, and
// in "Test mpv connection". In software it adds a hint, nothing more.

const reply = (id, data) => ({request_id: id, data, error: 'success'});
const unavailable = (id) => ({request_id: id, error: 'property unavailable'});

describe('the host reading mpv\'s decoder', () => {
  it('reads the hardware API, the format and the size', () => {
    expect(decoderFromReplies([reply(1, 'd3d11va'), reply(2, 'auto-safe'), reply(3, 'av1'), reply(4, 1920), reply(5, 1080)]))
        .toEqual({hardware: true, api: 'd3d11va', requested: 'auto-safe', format: 'av1', width: 1920, height: 1080});
  });

  it('reads "no" as software', () => {
    expect(decoderFromReplies([reply(1, 'no'), reply(2, 'no'), reply(3, 'h264'), reply(4, 1280), reply(5, 720)]))
        .toMatchObject({hardware: false, api: 'no', format: 'h264'});
  });

  it('counts a copy-back API as hardware', () => {
    expect(decoderFromReplies([reply(1, 'd3d11va-copy')])).toMatchObject({hardware: true, api: 'd3d11va-copy'});
  });

  it('has no decoder while mpv has none loaded', () => {
    expect(decoderFromReplies([unavailable(1), reply(2, 'auto-safe')])).toBe(null);
    expect(decoderFromReplies([])).toBe(null);
    expect(decoderFromReplies(undefined)).toBe(null);
  });

  it('leaves out what mpv did not give', () => {
    expect(decoderFromReplies([reply(1, 'vulkan'), unavailable(3), reply(4, -1), reply(5, 'x')]))
        .toEqual({hardware: true, api: 'vulkan', requested: null, format: null, width: null, height: null});
  });
});

describe('the host asking mpv until it decodes', () => {
  /**
   * A clock and a sleep that moves it, and an ipcRequest that answers from a list.
   * @param {Array<Object>} answers - mpvIpcRequest results, in order; the last repeats.
   * @return {Object}
   */
  const scripted = (answers) => {
    let time = 0;
    const asked = [];
    return {
      asked,
      ipcRequest: async (commands) => {
        asked.push(commands);
        return answers[Math.min(asked.length - 1, answers.length - 1)];
      },
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
    };
  };
  const decoding = {ok: true, replies: [reply(1, 'd3d11va'), reply(3, 'hevc'), reply(4, 3840), reply(5, 2160)]};
  const opening = {ok: true, replies: [unavailable(1)]};

  it('says no mpv of ours runs when the pipe is not there', async () => {
    const s = scripted([{ok: false, error: 'no mpv ipc'}]);
    expect(await queryDecoder(20000, s.ipcRequest, s.sleep, s.now)).toEqual({running: false, decoder: null});
    expect(s.asked.length).toBe(1);
  });

  it('asks every property mpv knows the decoder by', async () => {
    const s = scripted([decoding]);
    await queryDecoder(0, s.ipcRequest, s.sleep, s.now);
    expect(s.asked[0]).toEqual(['hwdec-current', 'hwdec', 'video-format', 'width', 'height']
        .map((name) => ({command: ['get_property', name]})));
  });

  it('waits while the stream opens, then answers', async () => {
    const s = scripted([opening, {ok: false, busy: true}, decoding]);
    const status = await queryDecoder(20000, s.ipcRequest, s.sleep, s.now);
    expect(status).toEqual({running: true, decoder: {hardware: true, api: 'd3d11va', requested: null, format: 'hevc', width: 3840, height: 2160}});
    expect(s.asked.length).toBe(3);
  });

  it('gives up after the wait with mpv running and no decoder yet', async () => {
    const s = scripted([opening]);
    expect(await queryDecoder(5000, s.ipcRequest, s.sleep, s.now)).toEqual({running: true, decoder: null});
    // Once a second, the last time at the deadline.
    expect(s.asked.length).toBe(6);
    expect(s.now()).toBe(5000);
  });

  it('asks once without a wait, and never waits past the cap', async () => {
    let s = scripted([opening]);
    await queryDecoder(undefined, s.ipcRequest, s.sleep, s.now);
    expect(s.asked.length).toBe(1);
    s = scripted([opening]);
    await queryDecoder(-5, s.ipcRequest, s.sleep, s.now);
    expect(s.asked.length).toBe(1);
    s = scripted([opening]);
    await queryDecoder(Infinity, s.ipcRequest, s.sleep, s.now);
    expect(s.now()).toBe(MaxStatusWaitMs);
    expect(s.asked.length).toBe(MaxStatusWaitMs / 1000 + 1);
  });

  // The same, through the real transport, against a socket that answers as mpv does.
  it.skipIf(process.platform === 'win32')('works over the pipe with mpv\'s own protocol', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ipc-'));
    const pipe = path.join(dir, 'sock');
    const properties = {'hwdec-current': 'vaapi', 'hwdec': 'auto-safe', 'video-format': 'vp9', 'width': 2560, 'height': 1440};
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          // mpv also writes events between replies.
          socket.write(JSON.stringify({event: 'property-change', name: 'pause'}) + '\n');
          socket.write(JSON.stringify(reply(request.request_id, properties[request.command[1]])) + '\n');
        }
      });
    });
    await new Promise((resolve) => server.listen(pipe, resolve));
    try {
      const status = await queryDecoder(0, (commands, a, b) => mpvIpcRequest(commands, a, b, pipe));
      expect(status).toEqual({running: true, decoder: {hardware: true, api: 'vaapi', requested: 'auto-safe', format: 'vp9', width: 2560, height: 1440}});
    } finally {
      server.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe('the extension asking the host', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  const host = (answer) => {
    const sent = [];
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendNativeMessage(name, message, callback) {
          sent.push(message);
          callback(answer(message));
        },
      },
    };
    return sent;
  };

  it('sends a status message and reads the decoder', async () => {
    const sent = host(() => ({ok: true, running: true, hostVersion: RequiredHostVersion,
      decoder: {hardware: true, api: 'd3d11va', requested: 'auto-safe', format: 'av1', width: 1920, height: 1080}}));
    expect(await new MpvBackend().decoderStatus(20000)).toEqual({ok: true, running: true,
      decoder: {hardware: true, api: 'd3d11va', format: 'av1', width: 1920, height: 1080}});
    expect(sent).toEqual([{type: 'status', waitMs: 20000}]);
  });

  it('says when no mpv of the host\'s is open', async () => {
    host(() => ({ok: true, running: false, decoder: null, hostVersion: RequiredHostVersion}));
    expect(await new MpvBackend().decoderStatus()).toEqual({ok: true, running: false, decoder: null});
  });

  it('takes an older host\'s "unknown message" for no answer, and the host as outdated', async () => {
    host(() => ({ok: false, error: 'unknown message', hostVersion: RequiredHostVersion - 1}));
    expect(await new MpvBackend().decoderStatus()).toEqual({ok: false, error: 'unknown message', hostOutdated: true});
  });

  it('reports a host the browser could not start', async () => {
    globalThis.chrome = {runtime: {lastError: undefined, sendNativeMessage(name, message, callback) {
      globalThis.chrome.runtime.lastError = {message: 'no such native application'};
      callback(undefined);
      globalThis.chrome.runtime.lastError = undefined;
    }}};
    expect(await new MpvBackend().decoderStatus()).toEqual({ok: false, error: 'no such native application'});
  });

  it('checks what the host says before it reaches the toolbar', () => {
    expect(MpvBackend.readDecoder({api: 'x'.repeat(100), format: 7, width: 1919.6, height: 'tall'}))
        .toEqual({hardware: true, api: 'x'.repeat(40), format: null, width: 1920, height: null});
    expect(MpvBackend.readDecoder({api: ''})).toBe(null);
    expect(MpvBackend.readDecoder('d3d11va')).toBe(null);
    expect(MpvBackend.readDecoder(null)).toBe(null);
  });

  it('names a decoder: the API in hardware, then the format and size', () => {
    expect(MpvBackend.describeDecoder({hardware: true, api: 'd3d11va', format: 'av1', width: 1920, height: 1080}))
        .toBe('d3d11va, AV1 1920x1080');
    expect(MpvBackend.describeDecoder({hardware: false, api: 'no', format: 'h264', width: 1280, height: 720}))
        .toBe('H.264 1280x720');
    expect(MpvBackend.describeDecoder({hardware: true, api: 'vulkan', format: 'prores', width: null, height: null}))
        .toBe('vulkan, PRORES');
    expect(MpvBackend.describeDecoder(null)).toBe('');
  });
});

describe('the toolbar button with mpv\'s decoder', () => {
  let BackgroundUtils;
  let calls;

  beforeAll(async () => {
    globalThis.chrome = {runtime: {getURL: (file) => 'moz-extension://test/' + file}};
    ({BackgroundUtils} = await import('../../chrome/background/BackgroundUtils.mjs'));
  });

  beforeEach(() => {
    calls = {};
    const record = (name) => (details) => {
      calls[name] = details;
    };
    globalThis.chrome = {
      runtime: {getURL: (file) => 'moz-extension://test/' + file},
      i18n: {getMessage: () => ''},
      action: {setBadgeText: record('badge'), setTitle: record('title'), setIcon: record('icon')},
    };
  });

  const tab = (fields) => ({tabId: 3, isOn: true, isMpv: true, mpvError: null, mpvHostOutdated: false, ...fields});

  it('names the hardware API mpv decodes with', () => {
    BackgroundUtils.updateTabIcon(tab({mpvDecoder: {hardware: true, api: 'd3d11va', format: 'av1', width: 1920, height: 1080}}));
    expect(calls.title).toEqual({title: 'FastStream - Playing in MPV - decoded by the graphics card: d3d11va, AV1 1920x1080', tabId: 3});
    expect(calls.badge).toEqual({text: '', tabId: 3});
  });

  it('says what to add to mpv.conf when mpv decodes in software, and changes nothing else', () => {
    BackgroundUtils.updateTabIcon(tab({mpvDecoder: {hardware: false, api: 'no', format: 'h264', width: 1280, height: 720}}));
    expect(calls.title).toEqual({title: 'FastStream - Playing in MPV - decoded by the processor (H.264 1280x720): ' +
      'add hwdec=auto-safe to mpv.conf to decode on the graphics card', tabId: 3});
    expect(calls.badge).toEqual({text: '', tabId: 3});
  });

  it('puts a failed hand-off and an outdated host first', () => {
    const decoder = {hardware: false, api: 'no', format: 'h264', width: 1280, height: 720};
    BackgroundUtils.updateTabIcon(tab({mpvDecoder: decoder, mpvError: 'mpv executable not found'}));
    expect(calls.title.title).toBe('FastStream - MPV - the stream did not open: mpv executable not found');
    BackgroundUtils.updateTabIcon(tab({mpvDecoder: decoder, mpvHostOutdated: true}));
    expect(calls.title.title).toMatch(/out of date/);
  });
});

describe('the background after a hand-off', () => {
  const PAGE = 'https://site.test/watch/1';
  const EPISODE = 'https://cdn.test/episode/master.m3u8';
  const HW = {hardware: true, api: 'd3d11va', format: 'av1', width: 1920, height: 1080};
  let bg;

  afterEach(() => {
    bg?.unload();
    bg = null;
    vi.restoreAllMocks();
  });

  const host = (decoder, {running = true} = {}) => (message) => message.type === 'status' ?
    {ok: true, running, decoder, hostVersion: RequiredHostVersion} :
    {ok: true, hostVersion: RequiredHostVersion};

  it('asks mpv for its decoder and shows it, also after the event page restarted', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true},
      tabs: [{id: 1, url: PAGE}],
      onNative: host(HW),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(100);
    expect(bg.native.filter((m) => m.type === 'status')).toEqual([{type: 'status', waitMs: 20000}]);
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV - decoded by the graphics card: d3d11va, AV1 1920x1080');
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}], session});
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV - decoded by the graphics card: d3d11va, AV1 1920x1080');
  });

  it('forgets it on the next page', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true},
      tabs: [{id: 1, url: PAGE}],
      onNative: host(HW),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(100);
    await bg.navigated(1, 'https://site.test/watch/2');
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV');
  });

  it('does not ask an mpv started without the pipe (single instance off)', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: false},
      tabs: [{id: 1, url: PAGE}],
      onNative: host(HW),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(100);
    expect(bg.native.filter((m) => m.type === 'status')).toEqual([]);
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV');
  });

  it('shows nothing about a decoder when the hand-off failed', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true},
      tabs: [{id: 1, url: PAGE}],
      onNative: (message) => message.type === 'status' ? {ok: true, running: true, decoder: HW} :
        {ok: false, error: 'mpv executable not found', hostVersion: RequiredHostVersion},
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(100);
    expect(bg.native.filter((m) => m.type === 'status')).toEqual([]);
    expect(bg.titles.get(1)).toBe('FastStream - MPV - the stream did not open: mpv executable not found');
  });

  it('adds the decoder to "Test mpv connection" when an mpv of the host\'s is open', async () => {
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      onNative: (message) => message.type === 'ping' ? {ok: true, mpv: true, path: 'C:/mpv/mpv.exe', hostVersion: RequiredHostVersion} :
        {ok: true, running: true, decoder: {hardware: false, api: 'no', format: 'hevc', width: 3840, height: 2160}, hostVersion: RequiredHostVersion},
    });
    const answer = await bg.message({type: 'MPV_TEST'}, {});
    expect(answer).toMatchObject({ok: true, mpv: true, path: 'C:/mpv/mpv.exe',
      decoder: {hardware: false, api: 'no', format: 'hevc'}, decoderText: 'HEVC 3840x2160'});
    expect(bg.native.find((m) => m.type === 'status')).toEqual({type: 'status', waitMs: 0});
  });
});
