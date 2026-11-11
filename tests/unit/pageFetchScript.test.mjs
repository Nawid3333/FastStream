import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {describe, expect, it, vi} from 'vitest';

// page-fetch.js, the page's side of loading through the page (PageFetch.mjs is the player's, the
// background joins the two: PageFetchRelay.mjs): whom it answers, which headers it lets a request
// name, and how it streams an answer back (#665). Run in a context of its own with stand-ins for
// chrome.runtime and fetch.

const source = readFileSync(new URL('../../chrome/page-fetch.js', import.meta.url), 'utf8');
const EXTENSION = 'moz-extension://faststream-id/';

/**
 * Loads the script on a stand-in page.
 * @param {{fetch?: Function}} [page]
 */
function loadPageFetch(page = {}) {
  const onConnect = [];
  const fetch = vi.fn(page.fetch || (async () => new Response('')));
  const context = vm.createContext({
    URL, AbortController, AbortSignal, Response, fetch,
    location: {href: 'https://player.example/embed/1'},
    chrome: {runtime: {
      id: 'faststream-id',
      getURL: (path) => EXTENSION + path,
      onConnect: {addListener: (fn) => onConnect.push(fn)},
    }},
  });
  vm.runInContext(source, context, {filename: 'chrome/page-fetch.js'});

  /** Opens a port as the background's tabs.connect would. */
  const connect = (sender = {id: 'faststream-id', url: EXTENSION + '_generated_background_page.html'}, name = 'faststream-page-fetch') => {
    const messageListeners = [];
    const disconnectListeners = [];
    const port = {
      name, sender, received: [], disconnected: false,
      postMessage: (msg) => port.received.push(msg),
      disconnect: () => {
        port.disconnected = true;
      },
      onMessage: {addListener: (fn) => messageListeners.push(fn)},
      onDisconnect: {addListener: (fn) => disconnectListeners.push(fn)},
      send: (msg) => messageListeners.forEach((fn) => fn(msg)),
      close: () => disconnectListeners.forEach((fn) => fn()),
    };
    onConnect.forEach((fn) => fn(port));
    return port;
  };
  return {fetch, connect};
}

/** Waits until the port has a message that ends request `id`. */
async function finished(port, id) {
  await vi.waitFor(() => {
    if (!port.received.some((m) => m.id === id && (m.done || m.error))) throw new Error('not yet');
  });
  return port.received.filter((m) => m.id === id);
}

describe('page-fetch.js', () => {
  it('streams the page\'s answer back: head, pieces, done', async () => {
    const page = loadPageFetch({fetch: async () => new Response(new Uint8Array([1, 2, 3]),
        {status: 206, headers: {'content-range': 'bytes 0-2/9', 'content-type': 'video/mp4'}})});
    const port = page.connect();
    port.send({id: 1, url: 'https://cdn.example/v.mp4', headers: {Range: 'bytes=0-2'}, priority: 'high'});
    const messages = await finished(port, 1);
    expect(messages[0]).toMatchObject({id: 1, status: 206, headers: {'content-range': 'bytes 0-2/9', 'content-type': 'video/mp4'}});
    expect(messages.filter((m) => m.chunk).flatMap((m) => Array.from(m.chunk))).toEqual([1, 2, 3]);
    expect(messages.at(-1)).toEqual({id: 1, done: true});
    const [url, init] = page.fetch.mock.calls[0];
    expect(url).toBe('https://cdn.example/v.mp4');
    expect(init).toMatchObject({credentials: 'include', cache: 'no-store', priority: 'high', headers: {Range: 'bytes=0-2'}});
  });

  it('lets a request name only Range, Accept and If-Range: the rest are the page\'s own', async () => {
    const page = loadPageFetch();
    const port = page.connect();
    port.send({id: 1, url: 'https://cdn.example/v.mp4', headers: {'Range': 'bytes=0-', 'Accept': '*/*', 'If-Range': 'x',
      'Cookie': 'a=b', 'Referer': 'https://evil.example/', 'Origin': 'https://evil.example', 'X-Any': '1'}});
    await finished(port, 1);
    expect(page.fetch.mock.calls[0][1].headers).toEqual({'Range': 'bytes=0-', 'Accept': '*/*', 'If-Range': 'x'});
    expect(page.fetch.mock.calls[0][1].priority).toBe('auto');
  });

  it('opens no port for a web page or another extension, nor under another name', () => {
    const page = loadPageFetch();
    expect(page.connect({id: 'other-extension', url: 'moz-extension://other/x.html'}).disconnected).toBe(true);
    expect(page.connect({id: 'faststream-id', url: 'https://player.example/embed/1'}).disconnected).toBe(true);
    expect(page.connect({id: 'faststream-id'}).disconnected).toBe(true);
    const other = page.connect(undefined, 'another-port');
    other.send({id: 1, url: 'https://cdn.example/v.mp4'});
    expect(other.disconnected).toBe(false);
    expect(page.fetch).not.toHaveBeenCalled();
  });

  it('loads nothing but http(s)', async () => {
    const page = loadPageFetch();
    const port = page.connect();
    port.send({id: 1, url: 'file:///C:/secret.txt'});
    port.send({id: 2, url: 'http://[bad'});
    expect(port.received).toEqual([{id: 1, error: 'Not an http(s) URL'}, {id: 2, error: 'Invalid URL'}]);
    expect(page.fetch).not.toHaveBeenCalled();
  });

  it('stops a request when told to, and every request when the port closes', async () => {
    const signals = [];
    const page = loadPageFetch({fetch: (url, init) => new Promise((resolve, reject) => {
      signals.push(init.signal);
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })});
    const port = page.connect();
    port.send({id: 1, url: 'https://cdn.example/a.mp4'});
    port.send({id: 2, url: 'https://cdn.example/b.mp4'});
    port.send({abort: 1});
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(await finished(port, 1)).toEqual([{id: 1, error: 'AbortError'}]);
    port.close();
    expect(signals[1].aborted).toBe(true);
  });

  it('sends a network failure as the request\'s error', async () => {
    const page = loadPageFetch({fetch: async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    }});
    const port = page.connect();
    port.send({id: 1, url: 'https://cdn.example/v.mp4'});
    expect(await finished(port, 1)).toEqual([{id: 1, error: 'NetworkError when attempting to fetch resource.'}]);
  });

  it('keeps the fragment a Response\'s URL drops, and tells where a redirect ended', async () => {
    // A service worker may need the fragment (abyss.to's: #mp4/<video>/<quality>).
    const answer = (url) => async () => Object.defineProperty(new Response(new Uint8Array(8)), 'url', {value: url});
    const same = loadPageFetch({fetch: answer('https://player.example/')});
    const port = same.connect();
    port.send({id: 1, url: 'https://player.example/#mp4/abc/720'});
    expect((await finished(port, 1))[0].url).toBe('https://player.example/#mp4/abc/720');

    const moved = loadPageFetch({fetch: answer('https://cdn.example/final.mp4')});
    const other = moved.connect();
    other.send({id: 1, url: 'https://player.example/v.mp4'});
    expect((await finished(other, 1))[0].url).toBe('https://cdn.example/final.mp4');
  });
});
