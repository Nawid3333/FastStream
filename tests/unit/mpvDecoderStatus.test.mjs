import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MaxStatusWaitMs, MpvBackend, RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {loadBackground} from './backgroundHarness.mjs';

// "Is mpv on my GPU?" FastStream never sets mpv's hardware decoding (mpv.conf is the
// user's); it asks the mpv the host started which decoder it uses (hwdec-current over the
// single-instance pipe) and says so: on the toolbar button's tooltip after a hand-off (the relay
// observes it), and in "Test mpv connection" (an ipc question). In software it adds a hint, nothing more.

const success = (data) => ({error: 'success', data});
const unavailable = {error: 'property unavailable'};

describe('the extension reading mpv\'s decoder', () => {
  // The helper answers in the commands' order (DecoderProperties).
  it('reads the hardware API, the format and the size', () => {
    expect(MpvBackend.decoderFromReplies([success('d3d11va'), success('auto-safe'), success('av1'), success(1920), success(1080)]))
        .toEqual({hardware: true, api: 'd3d11va', requested: 'auto-safe', format: 'av1', width: 1920, height: 1080});
  });

  it('reads "no" as software', () => {
    expect(MpvBackend.decoderFromReplies([success('no'), success('no'), success('h264'), success(1280), success(720)]))
        .toEqual({hardware: false, api: 'no', requested: 'no', format: 'h264', width: 1280, height: 720});
  });

  it('counts a copy-back API as hardware', () => {
    expect(MpvBackend.decoderFromReplies([success('d3d11va-copy')]))
        .toEqual({hardware: true, api: 'd3d11va-copy', requested: null, format: null, width: null, height: null});
  });

  it('has no decoder while mpv has none loaded, or names none', () => {
    expect(MpvBackend.decoderFromReplies([unavailable, success('auto-safe')])).toBe(null);
    expect(MpvBackend.decoderFromReplies([])).toBe(null);
    expect(MpvBackend.decoderFromReplies(undefined)).toBe(null);
    expect(MpvBackend.decoderFromReplies([success(''), success('auto')])).toBe(null);
    expect(MpvBackend.decoderFromReplies([success(5)])).toBe(null);
    expect(MpvBackend.decoderFromReplies([null, 5])).toBe(null);
  });

  it('leaves out what mpv did not give, or gave as no size', () => {
    expect(MpvBackend.decoderFromReplies([success('vulkan'), unavailable, unavailable, success(-1), success('x')]))
        .toEqual({hardware: true, api: 'vulkan', requested: null, format: null, width: null, height: null});
    // A reply without an error is mpv's value too.
    expect(MpvBackend.decoderFromReplies([{data: 'nvdec'}, success(null), success(''), success(Infinity), success(2160.5)]))
        .toEqual({hardware: true, api: 'nvdec', requested: null, format: null, width: null, height: 2160.5});
  });

  it('checks what mpv says before it reaches the toolbar', () => {
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

// The extension asks mpv's properties through the helper's ipc primitive.
describe('the extension asking the helper', () => {
  const Current = {hostVersion: RequiredHostVersion};
  const COMMANDS = ['hwdec-current', 'hwdec', 'video-format', 'width', 'height'].map((name) => ['get_property', name]);
  const answers = (...values) => ({ok: true, ...Current, replies: values.map((data) =>
    data === undefined ? unavailable : success(data))});

  afterEach(() => {
    delete globalThis.chrome;
    vi.useRealTimers();
  });

  /**
   * A helper that answers ipc messages from a list, the last one again.
   * @param {Array<Object>} list - Its answers, in order.
   * @return {Array<Object>} What it was sent.
   */
  const helper = (list) => {
    const sent = [];
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendNativeMessage(name, message, callback) {
          sent.push(message);
          callback(list[Math.min(sent.length - 1, list.length - 1)]);
        },
      },
    };
    return sent;
  };

  it('asks mpv\'s decoder properties over ipc, and reads them by their order', async () => {
    const sent = helper([answers('d3d11va', 'auto-safe', 'av1', 1920, 1080)]);
    expect(await new MpvBackend().decoderStatus(20000)).toEqual({ok: true, running: true,
      decoder: {hardware: true, api: 'd3d11va', format: 'av1', width: 1920, height: 1080}});
    expect(sent).toEqual([{type: 'ipc', commands: COMMANDS}]);
  });

  it('asks once a second while mpv opens the stream, then answers', async () => {
    vi.useFakeTimers();
    const sent = helper([answers(undefined), {ok: false, busy: true, error: 'mpv did not answer', ...Current},
      answers('vaapi', 'auto-safe', 'hevc', 3840, 2160)]);
    const status = new MpvBackend().decoderStatus(20000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await status).toEqual({ok: true, running: true,
      decoder: {hardware: true, api: 'vaapi', format: 'hevc', width: 3840, height: 2160}});
    expect(sent).toHaveLength(3);
  });

  it('gives up after the wait with mpv running and no decoder yet, and never waits past the cap', async () => {
    vi.useFakeTimers();
    let sent = helper([answers(undefined)]);
    let status = new MpvBackend().decoderStatus(5000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await status).toEqual({ok: true, running: true, decoder: null});
    // Once a second, the last time at the deadline.
    expect(sent).toHaveLength(6);
    sent = helper([answers(undefined)]);
    status = new MpvBackend().decoderStatus(Infinity);
    await vi.advanceTimersByTimeAsync(60000);
    await status;
    expect(sent).toHaveLength(MaxStatusWaitMs / 1000 + 1);
    sent = helper([answers(undefined)]);
    await new MpvBackend().decoderStatus();
    expect(sent).toHaveLength(1);
  });

  it('says no mpv of the helper\'s is open when nothing answers on its pipe', async () => {
    helper([{ok: false, error: 'no mpv ipc', ...Current}]);
    expect(await new MpvBackend().decoderStatus(20000)).toEqual({ok: true, running: false, decoder: null});
  });

  it('takes a refusal of the helper for no answer, without asking again', async () => {
    const sent = helper([{ok: false, error: 'refused', index: 0, ...Current}]);
    expect((await new MpvBackend().decoderStatus(20000)).ok).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('takes no answer of an outdated helper, and asks it nothing more', async () => {
    const sent = helper([{...answers('d3d11va'), hostVersion: RequiredHostVersion - 1}]);
    const backend = new MpvBackend();
    expect(await backend.decoderStatus(20000)).toMatchObject({ok: false, hostOutdated: true});
    expect(await backend.decoderStatus(20000)).toMatchObject({ok: false, hostOutdated: true});
    expect(sent).toHaveLength(1);
  });

  it('reports a host the browser could not start', async () => {
    globalThis.chrome = {runtime: {lastError: undefined, sendNativeMessage(name, message, callback) {
      globalThis.chrome.runtime.lastError = {message: 'no such native application'};
      callback(undefined);
      globalThis.chrome.runtime.lastError = undefined;
    }}};
    expect(await new MpvBackend().decoderStatus()).toEqual({ok: false, error: 'no such native application'});
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

  it('puts a failed hand-off first, an outdated host\'s too', () => {
    const decoder = {hardware: false, api: 'no', format: 'h264', width: 1280, height: 720};
    BackgroundUtils.updateTabIcon(tab({mpvDecoder: decoder, mpvError: 'mpv executable not found'}));
    expect(calls.title.title).toBe('FastStream - MPV - the stream did not open: mpv executable not found');
    BackgroundUtils.updateTabIcon(tab({mpvDecoder: decoder, mpvError: 'The mpv helper on this computer is out of date',
      mpvHostOutdated: true}));
    expect(calls.title.title).toMatch(/out of date/);
  });
});

describe('the background after a hand-off', () => {
  const PAGE = 'https://site.test/watch/1';
  const EPISODE = 'https://cdn.test/episode/master.m3u8';
  const HW_TITLE = 'FastStream - Playing in MPV - decoded by the graphics card: d3d11va, AV1 1920x1080';
  let bg;

  afterEach(() => {
    bg?.unload();
    bg = null;
    vi.restoreAllMocks();
  });

  /**
   * mpv opens the stream: the relay passes on its decoder as mpv tells it.
   * @param {Object} port - The watch's port.
   */
  const decodes = (port) => {
    for (const [id, name, data] of [[10, 'hwdec-current', 'd3d11va'], [11, 'hwdec', 'auto-safe'], [12, 'video-format', 'av1'],
      [13, 'width', 1920], [14, 'height', 1080]]) {
      port.emit({type: 'mpv', data: {event: 'property-change', id, name, data}});
    }
  };

  it('shows mpv\'s decoder as the relay tells it, also after the event page restarted', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true},
      tabs: [{id: 1, url: PAGE}],
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    decodes(bg.ports.at(-1));
    await bg.wait(100);
    // Asked over the relay, not with a helper process a second.
    expect(bg.native.filter((m) => m.type === 'ipc')).toEqual([]);
    expect(bg.titles.get(1)).toBe(HW_TITLE);
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}], session});
    expect(bg.titles.get(1)).toBe(HW_TITLE);
  });

  it('forgets it on the next page', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true},
      tabs: [{id: 1, url: PAGE}],
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    decodes(bg.ports.at(-1));
    await bg.wait(100);
    await bg.navigated(1, 'https://site.test/watch/2');
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV');
  });

  it('does not follow an mpv started without the pipe (single instance off)', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: false},
      tabs: [{id: 1, url: PAGE}],
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(100);
    expect(bg.ports).toEqual([]);
    expect(bg.native.map((m) => m.type)).toEqual(['ping', 'play']);
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV');
  });

  it('shows nothing about a decoder when the hand-off failed', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true},
      tabs: [{id: 1, url: PAGE}],
      onNative: (message) => message.type === 'play' ? {ok: false, error: 'mpv executable not found'} : {ok: true},
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(100);
    expect(bg.ports).toEqual([]);
    expect(bg.titles.get(1)).toBe('FastStream - MPV - the stream did not open: mpv executable not found');
  });

  it('adds the decoder to "Test mpv connection" when an mpv of the host\'s is open', async () => {
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      onNative: (message) => message.type === 'ping' ? {ok: true, mpv: true, path: 'C:/mpv/mpv.exe'} :
        {ok: true, replies: [success('no'), success('auto-safe'), success('hevc'), success(3840), success(2160)]},
    });
    const answer = await bg.message({type: 'MPV_TEST'}, {});
    expect(answer).toMatchObject({ok: true, mpv: true, path: 'C:/mpv/mpv.exe',
      decoder: {hardware: false, api: 'no', format: 'hevc'}, decoderText: 'HEVC 3840x2160'});
    expect(bg.native.find((m) => m.type === 'ipc')).toEqual({type: 'ipc',
      commands: ['hwdec-current', 'hwdec', 'video-format', 'width', 'height'].map((name) => ['get_property', name])});
  });

  it('leaves the decoder out of "Test mpv connection" for an outdated host, which it says is outdated', async () => {
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      onNative: () => ({ok: true, mpv: true, path: 'C:/mpv/mpv.exe', hostVersion: RequiredHostVersion - 1}),
    });
    const answer = await bg.message({type: 'MPV_TEST'}, {});
    expect(answer).toEqual({ok: true, mpv: true, path: 'C:/mpv/mpv.exe', hostOutdated: true});
    expect(bg.native.map((m) => m.type)).toEqual(['ping']);
  });
});
