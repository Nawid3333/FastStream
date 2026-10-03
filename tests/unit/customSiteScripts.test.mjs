import vm from 'node:vm';
import {beforeAll, describe, expect, it} from 'vitest';

// The site scripts (chrome/custom/*.js) read a stream's manifest out of Facebook's,
// Bilibili's and Instagram's own pages and report it as a data: URL (DETECTED_SOURCE).
// Issue #232: a report whose manifest was the word "undefined", uncaught throws on play
// info of another shape and on any manifest with a character btoa refuses, and reports of
// no type the background recorded anyway.

// The site scripts' text, which vitest includes when it loads this file (?raw): read at run
// time, the code run below was "user-provided" to CodeQL (js/code-injection).
const SITE_SCRIPTS = import.meta.glob('../../chrome/custom/*.js', {query: '?raw', import: 'default', eager: true});

/**
 * Runs a site script on a stand-in page with these <script> elements.
 * @param {string} file - The script, under chrome/custom.
 * @param {Array<{type?: string, textContent: string}>} scripts - The page's scripts.
 * @return {{sent: Array<Object>, listeners: Array<Function>}} What it sent the background,
 *   and its window 'message' listeners.
 */
function runSiteScript(file, scripts = []) {
  const sent = [];
  const listeners = [];
  const context = {
    document: {
      querySelectorAll: (selector) => (selector === 'script' ? scripts.map((s) => ({type: '', ...s})) : []),
      createElement: () => ({remove() {}}),
      documentElement: {appendChild() {}},
    },
    window: {
      location: {origin: 'https://www.example.com'},
      addEventListener: (type, listener) => {
        if (type === 'message') listeners.push(listener);
      },
    },
    location: {href: 'https://www.example.com/watch', origin: 'https://www.example.com'},
    chrome: {runtime: {
      sendMessage: (message) => sent.push(message),
      getURL: (file) => 'moz-extension://test/' + file,
    }},
    console: {log() {}, error() {}},
    TextEncoder,
    btoa,
  };
  const source = SITE_SCRIPTS[`../../chrome/custom/${file}`];
  if (source === undefined) {
    throw new Error(`no site script chrome/custom/${file}`);
  }
  vm.runInNewContext(source, context);
  return {sent, listeners};
}

/**
 * @param {string} url - A report's data: URL.
 * @return {string} Its manifest, read as UTF-8.
 */
function manifestOf(url) {
  const prefix = 'data:application/dash+xml;base64,';
  expect(url.startsWith(prefix)).toBe(true);
  return Buffer.from(url.slice(prefix.length), 'base64').toString('utf8');
}

describe('facebook_content.js', () => {
  /**
   * @param {Object} video - A playback_video object.
   * @return {{type: string, textContent: string}} A JSON script holding it.
   */
  function jsonScript(video) {
    return {type: 'application/json', textContent: JSON.stringify({video: {playback_video: video}})};
  }

  it('reports the manifest of the video', () => {
    const {sent} = runSiteScript('facebook_content.js', [jsonScript({playlist: '<MPD/>'})]);
    expect(sent).toHaveLength(1);
    expect(manifestOf(sent[0].url)).toBe('<MPD/>');
  });

  it('reports nothing for a video without its manifest', () => {
    // btoa(undefined): a source whose manifest was the word "undefined".
    const {sent} = runSiteScript('facebook_content.js', [jsonScript({id: 1})]);
    expect(sent).toEqual([]);
  });

  it('reports a manifest with characters btoa refuses', () => {
    const mpd = '<MPD><Title>Ünïcödé – 日本語</Title></MPD>';
    const {sent} = runSiteScript('facebook_content.js', [jsonScript({playlist: mpd})]);
    expect(manifestOf(sent[0].url)).toBe(mpd);
  });
});

describe('bilibili_content.js', () => {
  it('throws nothing on play info that has no DASH streams', () => {
    // A page serving FLV (data.durl) instead of data.dash.
    const text = 'window.__playinfo__={"data":{"durl":[{"url":"https://cdn.example.com/a.flv"}]}}';
    expect(() => runSiteScript('bilibili_content.js', [{textContent: text}])).not.toThrow();
  });

  it('throws nothing when more code follows the play info on its line', () => {
    const text = 'window.__playinfo__={"data":{}};window.__INITIAL_STATE__={"a":1}';
    expect(() => runSiteScript('bilibili_content.js', [{textContent: text}])).not.toThrow();
  });
});

describe('instagram_content.js', () => {
  /**
   * Posts a message to the page's window, from the page itself.
   * @param {Array<Function>} listeners - The window's 'message' listeners.
   * @param {Object} data - The message.
   */
  function post(listeners, data) {
    for (const listener of listeners) listener({origin: 'https://www.example.com', data});
  }

  it('reports the manifest instagram_inject.js posts', () => {
    const {sent, listeners} = runSiteScript('instagram_content.js');
    post(listeners, {type: 'fs_source_detected', value: '<MPD>é</MPD>', ext: 'mpd'});
    expect(sent).toHaveLength(1);
    expect(sent[0].ext).toBe('mpd');
    expect(manifestOf(sent[0].url)).toBe('<MPD>é</MPD>');
  });

  it('passes on no report of another type, or with no manifest', () => {
    // Any script in the page can post one.
    const {sent, listeners} = runSiteScript('instagram_content.js');
    post(listeners, {type: 'fs_source_detected', value: '<MPD/>', ext: 'exe'});
    post(listeners, {type: 'fs_source_detected', value: '<MPD/>'});
    post(listeners, {type: 'fs_source_detected', value: '', ext: 'mpd'});
    expect(sent).toEqual([]);
  });
});

describe('BackgroundUtils.detectedSourceMode', () => {
  let BackgroundUtils;

  beforeAll(async () => {
    // BackgroundUtils reads the player URL when it loads.
    globalThis.chrome = {runtime: {getURL: (file) => 'moz-extension://test/' + file}};
    ({BackgroundUtils} = await import('../../chrome/background/BackgroundUtils.mjs'));
  });

  it('gives the mode of a manifest a site script reports', () => {
    expect(BackgroundUtils.detectedSourceMode({url: 'data:application/dash+xml;base64,PE1QRC8+', ext: 'mpd'})).toBeTruthy();
  });

  it('gives none for a report of no type, or with no address', () => {
    // It was recorded as a source of mode undefined.
    expect(BackgroundUtils.detectedSourceMode({url: 'data:,x', ext: 'exe'})).toBeNull();
    expect(BackgroundUtils.detectedSourceMode({url: 'data:,x'})).toBeNull();
    expect(BackgroundUtils.detectedSourceMode({url: {}, ext: 'mpd'})).toBeNull();
    expect(BackgroundUtils.detectedSourceMode({ext: 'mpd'})).toBeNull();
    expect(BackgroundUtils.detectedSourceMode(null)).toBeNull();
  });
});
