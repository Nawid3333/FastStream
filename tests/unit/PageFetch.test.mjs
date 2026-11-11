import vm from 'node:vm';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {PageFetch, PageFetchChannel} from '../../chrome/player/network/PageFetch.mjs';

// The player's side of loading through the page (page-fetch.js answers in the page): a port to
// the page's frame, a request's answer given back as a real Response whose body streams in as
// the page reads it, and the hosts loaded that way from then on (#665).

/** A port like tabs.connect's: what the player posts, and the page's side to answer with. */
function fakePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  const port = {
    posted: [],
    postMessage: vi.fn((msg) => port.posted.push(msg)),
    disconnect: vi.fn(() => {}),
    onMessage: {addListener: (fn) => messageListeners.push(fn)},
    onDisconnect: {addListener: (fn) => disconnectListeners.push(fn)},
    /** The page answers. */
    answer: (msg) => messageListeners.forEach((fn) => fn(msg)),
    /** The page goes. */
    gone: () => disconnectListeners.forEach((fn) => fn()),
  };
  return port;
}

/** Lets the promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PageFetchChannel', () => {
  it('gives the page\'s answer as a Response, its body as it comes, its URL the page\'s', async () => {
    const port = fakePort();
    const channel = new PageFetchChannel(() => port);
    const pending = channel.fetch('https://cdn.example/v.mp4', {headers: {Range: 'bytes=0-5'}, priority: 'high'});
    expect(port.posted).toEqual([{id: 1, url: 'https://cdn.example/v.mp4', headers: {Range: 'bytes=0-5'}, priority: 'high'}]);

    port.answer({id: 1, status: 206, statusText: 'Partial Content', url: 'https://cdn.example/final.mp4',
      headers: {'content-range': 'bytes 0-5/10', 'content-type': 'video/mp4'}});
    const response = await pending;
    expect(response.status).toBe(206);
    expect(response.url).toBe('https://cdn.example/final.mp4');
    expect(response.headers.get('content-range')).toBe('bytes 0-5/10');

    port.answer({id: 1, chunk: new Uint8Array([1, 2, 3])});
    port.answer({id: 1, chunk: new Uint8Array([4, 5, 6])});
    port.answer({id: 1, done: true});
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('takes the pieces of another realm (a port\'s message is one: instanceof Uint8Array is false)', async () => {
    const port = fakePort();
    const channel = new PageFetchChannel(() => port);
    const pending = channel.fetch('https://cdn.example/v.mp4');
    port.answer({id: 1, status: 200, headers: {}});
    const response = await pending;
    const foreign = vm.runInNewContext('new Uint8Array([9, 8, 7, 6]).subarray(1)');
    expect(foreign instanceof Uint8Array).toBe(false);
    port.answer({id: 1, chunk: foreign});
    port.answer({id: 1, done: true});
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([8, 7, 6]);
  });

  it('rejects when the page cannot load it, as fetch() does for a network error', async () => {
    const port = fakePort();
    const channel = new PageFetchChannel(() => port);
    const pending = channel.fetch('https://cdn.example/v.mp4');
    port.answer({id: 1, error: 'NetworkError when attempting to fetch resource.'});
    await expect(pending).rejects.toThrow(TypeError);
  });

  it('breaks the body off when the page fails after the head', async () => {
    const port = fakePort();
    const channel = new PageFetchChannel(() => port);
    const pending = channel.fetch('https://cdn.example/v.mp4');
    port.answer({id: 1, status: 200, headers: {}});
    const response = await pending;
    port.answer({id: 1, chunk: new Uint8Array([1])});
    port.answer({id: 1, error: 'connection reset'});
    await expect(response.arrayBuffer()).rejects.toThrow('connection reset');
  });

  it('tells the page to stop an aborted request, and rejects with an AbortError', async () => {
    const port = fakePort();
    const channel = new PageFetchChannel(() => port);
    const controller = new AbortController();
    const pending = channel.fetch('https://cdn.example/v.mp4', {signal: controller.signal});
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(port.posted).toContainEqual({abort: 1});
    // A late answer to it changes nothing.
    port.answer({id: 1, status: 200, headers: {}});
  });

  it('tells the page to stop a request whose head came too late, and keeps no listener of an ended one', async () => {
    vi.useFakeTimers();
    try {
      const port = fakePort();
      const channel = new PageFetchChannel(() => port);
      const controller = new AbortController();
      const removed = vi.spyOn(controller.signal, 'removeEventListener');
      const late = channel.fetch('https://cdn.example/late.mp4', {signal: controller.signal});
      vi.advanceTimersByTime(30000);
      await expect(late).rejects.toThrow('The page did not answer');
      expect(port.posted).toContainEqual({abort: 1});
      expect(removed).toHaveBeenCalledTimes(1);

      // Ended by its end: its listener goes, and a later abort tells the page nothing.
      const done = channel.fetch('https://cdn.example/v.mp4', {signal: controller.signal});
      port.answer({id: 2, status: 200, headers: {}});
      const response = await done;
      port.answer({id: 2, done: true});
      await response.arrayBuffer();
      expect(removed).toHaveBeenCalledTimes(2);
      controller.abort();
      expect(port.posted).not.toContainEqual({abort: 2});
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the page\'s reading when the body is cancelled', async () => {
    const port = fakePort();
    const channel = new PageFetchChannel(() => port);
    const pending = channel.fetch('https://cdn.example/v.mp4');
    port.answer({id: 1, status: 200, headers: {}});
    const response = await pending;
    await response.body.cancel();
    expect(port.posted).toContainEqual({abort: 1});
  });

  it('fails every request on a page that goes, and connects again for the next', async () => {
    const ports = [fakePort(), fakePort()];
    let opened = 0;
    const channel = new PageFetchChannel(() => ports[opened++]);
    const first = channel.fetch('https://cdn.example/a.mp4');
    const second = channel.fetch('https://cdn.example/b.mp4');
    expect(opened).toBe(1);
    ports[0].gone();
    await expect(first).rejects.toThrow('The page is gone');
    await expect(second).rejects.toThrow('The page is gone');

    const third = channel.fetch('https://cdn.example/c.mp4');
    expect(opened).toBe(2);
    ports[1].answer({id: 3, status: 200, headers: {}});
    expect((await third).status).toBe(200);
  });

  it('gives an answer without a body (204) without the constructor throwing', async () => {
    const port = fakePort();
    const channel = new PageFetchChannel(() => port);
    const pending = channel.fetch('https://cdn.example/v.mp4');
    port.answer({id: 1, status: 204, headers: {}});
    const response = await pending;
    expect(response.status).toBe(204);
    expect(response.body).toBe(null);
  });

  it('rejects at once when the port cannot be opened', async () => {
    const channel = new PageFetchChannel(() => {
      throw new Error('Could not establish connection');
    });
    await expect(channel.fetch('https://cdn.example/v.mp4')).rejects.toThrow('No page to load through');
  });
});

describe('PageFetch (the player\'s routes)', () => {
  afterEach(() => {
    PageFetch.configure(null);
  });

  it('has no page to load through until one is configured', async () => {
    PageFetch.configure(null);
    expect(PageFetch.available()).toBe(false);
    PageFetch.route('https://cdn.example/v.mp4');
    expect(PageFetch.routes('https://cdn.example/v.mp4')).toBe(false);
    await expect(PageFetch.fetch('https://cdn.example/v.mp4')).rejects.toThrow('No page');
  });

  it('routes a host through its page once told, and forgets it for another page', async () => {
    const connect = vi.fn(() => fakePort());
    PageFetch.configure({tabId: 4, frameId: 2}, connect);
    expect(PageFetch.available()).toBe(true);
    expect(PageFetch.routes('https://cdn.example/a.mp4')).toBe(false);
    PageFetch.route('https://cdn.example/a.mp4');
    expect(PageFetch.routes('https://cdn.example/other/b.mp4')).toBe(true);
    expect(PageFetch.routes('https://elsewhere.example/a.mp4')).toBe(false);

    PageFetch.fetch('https://cdn.example/a.mp4').catch(() => {});
    expect(connect).toHaveBeenCalledWith(4, 2);

    PageFetch.configure({tabId: 4, frameId: 3}, connect);
    expect(PageFetch.routes('https://cdn.example/a.mp4')).toBe(false);
    await settle();
  });

  it('starts each source with no routes, and keeps the port to the same frame', async () => {
    // Another episode's links may load directly: its host proves again that only the page gets it.
    const port = fakePort();
    const connect = vi.fn(() => port);
    PageFetch.configure({tabId: 1, frameId: 0}, connect);
    PageFetch.route('https://cdn.example/a.mp4');
    PageFetch.fetch('https://cdn.example/a.mp4').catch(() => {});
    PageFetch.configure({tabId: 1, frameId: 0}, connect);
    expect(PageFetch.routes('https://cdn.example/a.mp4')).toBe(false);
    PageFetch.fetch('https://cdn.example/b.mp4').catch(() => {});
    expect(connect).toHaveBeenCalledTimes(1);
    expect(port.disconnect).not.toHaveBeenCalled();
    await settle();
  });

  it('loads a host directly again once unrouted', () => {
    PageFetch.configure({tabId: 1, frameId: 0}, () => fakePort());
    PageFetch.route('https://cdn.example/a.mp4');
    PageFetch.unroute('https://cdn.example/b.mp4');
    expect(PageFetch.routes('https://cdn.example/a.mp4')).toBe(false);
  });

  it('takes no page for a tab or frame that is none', () => {
    PageFetch.configure({tabId: -1, frameId: 0}, () => fakePort());
    expect(PageFetch.available()).toBe(false);
    PageFetch.configure({tabId: 3, frameId: undefined}, () => fakePort());
    expect(PageFetch.available()).toBe(false);
  });
});
