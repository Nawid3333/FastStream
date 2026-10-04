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
 * Runs the script against a stand-in XMLHttpRequest.
 * @return {{posted: Array<Object>, errors: Array<Array<*>>, respond: function(string): void}}
 */
function load() {
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
    window: {postMessage: (data) => posted.push(data)},
    console: {error: (...args) => errors.push(args), log() {}},
  };
  vm.runInNewContext(source, context);
  return {
    posted,
    errors,
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
