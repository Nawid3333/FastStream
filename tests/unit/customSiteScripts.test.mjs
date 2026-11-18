import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {beforeAll, describe, expect, it} from 'vitest';

// The site scripts (chrome/custom/*.js) read a manifest out of Facebook's, Bilibili's and
// Instagram's pages and report it as a data: URL.

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
 * The single-page case both Facebook and Bilibili have: the address changes to
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

  // A reel opened signed out: the manifest is in the delivery fields (data.video, the preloaded
  // ones under viewer.lasso_blue_feed).
  /**
   * @param {?string} mpd - Its dash_manifest_xml_string.
   * @return {Object} A playback_video object of that shape.
   */
  const reelVideo = (mpd) => ({id: '1', videoDeliveryLegacyFields: {dash_manifest_xml_string: mpd,
    browser_native_hd_url: 'https://video.example/m366/hd.mp4', browser_native_sd_url: 'https://video.example/m412/sd.mp4'}});

  it('reports the manifest a reel has in its delivery fields', () => {
    const {sent} = runSiteScript('facebook_content.js', [jsonScript(reelVideo('<MPD reel/>'))]);
    expect(sent).toHaveLength(1);
    expect(manifestOf(sent[0].url)).toBe('<MPD reel/>');
  });

  it('reports the reel on screen, not the ones the page preloads after it', () => {
    // The preloaded ones first: only the path tells the reel on screen apart.
    const data = {
      viewer: {lasso_blue_feed: {edges: [
        {node: {short_form_video_context: {playback_video: reelVideo('<MPD id="next"/>')}}},
      ]}},
      video: {creation_story: {short_form_video_context: {playback_video: reelVideo('<MPD id="on-screen"/>')}}},
    };
    const page = [{type: 'application/json', textContent: JSON.stringify({require: [[{__bbox: {result: {data}}}]]})}];
    const {sent} = runSiteScript('facebook_content.js', page);
    expect(sent.map((report) => manifestOf(report.url))).toEqual(['<MPD id="on-screen"/>']);
  });

  it('reports nothing for a video whose delivery fields have no manifest', () => {
    // An older video's page: one progressive file, which FastStream finds by itself.
    const {sent} = runSiteScript('facebook_content.js', [jsonScript(reelVideo(null))]);
    expect(sent).toEqual([]);
  });

  it('reports a manifest with characters btoa refuses', () => {
    const mpd = '<MPD><Title>Ünïcödé – 日本語</Title></MPD>';
    const {sent} = runSiteScript('facebook_content.js', [jsonScript({playlist: mpd})]);
    expect(manifestOf(sent[0].url)).toBe(mpd);
  });

  it('reports a new video that comes in the same batch after one already reported', () => {
    // the batch's repeated first manifest does not hide the new one after it
    const run = runSiteScript('facebook_content.js', [jsonScript({playlist: '<MPD id="first"/>'})]);
    run.location.href = 'https://www.example.com/watch/2';
    run.tick();
    run.page.push({type: '', ...jsonScript({playlist: '<MPD id="first"/>'})});
    run.page.push({type: '', ...jsonScript({playlist: '<MPD id="second"/>'})});
    run.tick();
    expect(run.sent.map((report) => manifestOf(report.url))).toEqual(['<MPD id="first"/>', '<MPD id="second"/>']);
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

  // the play info read as a whole JSON value, across lines and with code after it
  it('reads the play info with more code after it, or over several lines', () => {
    const script = playInfoScript('next');
    const trailing = {textContent: script.textContent + ';window.__INITIAL_STATE__={"title":"a } \\" b"}'};
    expect(runSiteScript('bilibili_content.js', [trailing]).sent).toHaveLength(1);
    const lines = {textContent: script.textContent.replace('{"data"', '{\n"data"').replace('"dash"', '\n"dash"')};
    expect(runSiteScript('bilibili_content.js', [lines]).sent).toHaveLength(1);
  });

  it('reports a video without sound, whose play info has no audio list', () => {
    // data.dash.audio may be null

    const playInfo = JSON.parse(playInfoScript('silent').textContent.replace('window.__playinfo__=', ''));
    playInfo.data.dash.audio = null;
    const {sent} = runSiteScript('bilibili_content.js', [{textContent: `window.__playinfo__=${JSON.stringify(playInfo)}`}]);
    expect(sent).toHaveLength(1);
    const manifest = manifestOf(sent[0].url);
    expect(manifest).toContain('silent-video.m4s');
    expect(manifest.match(/<AdaptationSet/g)).toHaveLength(1);
  });

  it('gives each codec its own set, and every version an id of its own', () => {
    // Bilibili sends each quality in H.264, HEVC and AV1 under one id: codec sets stay apart, not
    // one HEVC level twice.
    const track = (id, codecs, height) => ({id, codecs, height, width: height * 16 / 9, bandwidth: 1000 + id,
      baseUrl: `https://cdn.example.com/${id}-${codecs}.m4s`, mimeType: 'video/mp4', startWithSap: 1,
      SegmentBase: {indexRange: '0-99', Initialization: '0-9'}});
    const video = [track(32, 'avc1.64001F', 480), track(32, 'hvc1.1.6.L120.90', 480), track(32, 'av01.0.08M.08', 480),
      track(16, 'hvc1.1.6.L120.90', 360), track(16, 'avc1.64001E', 360), track(16, 'av01.0.08M.08', 360)];
    const audio = [{...track(30280, 'mp4a.40.2', 0), mimeType: 'audio/mp4'}, {...track(30216, 'mp4a.40.2', 0), mimeType: 'audio/mp4'}];
    const playInfo = {data: {dash: {duration: 10, minBufferTime: 1.5, video, audio}}};
    const {sent} = runSiteScript('bilibili_content.js', [{textContent: `window.__playinfo__=${JSON.stringify(playInfo)}`}]);
    expect(sent).toHaveLength(1);
    const sets = manifestOf(sent[0].url).match(/<AdaptationSet>.*?<\/AdaptationSet>/g);
    const codecsOf = (set) => [...set.matchAll(/codecs="([^".]*)/g)].map((m) => m[1]);
    expect(sets.map((set) => [...new Set(codecsOf(set))])).toEqual([['avc1'], ['hvc1'], ['av01'], ['mp4a']]);
    expect(sets.map((set) => codecsOf(set).length)).toEqual([2, 2, 2, 2]);
    // Each version: an id of its own, from its quality and codec, with its own codec and address.
    const reps = [...manifestOf(sent[0].url).matchAll(/<Representation id="([^"]*)" codecs="([^"]*)"[^>]*><BaseURL>([^<]*)<\/BaseURL>/g)]
        .map(([, id, codecs, url]) => ({id, codecs, url}));
    expect(reps).toHaveLength(8);
    expect(new Set(reps.map((rep) => rep.id)).size).toBe(8);
    expect(reps).toEqual(expect.arrayContaining([...video, ...audio].map((t) =>
      ({id: `${t.id}-${t.codecs.split('.')[0]}`, codecs: t.codecs, url: t.baseUrl}))));
  });

  it('gives a version an id of its own when its quality and codec come twice, or it names no codec', () => {
    const track = (codecs, url) => ({id: 32, codecs, baseUrl: `https://cdn.example.com/${url}.m4s`, bandwidth: 1000,
      mimeType: 'video/mp4', width: 852, height: 480, SegmentBase: {indexRange: '0-99', Initialization: '0-9'}});
    const playInfo = {data: {dash: {duration: 10, minBufferTime: 1.5, audio: null,
      video: [track('avc1.64001F', 'a'), track('avc1.64001F', 'b'), track(undefined, 'c'), track('', 'd')]}}};
    const {sent} = runSiteScript('bilibili_content.js', [{textContent: `window.__playinfo__=${JSON.stringify(playInfo)}`}]);
    const ids = [...manifestOf(sent[0].url).matchAll(/<Representation id="([^"]*)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['32-avc1', '32-avc1-2', '32', '32--2']);
    expect(manifestOf(sent[0].url).match(/<AdaptationSet/g)).toHaveLength(2);
  });

  it('writes no width or height for a track that has none', () => {
    // An audio track: the manifest read width="undefined".
    const playInfo = {data: {dash: {duration: 10, minBufferTime: 1.5, video: [], audio: [{
      id: 2, baseUrl: 'https://cdn.example.com/a.m4s', bandwidth: 1000, mimeType: 'audio/mp4', codecs: 'mp4a.40.2',
      SegmentBase: {indexRange: '0-99', Initialization: '0-9'},
    }]}}};
    const {sent} = runSiteScript('bilibili_content.js', [{textContent: `window.__playinfo__=${JSON.stringify(playInfo)}`}]);
    expect(sent).toHaveLength(1);
    expect(manifestOf(sent[0].url)).not.toContain('undefined');
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

  // Instagram fetches a video's data more than once: one source
  it('reports a manifest once', () => {
    const {sent, listeners} = runSiteScript('instagram_content.js');
    post(listeners, {type: 'fs_source_detected', value: '<MPD/>', ext: 'mpd'});
    post(listeners, {type: 'fs_source_detected', value: '<MPD/>', ext: 'mpd'});
    post(listeners, {type: 'fs_source_detected', value: '<MPD>2</MPD>', ext: 'mpd'});
    expect(sent).toHaveLength(2);
  });

  // Only this script puts instagram_inject.js in a page, in Instagram's pages only. Listed for
  // <all_urls> with the player's page, any site could load it into itself.
  it('has instagram_inject.js reachable from the pages it runs in only', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../chrome/manifest.json'), 'utf8'));
    const listed = (file) => manifest.web_accessible_resources.filter((entry) => entry.resources.includes(file));
    const own = manifest.content_scripts.find((entry) => entry.js.includes('custom/instagram_content.js'));
    expect(own.matches).toEqual(['https://www.instagram.com/*']);
    expect(listed('custom/instagram_inject.js')).toEqual([{resources: ['custom/instagram_inject.js'], matches: own.matches}]);
    // The player's page stays open to every page: the in-page player is an iframe of it.
    expect(listed('player/index.html')).toEqual([{resources: ['player/index.html'], matches: ['<all_urls>']}]);
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
