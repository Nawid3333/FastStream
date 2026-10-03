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
 * An XML document as Bilibili2Dash builds one: elements with attributes, text and children,
 * which the stand-in XMLSerializer writes out as markup.
 * @return {{createElement: function(string): Object}}
 */
function fakeXmlDocument() {
  return {
    createElement: (name) => ({
      name, attributes: [], children: [], textContent: '',
      setAttribute(key, value) {
        this.attributes.push(`${key}="${value}"`);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
    }),
  };
}

/**
 * @param {Object} node - An element of fakeXmlDocument.
 * @return {string} Its markup.
 */
function serializeXml(node) {
  const attributes = node.attributes.map((a) => ' ' + a).join('');
  return `<${node.name}${attributes}>${node.textContent}${node.children.map(serializeXml).join('')}</${node.name}>`;
}

/**
 * Runs a site script on a stand-in page with these <script> elements.
 * @param {string} file - The script, under chrome/custom.
 * @param {Array<{type?: string, textContent: string}>} scripts - The page's scripts.
 * @return {{sent: Array<Object>, listeners: Array<Function>, page: Array<Object>,
 *   location: Object, tick: function(): void}} What it sent the background, its window
 *   'message' listeners, the page's script elements (the same objects every time, as a
 *   page's are; a test may add more), its address, and a tick of its one-second timers.
 */
function runSiteScript(file, scripts = []) {
  const sent = [];
  const listeners = [];
  const intervals = [];
  const page = scripts.map((s) => ({type: '', ...s}));
  const location = {href: 'https://www.example.com/watch', origin: 'https://www.example.com'};
  const context = {
    document: {
      querySelectorAll: (selector) => (selector === 'script' ? page.slice() : []),
      createElement: () => ({remove() {}}),
      documentElement: {appendChild() {}},
      implementation: {createDocument: fakeXmlDocument},
    },
    window: {
      location: {origin: 'https://www.example.com'},
      addEventListener: (type, listener) => {
        if (type === 'message') listeners.push(listener);
      },
    },
    location,
    XMLSerializer: class {
      serializeToString(node) {
        return serializeXml(node);
      }
    },
    setInterval: (fn, ms) => {
      expect(ms).toBe(1000);
      intervals.push(fn);
    },
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
  return {sent, listeners, page, location, tick: () => intervals.forEach((fn) => fn())};
}

/**
 * The single-page case both Facebook and Bilibili have (#232): the address changes to
 * another video without a page load, and a script tag for it arrives a moment later.
 * @param {string} file - The site script.
 * @param {function(string): {type?: string, textContent: string}} scriptFor - A script tag
 *   holding the video with this name.
 * @param {function(Object): string} nameOf - The video's name, from a report.
 */
function singlePageCases(file, scriptFor, nameOf) {
  it('reads the next video\'s script once the address changes, under the new address', () => {
    const run = runSiteScript(file, [scriptFor('first')]);
    expect(run.sent.map(nameOf)).toEqual(['first']);
    run.location.href = 'https://www.example.com/watch/2';
    run.tick();
    run.page.push({type: '', ...scriptFor('second')});
    run.tick();
    expect(run.sent.map(nameOf)).toEqual(['first', 'second']);
    expect(run.sent[1].headers.Referer).toBe('https://www.example.com/watch/2');
  });

  it('does not report the first video again under the new address', () => {
    const run = runSiteScript(file, [scriptFor('first')]);
    run.location.href = 'https://www.example.com/watch/2';
    for (let i = 0; i < 12; i++) run.tick();
    expect(run.sent.map(nameOf)).toEqual(['first']);
  });

  it('reads nothing new while the address stays, and a script from just before a change after it', () => {
    const run = runSiteScript(file, [scriptFor('first')]);
    run.page.push({type: '', ...scriptFor('second')});
    for (let i = 0; i < 3; i++) run.tick();
    expect(run.sent.map(nameOf)).toEqual(['first']);
    run.location.href = 'https://www.example.com/watch/2';
    run.tick();
    expect(run.sent.map(nameOf)).toEqual(['first', 'second']);
  });

  it('does not report a video again when the page adds its script once more', () => {
    const run = runSiteScript(file, [scriptFor('first')]);
    run.location.href = 'https://www.example.com/watch/2';
    run.page.push({type: '', ...scriptFor('first')});
    run.tick();
    expect(run.sent.map(nameOf)).toEqual(['first']);
  });

  it('stops reading ten seconds after the address changed', () => {
    const run = runSiteScript(file, [scriptFor('first')]);
    run.location.href = 'https://www.example.com/watch/2';
    for (let i = 0; i < 10; i++) run.tick();
    run.page.push({type: '', ...scriptFor('too late')});
    run.tick();
    expect(run.sent.map(nameOf)).toEqual(['first']);
  });
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

  singlePageCases('facebook_content.js',
      (name) => jsonScript({playlist: `<MPD id="${name}"/>`}),
      (report) => manifestOf(report.url).match(/id="([^"]*)"/)[1]);
});

describe('bilibili_content.js', () => {
  /**
   * @param {string} name - The video's name, which its stream address carries.
   * @return {{textContent: string}} A script setting play info with DASH streams.
   */
  function playInfoScript(name) {
    const track = (kind) => ({
      id: 1, baseUrl: `https://cdn.example.com/${name}-${kind}.m4s`, bandwidth: 1000, mimeType: `${kind}/mp4`,
      codecs: 'avc1', width: 640, height: 360, startWithSap: 1,
      SegmentBase: {indexRange: '0-99', Initialization: '0-9'},
    });
    const playInfo = {data: {dash: {duration: 10, minBufferTime: 1.5, video: [track('video')], audio: [track('audio')]}}};
    return {textContent: `window.__playinfo__=${JSON.stringify(playInfo)}`};
  }

  it('reports the DASH streams of the play info as a manifest', () => {
    const {sent} = runSiteScript('bilibili_content.js', [playInfoScript('first')]);
    expect(sent).toHaveLength(1);
    expect(manifestOf(sent[0].url)).toContain('<BaseURL>https://cdn.example.com/first-video.m4s</BaseURL>');
  });

  singlePageCases('bilibili_content.js', playInfoScript,
      (report) => manifestOf(report.url).match(/example\.com\/([^-]*)-video/)[1]);

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
