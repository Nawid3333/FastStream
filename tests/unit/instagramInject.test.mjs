import vm from 'node:vm';
import {describe, expect, it} from 'vitest';

// The script's text, as a module of this repository (vite's ?raw), not a file read at run
// time: running what a read returned is CodeQL's js/code-injection (local sources).
import source from '../../chrome/custom/instagram_inject.js?raw';

// instagram_inject.js runs in Instagram's page and reads every XHR response for a
// video_dash_manifest. A response with the key but only empty values (media still being
// processed), or one that is not an object at all, threw a TypeError inside the page's
// own XHR handling, before the guard written for it.

/**
 * Runs the script against a stand-in XMLHttpRequest, and the page's fetch.
 * @param {function(...*): Promise<Response>} [fetch] - The page's fetch.
 * @return {{posted: Array<Object>, errors: Array<Array<*>>, respond: function(string): void,
 *   window: {fetch: function(...*): Promise<Response>}}}
 */
function load(fetch) {
  const posted = [];
  const errors = [];
  class FakeXHR {
    constructor() {
      this.listeners = [];
      this.readyState = 0;
      this.responseType = '';
      this.responseText = '';
    }
    open() {}
    addEventListener(type, listener) {
      if (type === 'readystatechange') this.listeners.push(listener);
    }
  }
  const context = {
    XMLHttpRequest: FakeXHR,
    window: {postMessage: (data) => posted.push(data), fetch},
    console: {error: (...args) => errors.push(args), log() {}},
  };
  vm.runInNewContext(source, context);
  return {
    posted,
    errors,
    window: context.window,
    respond(text) {
      const xhr = new context.XMLHttpRequest();
      xhr.open('GET', '/graphql');
      xhr.readyState = 4;
      xhr.responseText = text;
      for (const listener of xhr.listeners) listener({});
    },
  };
}

describe('instagram_inject.js', () => {
  it('posts the first manifest that has a value', () => {
    const page = load();
    page.respond(JSON.stringify({a: {video_dash_manifest: ''}, b: [{video_dash_manifest: '<MPD/>'}]}));
    expect(page.posted).toEqual([{type: 'fs_source_detected', value: '<MPD/>', ext: 'mpd'}]);
  });

  it('posts nothing, and throws nothing, when every manifest is empty', () => {
    const page = load();
    expect(() => page.respond(JSON.stringify({video_dash_manifest: '', x: {video_dash_manifest: null}})))
        .not.toThrow();
    expect(page.posted).toEqual([]);
  });

  it('ignores a JSON response that is not an object', () => {
    const page = load();
    for (const text of ['42', '"text"', 'null', 'true']) {
      expect(() => page.respond(text), text).not.toThrow();
    }
    expect(page.posted).toEqual([]);
  });

  it('ignores a response without a manifest, and one that is not JSON', () => {
    const page = load();
    expect(() => page.respond('{"data": {"user": 1}}')).not.toThrow();
    expect(() => page.respond('<html>')).not.toThrow();
    expect(page.posted).toEqual([]);
  });

  it('logs no error for a response that has nothing to do with video', () => {
    // Every JSON response of the page put "No video_dash_manifest found" in its console.
    const page = load();
    page.respond('{"data": {"user": 1}}');
    expect(page.errors).toEqual([]);
  });
});

describe('instagram_inject.js, responses loaded with fetch', () => {
  const MANIFEST = JSON.stringify({data: {video_dash_manifest: '<MPD/>'}});

  /**
   * Lets the script's reading of a response finish.
   */
  async function settle() {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  it('posts the manifest of a JSON response, and the page still reads its own response', async () => {
    // XHR only: what Instagram loaded with fetch was never seen (#232).
    const response = new Response(MANIFEST, {headers: {'Content-Type': 'application/json; charset=utf-8'}});
    const page = load(async () => response);
    const got = await page.window.fetch('/graphql/query');
    expect(got).toBe(response);
    expect(await got.text()).toBe(MANIFEST);
    await settle();
    expect(page.posted).toEqual([{type: 'fs_source_detected', value: '<MPD/>', ext: 'mpd'}]);
  });

  it('reads a JavaScript or HTML response too', async () => {
    const page = load(async (url) => new Response(MANIFEST, {headers: {'Content-Type': url}}));
    await page.window.fetch('text/javascript; charset=utf-8');
    await page.window.fetch('text/html');
    await settle();
    expect(page.posted).toHaveLength(2);
  });

  it('copies no video, image or bytes response', async () => {
    let copies = 0;
    const page = load(async (url) => {
      const response = new Response(MANIFEST, {headers: {'Content-Type': url}});
      const clone = response.clone.bind(response);
      response.clone = () => {
        copies++;
        return clone();
      };
      return response;
    });
    for (const type of ['video/mp4', 'image/jpeg', 'application/octet-stream', '']) {
      await page.window.fetch(type);
    }
    await settle();
    expect(copies).toBe(0);
    expect(page.posted).toEqual([]);
  });

  it('passes the page\'s arguments on, and its failure back unchanged', async () => {
    const calls = [];
    const failure = new TypeError('NetworkError');
    const page = load(async (...args) => {
      calls.push(args);
      throw failure;
    });
    await expect(page.window.fetch('/a', {method: 'POST'})).rejects.toBe(failure);
    await settle();
    expect(calls).toEqual([['/a', {method: 'POST'}]]);
    expect(page.posted).toEqual([]);
  });

  it('leaves a page without fetch as it was', () => {
    const page = load(undefined);
    expect(page.window.fetch).toBeUndefined();
  });
});
