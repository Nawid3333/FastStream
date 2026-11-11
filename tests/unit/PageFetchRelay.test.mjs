import {describe, expect, it, vi} from 'vitest';
import {relayPageFetch} from '../../chrome/background/PageFetchRelay.mjs';
import {PAGE_PORT_NAME, RELAY_PORT_PREFIX} from '../../chrome/player/network/PageFetch.mjs';

// The background joins a player's port to its page's frame (the player's iframe has no tabs API in
// Firefox): only for this extension's own pages, only into the player's own tab, every message
// passed on as it is, and either side going ends both.

const ENV = {extensionId: 'fs-id', extensionUrl: 'moz-extension://fs/'};

/** A port: what was posted on it, and its other end's doings. */
function fakePort(name, sender) {
  const messageListeners = [];
  const disconnectListeners = [];
  const port = {
    name, sender, posted: [], disconnected: false,
    postMessage: vi.fn((msg) => port.posted.push(msg)),
    disconnect: vi.fn(() => {
      port.disconnected = true;
    }),
    onMessage: {addListener: (fn) => messageListeners.push(fn)},
    onDisconnect: {addListener: (fn) => disconnectListeners.push(fn)},
    receive: (msg) => messageListeners.forEach((fn) => fn(msg)),
    gone: () => disconnectListeners.forEach((fn) => fn()),
  };
  return port;
}

const PLAYER = {id: 'fs-id', url: 'moz-extension://fs/player/index.html', tab: {id: 4}, frameId: 9};

/** A player's port relayed; the page's port the background opened. */
function relayed(name = RELAY_PORT_PREFIX + '2', sender = PLAYER) {
  const player = fakePort(name, sender);
  let page = null;
  const connectTab = vi.fn((tabId, info) => (page = fakePort(info.name, {id: 'fs-id'})));
  const taken = relayPageFetch(player, {...ENV, connectTab});
  return {player, page, connectTab, taken};
}

describe('relayPageFetch', () => {
  it('joins the player to the named frame of its own tab, both ways', () => {
    const {player, page, connectTab, taken} = relayed();
    expect(taken).toBe(true);
    expect(connectTab).toHaveBeenCalledWith(4, {frameId: 2, name: PAGE_PORT_NAME});
    player.receive({id: 1, url: 'https://cdn.example/v.mp4'});
    expect(page.posted).toEqual([{id: 1, url: 'https://cdn.example/v.mp4'}]);
    const chunk = new Uint8Array([1, 2]);
    page.receive({id: 1, chunk});
    expect(player.posted).toEqual([{id: 1, chunk}]);
  });

  it('ends both when either goes', () => {
    const a = relayed();
    a.page.gone();
    expect(a.player.disconnected).toBe(true);
    a.page.receive({id: 1, done: true});
    expect(a.player.posted).toEqual([]);

    const b = relayed();
    b.player.gone();
    expect(b.page.disconnected).toBe(true);
  });

  it('leaves other ports alone', () => {
    const {taken, connectTab, player} = relayed('something-else');
    expect(taken).toBe(false);
    expect(connectTab).not.toHaveBeenCalled();
    expect(player.disconnected).toBe(false);
  });

  it('refuses a web page, another extension, a sender without a tab, and a frame that is none', () => {
    for (const [name, sender] of [
      [RELAY_PORT_PREFIX + '2', {...PLAYER, url: 'https://evil.example/'}],
      [RELAY_PORT_PREFIX + '2', {...PLAYER, id: 'other'}],
      [RELAY_PORT_PREFIX + '2', {...PLAYER, tab: undefined}],
      [RELAY_PORT_PREFIX + 'x', PLAYER],
      [RELAY_PORT_PREFIX + '-1', PLAYER],
      [RELAY_PORT_PREFIX + '9', PLAYER],
    ]) {
      const {taken, connectTab, player} = relayed(name, sender);
      expect(taken, JSON.stringify([name, sender])).toBe(true);
      expect(connectTab).not.toHaveBeenCalled();
      expect(player.disconnected).toBe(true);
    }
  });

  it('closes the player\'s port when the frame cannot be reached', () => {
    const player = fakePort(RELAY_PORT_PREFIX + '2', PLAYER);
    relayPageFetch(player, {...ENV, connectTab: () => {
      throw new Error('Invalid tab ID');
    }});
    expect(player.disconnected).toBe(true);
  });
});
