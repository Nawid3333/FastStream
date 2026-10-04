// The web player's embed API takes commands only from the page that embeds it (#218).
// EmbedAPI.mjs reads `window` when it loads, so a stand-in window is set up first, with
// stand-ins for the windows around the player: the page that embeds it (parent), one that
// opened it (opener), and another frame of that page, an ad, say (sibling).
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * A window that records what is posted to it.
 * @return {{posted: Array<{message: Object, target: string}>, postMessage: function}}
 */
function fakeWindow() {
  const win = {posted: []};
  win.postMessage = (message, target) => win.posted.push({message, target});
  return win;
}

const parent = fakeWindow();
const opener = fakeWindow();
const sibling = fakeWindow();
const self = {
  parent,
  opener,
  AudioContext: class {},
  addEventListener: () => {},
  removeEventListener: () => {},
};
let EmbedAPI;

beforeAll(async () => {
  vi.stubGlobal('window', self);
  ({EmbedAPI} = await import('../../chrome/player/modules/EmbedAPI.mjs'));
});

/**
 * A player with a source whose address carries a token.
 * @return {Object}
 */
function fakeClient() {
  return {
    version: '1.0',
    source: {url: 'https://cdn.example/video.m3u8?token=secret', mode: 'accelerated_hls', identifier: 'video-id'},
    currentVideo: null,
    state: {},
    paused: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    playbackRate: 1,
    // A player is there: pause does nothing without one.
    player: {},
    interfaceController: {volumeControls: {muted: false, on: () => {}}, isInPip: () => false},
    getCurrentVideoLevelID: () => 0,
    getCurrentAudioLevelID: () => 0,
    needsUserInteraction: () => false,
    on: () => {},
    pause: vi.fn(async () => {}),
  };
}

/**
 * A command as a window would post it.
 * @param {Object} source - The window it comes from.
 * @param {string} origin - The origin it comes from.
 * @param {string} command - The command.
 * @return {Object} The message event.
 */
function command(source, origin, command) {
  return {source, origin, data: {type: 'faststream:command', id: command, command}};
}

const responses = (win) => win.posted.filter((p) => p.message.type === 'faststream:response');

describe('EmbedAPI, who it takes commands from (#218)', () => {
  let client;
  let api;

  beforeEach(() => {
    for (const win of [parent, opener, sibling]) win.posted.length = 0;
    self.opener = opener;
    client = fakeClient();
    api = new EmbedAPI(client);
  });
  afterEach(() => api.destroy());

  it('answers the page that embeds it, with what is playing', async () => {
    await api.handleMessage(command(parent, 'https://site.example', 'getState'));
    expect(responses(parent)).toHaveLength(1);
    const {message, target} = responses(parent)[0];
    expect(target).toBe('https://site.example');
    expect(message.ok).toBe(true);
    expect(message.result.source.url).toBe('https://cdn.example/video.m3u8?token=secret');
  });

  it('answers the window that opened it', async () => {
    await api.handleMessage(command(opener, 'https://site.example', 'getState'));
    expect(responses(opener)).toHaveLength(1);
  });

  it('gives another frame of the page nothing, and does not do what it asks', async () => {
    await api.handleMessage(command(sibling, 'https://ads.example', 'getState'));
    await api.handleMessage(command(sibling, 'https://ads.example', 'pause'));
    await api.handleMessage(command(sibling, 'https://ads.example', 'subscribe'));
    expect(sibling.posted).toEqual([]);
    expect(client.pause).not.toHaveBeenCalled();
    expect(api.subscribers).toEqual([]);
  });

  it('takes nothing from its own window', async () => {
    await api.handleMessage(command(self, 'https://player.example', 'pause'));
    expect(client.pause).not.toHaveBeenCalled();
  });

  it('keeps the origin a window first sent from: the opener gone to another site gets nothing', async () => {
    await api.handleMessage(command(opener, 'https://site.example', 'getState'));
    await api.handleMessage(command(opener, 'https://elsewhere.example', 'getState'));
    await api.handleMessage(command(opener, 'https://elsewhere.example', 'pause'));
    expect(responses(opener).map((p) => p.target)).toEqual(['https://site.example']);
    expect(client.pause).not.toHaveBeenCalled();
    // The page that embeds it pins its own origin.
    await api.handleMessage(command(parent, 'https://other-site.example', 'getState'));
    expect(responses(parent)).toHaveLength(1);
  });

  it('announces itself without the address or identifier of what is playing', () => {
    api.announce();
    for (const win of [parent, opener]) {
      expect(win.posted).toHaveLength(1);
      const {message, target} = win.posted[0];
      expect(target).toBe('*');
      expect(message.event).toBe('ready');
      expect(message.state.source).toEqual({mode: 'accelerated_hls'});
      expect(JSON.stringify(message)).not.toContain('token=secret');
    }
  });
});
