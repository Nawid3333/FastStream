import {describe, expect, it} from 'vitest';
import {loadContentScript} from './contentDom.mjs';

// content.js's message handlers, run against a stand-in page (contentDom.mjs).

/**
 * The name content.js gave its page (FRAME_ADDED's document).
 * @param {Object} page - From loadContentScript.
 * @return {string}
 */
function pageName(page) {
  return page.sent.find((message) => message.type === 'FRAME_ADDED').document;
}

// A player naming a frame as its parent is taken for that frame's only when the frame's
// page opened it (#225). The background asks the frame's content script when it does not
// know the page's name itself.
describe('IS_PLAYER_OPENER', () => {
  it('answers yes for the name this page put in its players\' URLs', async () => {
    const page = loadContentScript();
    expect(await page.send({type: 'IS_PLAYER_OPENER', document: pageName(page)})).toBe(true);
  });

  it('answers no for any other name', async () => {
    const page = loadContentScript();
    for (const name of ['made-up', '', null, undefined]) {
      expect(await page.send({type: 'IS_PLAYER_OPENER', document: name}), String(name)).toBe(false);
    }
  });

  it('gives each page a name of its own', () => {
    expect(pageName(loadContentScript())).not.toBe(pageName(loadContentScript()));
  });
});

/**
 * Puts a <track> in the page's body.
 * @param {Object} page - From loadContentScript.
 * @param {string} src - Its URL.
 * @param {string} [kind] - Its kind.
 * @return {Object} The track.
 */
function addTrack(page, src, kind = 'subtitles') {
  const track = page.document.createElement('track');
  Object.assign(track, {kind, label: src, srclang: 'en'});
  track.src = src;
  page.document.body.appendChild(track);
  return track;
}

// SCRAPE_CAPTIONS reads the page's <track> files for the player. A request that failed at
// once (a src XMLHttpRequest refuses) answered inside the loop, before the next track was
// even asked for: the player opened without a track it could have had (#233).
describe('SCRAPE_CAPTIONS', () => {
  it('waits for every track when one request fails at once', async () => {
    const page = loadContentScript({responses: {'https://cdn.example/en.vtt': 'WEBVTT'}});
    addTrack(page, 'http://[bad');
    addTrack(page, 'https://cdn.example/en.vtt');
    const tracks = await page.send({type: 'SCRAPE_CAPTIONS'});
    expect(tracks.map((track) => track.source)).toEqual(['https://cdn.example/en.vtt']);
    expect(tracks[0].data).toBe('WEBVTT');
  });

  it('answers once, with nothing, for a page without tracks', async () => {
    const page = loadContentScript();
    expect(await page.send({type: 'SCRAPE_CAPTIONS'})).toEqual([]);
  });

  it('leaves out a track whose request does not answer 200', async () => {
    const page = loadContentScript({responses: {'https://cdn.example/en.vtt': 'WEBVTT'}});
    addTrack(page, 'https://cdn.example/missing.vtt');
    addTrack(page, 'https://cdn.example/en.vtt');
    const tracks = await page.send({type: 'SCRAPE_CAPTIONS'});
    expect(tracks.map((track) => track.source)).toEqual(['https://cdn.example/en.vtt']);
  });

  it('stops a track whose body stalls, and answers with the others', async () => {
    // Three bytes, then nothing: the request is stopped when nothing has come for 2 s.
    const stalling = (init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('WEB'));
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
      },
    }), {status: 200});
    const page = loadContentScript({responses: {'https://cdn.example/slow.vtt': stalling, 'https://cdn.example/en.vtt': 'WEBVTT'}});
    addTrack(page, 'https://cdn.example/slow.vtt');
    addTrack(page, 'https://cdn.example/en.vtt');
    const answer = page.send({type: 'SCRAPE_CAPTIONS'});
    // Let both requests start and read what they can, then let 2 s pass on the page's clock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    page.advance(2000);
    const tracks = await answer;
    expect(tracks.map((track) => track.source)).toEqual(['https://cdn.example/en.vtt']);
  });

  it('leaves out tracks that are not text to read', async () => {
    const page = loadContentScript({responses: {'https://cdn.example/ch.vtt': 'WEBVTT', 'https://cdn.example/cc.vtt': 'WEBVTT'}});
    addTrack(page, 'https://cdn.example/ch.vtt', 'chapters');
    addTrack(page, 'https://cdn.example/cc.vtt', 'captions');
    const tracks = await page.send({type: 'SCRAPE_CAPTIONS'});
    expect(tracks.map((track) => track.source)).toEqual(['https://cdn.example/cc.vtt']);
  });
});

const PLAYER_URL = 'moz-extension://test/player/index.html';

/**
 * Gives an element of the page a closed shadow root, as Firefox shows one to a content
 * script: element.shadowRoot is null, element.openOrClosedShadowRoot is the root. The root
 * is a stand-in element, in the page through its host.
 * @param {Object} page - From loadContentScript.
 * @param {Object} host - The element.
 * @return {Object} The root.
 */
function closedShadowRoot(page, host) {
  const root = page.document.createElement('div');
  root.parentNode = host;
  host.openOrClosedShadowRoot = root;
  return root;
}

/**
 * A page with a 640x360 video in a wrapper of the same size (#wrap), which a player
 * replaces.
 * @param {Object} [options] - For loadContentScript.
 * @return {{page: Object, wrap: Object, video: Object}}
 */
function pageWithVideo(options) {
  const page = loadContentScript(options);
  const {document} = page;
  document.documentElement.rect = {x: 0, y: 0, width: 1280, height: 2000};
  document.body.rect = {x: 0, y: 0, width: 1280, height: 2000};
  const wrap = document.createElement('div');
  wrap.id = 'wrap';
  wrap.rect = {x: 0, y: 0, width: 640, height: 360};
  const video = document.createElement('video');
  video.rect = {x: 0, y: 0, width: 640, height: 360};
  wrap.appendChild(video);
  document.body.appendChild(wrap);
  return {page, wrap, video};
}

/**
 * Opens a player in the page, as the background does.
 * @param {Object} page - From loadContentScript.
 * @return {Promise<{answer: *, iframe: Object}>} content.js's answer, and the player's
 *   iframe.
 */
async function openPlayer(page) {
  const answer = await page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, noRedirect: true, frameId: 0, parentFrameId: -1, attempt: 1});
  const iframe = page.document.querySelectorAll('iframe').find((f) => f.src.startsWith(PLAYER_URL));
  return {answer, iframe};
}

/**
 * Links a player that loaded in an iframe to it, as the background and the player do
 * (FRAME_LINK_RECEIVER here, then the player posts the key to its parent).
 * @param {Object} page - From loadContentScript.
 * @param {Object} iframe - The player's iframe.
 * @param {number} frameId - The player's frame.
 */
async function linkPlayer(page, iframe, frameId) {
  const key = 'key-' + Math.random();
  await page.send({type: 'FRAME_LINK_RECEIVER', key, frameId});
  page.postMessage(key, iframe.contentWindow);
  await Promise.resolve();
}

// Opening a player sent the background a message for the site scripts' 'active-state',
// and removing it another, which it passed back to the same frame, where nothing reads
// them (the YouTube script that did is gone): two round trips per player for nothing.
describe('OPEN_PLAYER', () => {
  it('puts the player in place of the page\'s video', async () => {
    const {page, wrap} = pageWithVideo();
    const {answer, iframe} = await openPlayer(page);
    expect(answer).toBe('replace');
    expect(iframe.parentNode).toBe(page.document.body);
    // The soft replace: the page's player is kept, at no size, and the iframe has its id.
    expect(wrap.style.width).toBe('0px');
    expect(iframe.id).toBe('wrap');
  });

  it('sends the background nothing for the site scripts on opening and removing a player', async () => {
    const {page} = pageWithVideo();
    const {iframe} = await openPlayer(page);
    await linkPlayer(page, iframe, 5);
    expect(await page.send({type: 'REMOVE_PLAYERS'})).toBe('ok');
    expect(page.sent.map((message) => message.type).filter((type) => type === 'SEND_TO_CONTENT')).toEqual([]);
  });
});

// types/messages.d.ts described the answer as {width, height}; it is the visible area, a
// number the background sorts frames by (#233).
describe('GET_VIDEO_SIZE', () => {
  it('answers the largest video\'s visible area, as a number', async () => {
    const {page} = pageWithVideo();
    expect(await page.send({type: 'GET_VIDEO_SIZE'})).toBe(640 * 360);
  });

  it('answers 0 for a frame without a video', async () => {
    const page = loadContentScript();
    expect(await page.send({type: 'GET_VIDEO_SIZE'})).toBe(0);
  });
});

/**
 * A page with a linked player (frame 5) in place of its video.
 * @return {Promise<{page: Object, wrap: Object, video: Object, iframe: Object}>}
 */
async function pageWithPlayer() {
  const {page, wrap, video} = pageWithVideo();
  const {iframe} = await openPlayer(page);
  await linkPlayer(page, iframe, 5);
  return {page, wrap, video, iframe};
}

/**
 * Adds plain elements to the page's body, each with no style of its own.
 * @param {Object} page - From loadContentScript.
 * @param {number} count - How many.
 * @return {Array<Object>} The elements.
 */
function addElements(page, count) {
  const elements = [];
  for (let i = 0; i < count; i++) {
    const div = page.document.createElement('div');
    page.document.body.appendChild(div);
    elements.push(div);
  }
  return elements;
}

// Windowed fullscreen hides every other element of the page (fillScreenIframe). Each one
// was looked up in an array of those already changed, and taken out of it with a splice:
// both quadratic, seconds on the page's main thread for a page of 50,000 elements (#227).
// The walk also styled the <head>'s <meta>, <script> and <style> elements.
describe('windowed fullscreen', () => {
  it('hides the rest of the page, and gives every element its style back', async () => {
    const {page, iframe} = await pageWithPlayer();
    const [plain, styled] = addElements(page, 2);
    styled.setAttribute('style', 'color: red;');
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5})).toBe('enter');
    expect(plain.style.getPropertyValue('display')).toBe('none');
    expect(styled.style.getPropertyValue('display')).toBe('none');
    expect(iframe.style.getPropertyValue('position')).toBe('fixed');
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5})).toBe('exit');
    expect(plain.style.getPropertyValue('display')).toBe('');
    expect(styled.getAttribute('style')).toBe('color: red;');
  });

  it('gives a hidden element its own display back, and leaves the rest of its style as it is now', async () => {
    const {page} = await pageWithPlayer();
    const [flex] = addElements(page, 1);
    flex.setAttribute('style', 'display: flex !important; color: red;');
    await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5});
    // Changed meanwhile, by the page or by the overlay guard giving its change back.
    flex.style.setProperty('color', 'blue');
    await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5});
    expect(flex.style.getPropertyValue('display')).toBe('flex');
    expect(flex.style.getPropertyPriority('display')).toBe('important');
    expect(flex.style.getPropertyValue('color')).toBe('blue');
  });

  // The overlay guard hides a bar over the player with visibility. Windowed fullscreen then
  // hid the bar too, and kept its whole style attribute, the guard's visibility in it; the
  // guard gave the bar back meanwhile (hidden, it has no box), and leaving windowed
  // fullscreen put the old attribute back: the bar stayed hidden for good, after the
  // player went as well.
  it('leaves no bar hidden that the overlay guard gave back meanwhile', async () => {
    const page = loadContentScript();
    const {document} = page;
    document.documentElement.rect = {x: 0, y: 0, width: 1280, height: 2000};
    document.body.rect = {x: 0, y: 0, width: 1280, height: 2000};
    const embed = document.createElement('iframe');
    embed.src = 'https://embed.example/e/1';
    embed.rect = {x: 0, y: 0, width: 640, height: 360};
    document.body.appendChild(embed);
    const bar = document.createElement('div');
    // An element with display: none has no box, as in Firefox.
    bar.rect = () => (bar.style.getPropertyValue('display') === 'none' ?
      {x: 0, y: 0, width: 0, height: 0} : {x: 0, y: 320, width: 640, height: 40});
    document.body.appendChild(bar);
    await linkPlayer(page, embed, 7);
    // Asked of this frame as the player in the embed opens: the guard starts.
    await page.send({type: 'IS_FULL', frameId: 7});
    expect(bar.style.getPropertyValue('visibility')).toBe('hidden');

    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 7})).toBe('enter');
    page.runIntervals();
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 7})).toBe('exit');
    page.runIntervals();
    // Over the player again: the guard hides it again, and still knows to give it back.
    expect(bar.style.getPropertyValue('visibility')).toBe('hidden');
    embed.remove();
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(bar.style.getPropertyValue('visibility')).toBe('');
  });

  it('leaves the <head> alone', async () => {
    const {page} = await pageWithPlayer();
    const meta = page.document.createElement('meta');
    page.document.head.appendChild(meta);
    await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5});
    expect(meta.getAttribute('style')).toBeNull();
  });

  it('takes well under a second for a page of 50,000 elements', async () => {
    const {page} = await pageWithPlayer();
    const elements = addElements(page, 50000);
    const start = performance.now();
    await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5});
    await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5});
    const took = performance.now() - start;
    expect(elements.every((el) => el.style.getPropertyValue('display') === '')).toBe(true);
    expect(took).toBeLessThan(1000);
  }, 60000);
});

// A player in a site's embed iframe: the top frame links the embed iframe, and windowed
// fullscreen fixes it over the whole page. REMOVE_PLAYERS (a same-site navigation) gave
// the rest of the page back, but not the embed's own style, which stayed fixed over the
// page (#229).
describe('REMOVE_PLAYERS', () => {
  it('takes an embed holding the player out of windowed fullscreen', async () => {
    const page = loadContentScript();
    const embed = page.document.createElement('iframe');
    embed.setAttribute('style', 'width: 640px;');
    page.document.body.appendChild(embed);
    await linkPlayer(page, embed, 7);
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 7})).toBe('enter');
    expect(embed.style.getPropertyValue('position')).toBe('fixed');
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(embed.getAttribute('style')).toBe('width: 640px;');
    // And it knows it left: the next toggle enters again.
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 7})).toBe('enter');
  });
});

/**
 * Asks for the miniplayer, as the background does for the player.
 * @param {Object} page - From loadContentScript.
 * @return {Promise<*>} content.js's answer.
 */
function requestMiniplayer(page) {
  return page.send({type: 'TOGGLE_MINIPLAYER', frameId: 5, playerFrameId: 5, force: true, size: 0.25, styles: {bottom: '0px', right: '0px'}});
}

// The miniplayer shrinks the player's iframe, or the outermost wrapper with its box, to a
// corner, with a placeholder in its place (#229).
describe('TOGGLE_MINIPLAYER', () => {
  it('answers, and changes nothing, when the page took the player\'s iframe out', async () => {
    // insertBefore on the missing parent threw inside the message handler.
    const {page, iframe} = await pageWithPlayer();
    iframe.remove();
    const childrenBefore = page.document.body.children.length;
    expect(await requestMiniplayer(page)).toBe('exit');
    expect(page.document.body.children.length).toBe(childrenBefore);
  });

  it('never makes the body the miniplayer', async () => {
    // A wrapper that came to fill the body: the body was the element with the player's
    // box, a second <body> went in before it, and the page's body was fixed to a corner.
    const {page, iframe} = await pageWithPlayer();
    iframe.rect = {x: 0, y: 0, width: 1280, height: 2000};
    expect(await requestMiniplayer(page)).toBe('enter');
    expect(page.document.documentElement.children.map((el) => el.tagName)).toEqual(['HEAD', 'BODY']);
    expect(page.document.body.getAttribute('style')).toBeNull();
    expect(iframe.style.getPropertyValue('position')).toBe('fixed');
  });

  it('gives the miniplayer a size when its placeholder has none', async () => {
    // Here the placeholder is laid out at 0x0: the sizes were NaN.
    const {page, iframe} = await pageWithPlayer();
    expect(await requestMiniplayer(page)).toBe('enter');
    expect(iframe.style.getPropertyValue('width')).toMatch(/^[\d.]+px$/);
    expect(iframe.style.getPropertyValue('height')).toMatch(/^[\d.]+px$/);
  });
});

// A soft replace keeps the page's element, at no size, next to the player. When that
// element collapses once shown (under 100 px square), the replace turns hard a second
// after opening: the element leaves the page. The check only looked at players that had
// linked up, and on a slow start the player linked after it: the element stayed (#229).
describe('the soft replace turning hard', () => {
  /**
   * Opens a player on a page whose element collapses once it is replaced, and links the
   * player up after the given time.
   * @param {number} linkAfter - When the player links up, in ms after the open.
   * @return {Promise<Object>} The page's element.
   */
  async function collapseAndLinkAfter(linkAfter) {
    const {page, wrap} = pageWithVideo();
    const {iframe} = await openPlayer(page);
    wrap.rect = {x: 0, y: 0, width: 5, height: 5};
    page.advance(linkAfter);
    await linkPlayer(page, iframe, 5);
    page.advance(3000);
    return wrap;
  }

  it('turns hard when the player linked up within the second', async () => {
    expect((await collapseAndLinkAfter(500)).isConnected).toBe(false);
  });

  it('turns hard when the player linked up later', async () => {
    expect((await collapseAndLinkAfter(1500)).isConnected).toBe(false);
  });

  it('stays soft for an element that keeps its size', async () => {
    const {page, wrap} = pageWithVideo();
    const {iframe} = await openPlayer(page);
    page.advance(1500);
    await linkPlayer(page, iframe, 5);
    page.advance(3000);
    expect(wrap.isConnected).toBe(true);
  });
});

// "This Frame > Reload Frame" on the player loads its page again in the same frame, which
// links up with the same iframe again. The new entry had nothing to give back, so leaving
// the page kept the page's element hidden and its media paused for good (#288).
describe('a player that loads again in its frame', () => {
  it('still gives the page its element back when the player goes', async () => {
    const {page, wrap, video, iframe} = await pageWithPlayer();
    await linkPlayer(page, iframe, 5);
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(iframe.isConnected).toBe(false);
    expect(wrap.style.width).toBe('');
    expect(wrap.id).toBe('wrap');
    expect(video.listeners.filter((l) => l.type === 'play')).toEqual([]);
  });
});

// When the background was suspended and knows no stream of the tab, each frame reports
// what its page loaded (REPORT_LOADED_MEDIA), from its Resource Timing entries. The page's
// timeline keeps its first 250 requests, and a streaming page made that many (ads,
// trackers) before its video asked for the manifest: the manifest was never reported (#231).
describe('REPORT_LOADED_MEDIA', () => {
  /**
   * A page's requests: images, then its manifest last.
   * @param {number} images - How many images before the manifest.
   * @return {Array<Object>} Resource Timing entries.
   */
  function requests(images) {
    const entries = [];
    for (let i = 0; i < images; i++) {
      entries.push({name: `https://ads.example/px${i}.gif`, initiatorType: 'img', responseStatus: 200, startTime: i});
    }
    entries.push({name: 'https://cdn.example/film.m3u8', initiatorType: 'fetch', responseStatus: 200, startTime: images});
    return entries;
  }

  /**
   * @param {Object} page - From loadContentScript.
   * @return {Promise<Array<string>>} The URLs content.js reports.
   */
  async function reported(page) {
    await Promise.resolve();
    await page.send({type: 'REPORT_LOADED_MEDIA'});
    return page.sent.find((message) => message.type === 'LOADED_MEDIA').resources.map((r) => r.url);
  }

  it('reports a manifest the page asked for after 300 other requests', async () => {
    const page = loadContentScript({entries: requests(300), observer: true});
    expect(await reported(page)).toEqual(['https://cdn.example/film.m3u8']);
  });

  it('reports it once when the timeline has it too', async () => {
    const page = loadContentScript({entries: requests(10), observer: true});
    expect(await reported(page)).toEqual(['https://cdn.example/film.m3u8']);
  });

  it('reports what the timeline has where there is no observer', async () => {
    const page = loadContentScript({entries: requests(10)});
    expect(await reported(page)).toEqual(['https://cdn.example/film.m3u8']);
  });
});

// While a FastStream player in the tab plays, the background has every frame hold the
// page's own media paused: a site's player outside the box FastStream took over, or in
// another frame, played on under it.
describe('HOLD_PAGE_MEDIA', () => {
  /**
   * A page with a video and a sound that play.
   * @return {{page: Object, video: Object, sound: Object, play: function(Object): void}}
   */
  function playingPage() {
    const page = loadContentScript();
    const video = page.document.createElement('video');
    const sound = page.document.createElement('audio');
    page.document.body.appendChild(video);
    page.document.body.appendChild(sound);
    video.paused = false;
    sound.paused = false;
    // The page starts one again, as a site's player does: 'play' goes to the document's
    // listeners, as it does through the capture phase.
    const play = (media) => {
      media.paused = false;
      for (const {type, listener} of page.document.listeners) {
        if (type === 'play') listener({isTrusted: true, target: media});
      }
    };
    return {page, video, sound, play};
  }

  it('pauses the page\'s media, and pauses again what the page starts while held', async () => {
    const {page, video, sound, play} = playingPage();
    await page.send({type: 'HOLD_PAGE_MEDIA', hold: true});
    expect([video.paused, sound.paused]).toEqual([true, true]);
    play(video);
    play(sound);
    expect([video.paused, sound.paused]).toEqual([true, true]);
  });

  it('lets the page play once the hold ends', async () => {
    const {page, video, play} = playingPage();
    await page.send({type: 'HOLD_PAGE_MEDIA', hold: true});
    await page.send({type: 'HOLD_PAGE_MEDIA', hold: false});
    play(video);
    expect(video.paused).toBe(false);
  });

  it('pauses nothing without a hold, and nothing on a release', async () => {
    const {page, video, sound, play} = playingPage();
    await page.send({type: 'HOLD_PAGE_MEDIA', hold: false});
    expect([video.paused, sound.paused]).toEqual([false, false]);
    play(video);
    expect(video.paused).toBe(false);
  });

  it('ends with the players: REMOVE_PLAYERS lets the page play', async () => {
    const {page, video, play} = playingPage();
    await page.send({type: 'HOLD_PAGE_MEDIA', hold: true});
    await page.send({type: 'REMOVE_PLAYERS'});
    play(video);
    expect(video.paused).toBe(false);
  });

  // Firefox's back-forward cache gives a page back with its content script as it was. The
  // hold's end, sent to the tab's frames while it was in the cache, never reached it.
  it('ends when the back-forward cache gives the page back', async () => {
    const {page, video, play} = playingPage();
    await page.send({type: 'HOLD_PAGE_MEDIA', hold: true});
    page.dispatchWindow('pageshow', {persisted: true});
    play(video);
    expect(video.paused).toBe(false);
  });

  it('pauses a video already playing in a closed shadow root', async () => {
    const page = loadContentScript();
    const root = closedShadowRoot(page, page.document.body);
    const video = page.document.createElement('video');
    root.appendChild(video);
    video.paused = false;
    await page.send({type: 'HOLD_PAGE_MEDIA', hold: true});
    expect(video.paused).toBe(true);
  });

  // A watch party's voice chat in the same tab fell silent, and again on every play.
  it('leaves a call\'s live stream alone', async () => {
    const {page, video, sound, play} = playingPage();
    page.window.MediaStream = class MediaStream {};
    sound.srcObject = new page.window.MediaStream();
    await page.send({type: 'HOLD_PAGE_MEDIA', hold: true});
    expect([video.paused, sound.paused]).toEqual([true, false]);
    play(sound);
    expect(sound.paused).toBe(false);
  });

  it('leaves a play event of anything but media alone', async () => {
    const {page, play} = playingPage();
    await page.send({type: 'HOLD_PAGE_MEDIA', hold: true});
    const div = page.document.createElement('div');
    div.pause = () => {
      throw new Error('paused a div');
    };
    expect(() => play(div)).not.toThrow();
  });
});

// What the background sends every frame once mpv has the stream.
describe('PAUSE_MEDIA', () => {
  // A play in a closed shadow root was heard (listenInShadowRoots looks into closed roots)
  // and sent to mpv, but the walk that pauses looked into open roots only: the page's
  // player played on beside mpv.
  it('pauses a video playing in a closed shadow root', async () => {
    const page = loadContentScript();
    const root = closedShadowRoot(page, page.document.body);
    const video = page.document.createElement('video');
    root.appendChild(video);
    video.paused = false;
    expect(await page.send({type: 'PAUSE_MEDIA'})).toBe(1);
    expect(video.paused).toBe(true);
  });

  it('leaves a call\'s live stream alone', async () => {
    const page = loadContentScript();
    page.window.MediaStream = class MediaStream {};
    const call = page.document.createElement('audio');
    call.srcObject = new page.window.MediaStream();
    call.paused = false;
    page.document.body.appendChild(call);
    expect(await page.send({type: 'PAUSE_MEDIA'})).toBe(0);
    expect(call.paused).toBe(false);
  });
});

// The MPV key pressed while the user watches a video they started: that video is sent.
describe('MPV_REPORT_PLAYING', () => {
  it('finds the video the user started in a closed shadow root', async () => {
    const page = loadContentScript();
    const host = page.document.createElement('div');
    page.document.body.appendChild(host);
    const root = closedShadowRoot(page, host);
    const video = page.document.createElement('video');
    video.currentSrc = 'https://cdn.example/episode.mp4';
    root.appendChild(video);
    // The user's click: the roots get their play listeners, and the play counts as theirs.
    page.dispatchWindow('pointerdown');
    page.window.navigator.userActivation.isActive = true;
    video.paused = false;
    for (const {type, listener} of root.listeners) {
      if (type === 'play') listener({isTrusted: true, target: video});
    }
    page.sent.length = 0;
    expect(await page.send({type: 'MPV_REPORT_PLAYING'})).toBe(true);
    expect(page.sent.map((m) => m.type)).toEqual(['MPV_USER_PLAY']);
  });
});

// A frame links each frame below it to its iframe (FRAME_LINK_RECEIVER, then that frame
// posts the key): for windowed fullscreen, the miniplayer and the overlay guard.
describe('frame links', () => {
  it('find an embed\'s iframe in a closed shadow root', async () => {
    const page = loadContentScript();
    const host = page.document.createElement('div');
    page.document.body.appendChild(host);
    const embed = page.document.createElement('iframe');
    closedShadowRoot(page, host).appendChild(embed);
    await linkPlayer(page, embed, 7);
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 7})).toBe('enter');
  });
});

describe('a player put in a shadow root', () => {
  // A video straight in a shadow root, in a host with a bar below it (so the host is not
  // the player's box): the player goes into the root, next to the video. The resize
  // observer watched the iframe's parent, the root, which ResizeObserver refuses: the
  // throw left the player without one.
  it('has its box watched through the root\'s host', async () => {
    const page = loadContentScript();
    const {document} = page;
    document.documentElement.rect = {x: 0, y: 0, width: 1280, height: 2000};
    document.body.rect = {x: 0, y: 0, width: 1280, height: 2000};
    const host = document.createElement('div');
    host.rect = {x: 0, y: 0, width: 640, height: 420};
    document.body.appendChild(host);
    // An open shadow root: a node of its own (11), whose children have no parent element.
    const root = document.createElement('div');
    root.nodeType = 11;
    root.host = host;
    root.parentNode = host;
    host.shadowRoot = root;
    const video = document.createElement('video');
    video.rect = {x: 0, y: 0, width: 640, height: 360};
    root.appendChild(video);
    const observed = [];
    page.window.ResizeObserver = class {
      observe(target) {
        // As Firefox's: Argument 1 of ResizeObserver.observe does not implement Element.
        if (target.nodeType !== 1) throw new TypeError('ResizeObserver.observe: not an Element');
        observed.push(target);
      }
      disconnect() {}
    };
    const {answer} = await openPlayer(page);
    expect(answer).toBe('replace');
    expect(root.querySelectorAll('iframe')).toHaveLength(1);
    expect(observed).toEqual([host]);
  });
});

// A player over the whole page pauses the page's media, and again on every play, while it
// is up (pauseAllWithin). A call's live stream too: a watch party's voice chat fell silent,
// the case every other pause leaves alone (playsLiveStream).
describe('a player over the whole page', () => {
  it('leaves a call\'s live stream alone', async () => {
    const page = loadContentScript();
    page.document.documentElement.rect = {x: 0, y: 0, width: 1280, height: 720};
    page.document.body.rect = {x: 0, y: 0, width: 1280, height: 720};
    page.window.MediaStream = class MediaStream {};
    const film = page.document.createElement('audio');
    const call = page.document.createElement('audio');
    call.srcObject = new page.window.MediaStream();
    page.document.body.appendChild(film);
    page.document.body.appendChild(call);
    film.paused = false;
    call.paused = false;
    // No video on the page: opened with force (the toolbar on a page with only a stream).
    await page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, noRedirect: true, frameId: 0, parentFrameId: -1,
      attempt: 1, force: true});
    expect(page.document.querySelectorAll('iframe')).toHaveLength(1);
    expect([film.paused, call.paused]).toEqual([true, false]);

    // The page starts both again.
    for (const media of [film, call]) {
      media.paused = false;
      media.listeners.filter((l) => l.type === 'play').forEach((l) => l.listener.call(media, {target: media}));
    }
    expect([film.paused, call.paused]).toEqual([true, false]);
  });
});

// The resize observer updated the player at most every 100 ms and dropped the changes in
// between: after a box that kept changing (a sidebar sliding shut), the player kept a size
// from the middle of it until the next resize.
describe('a player whose box keeps changing', () => {
  it('takes the box\'s last size', async () => {
    const {page, wrap} = pageWithVideo();
    let resized = null;
    page.window.ResizeObserver = class {
      constructor(callback) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    };
    const {iframe} = await openPlayer(page);
    await linkPlayer(page, iframe, 5);
    page.advance(2000);
    expect(iframe.style.width).toBe('640px');

    wrap.rect = {x: 0, y: 0, width: 800, height: 450};
    resized();
    expect(iframe.style.width).toBe('800px');
    wrap.rect = {x: 0, y: 0, width: 960, height: 540};
    resized();
    page.advance(150);
    expect(iframe.style.width).toBe('960px');
  });
});

// Firefox fires beforeunload for a navigation that then never happens: a link answered
// with a download or a 204, a "Leave page?" the user said no to. The page stays, but it had
// told the background it left: the background forgot its frames and their streams, and
// refused every player the page opened after that, as one of a gone page, until a reload.
describe('a page that leaves', () => {
  /**
   * What the page told the background about itself since it started.
   * @param {Object} page - From loadContentScript.
   * @return {Array<Object>} Its FRAME_ADDED and FRAME_REMOVED after the first FRAME_ADDED.
   */
  function told(page) {
    return page.sent.filter((m) => m.type === 'FRAME_ADDED' || m.type === 'FRAME_REMOVED').slice(1);
  }

  it('says so at beforeunload, under its name', () => {
    const page = loadContentScript();
    page.dispatchWindow('beforeunload');
    expect(told(page)).toEqual([{type: 'FRAME_REMOVED', document: pageName(page)}]);
  });

  it('names itself again when it is still there a moment later, and then reports its leaving on pagehide', () => {
    const page = loadContentScript();
    page.dispatchWindow('beforeunload');
    page.advance(2000);
    const name = {url: 'https://site.example/page', document: pageName(page)};
    expect(told(page)).toEqual([
      {type: 'FRAME_REMOVED', document: name.document},
      {type: 'FRAME_ADDED', ...name},
    ]);
    // It leaves without a beforeunload (the page took its iframe out), or really leaves.
    page.dispatchWindow('pagehide', {persisted: false});
    expect(told(page).at(-1)).toEqual({type: 'FRAME_REMOVED', document: name.document});
  });

  it('reports a real leave once, at beforeunload, after it named itself again', () => {
    const page = loadContentScript();
    page.dispatchWindow('beforeunload');
    page.advance(2000);
    page.dispatchWindow('beforeunload');
    page.dispatchWindow('pagehide', {persisted: false});
    expect(told(page).map((m) => m.type)).toEqual(['FRAME_REMOVED', 'FRAME_ADDED', 'FRAME_REMOVED']);
  });

  it('does not name itself again once it went, into the back-forward cache or for good', () => {
    for (const persisted of [true, false]) {
      const page = loadContentScript();
      page.dispatchWindow('beforeunload');
      page.dispatchWindow('pagehide', {persisted});
      page.advance(10000);
      expect(told(page).map((m) => m.type), String(persisted)).toEqual(['FRAME_REMOVED']);
    }
  });

  it('tells nothing on a pagehide alone, as before (an iframe the page took out)', () => {
    const page = loadContentScript();
    page.dispatchWindow('pagehide', {persisted: false});
    page.advance(10000);
    expect(told(page)).toEqual([]);
  });

  it('tells nothing when it goes to the player, which asks for its streams', async () => {
    // handlePlayerOpen's redirect: no video, and a frame that cannot go fullscreen.
    const page = loadContentScript();
    page.document.fullscreenEnabled = false;
    expect(await page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, force: true, frameId: 3, parentFrameId: 0})).toBe('redirect');
    page.dispatchWindow('beforeunload');
    page.advance(10000);
    page.dispatchWindow('pagehide', {persisted: false});
    expect(told(page)).toEqual([]);
  });

  it('names itself again when the back-forward cache gives it back', () => {
    const page = loadContentScript();
    page.dispatchWindow('beforeunload');
    page.dispatchWindow('pagehide', {persisted: true});
    page.dispatchWindow('pageshow', {persisted: true});
    expect(told(page).map((m) => m.type)).toEqual(['FRAME_REMOVED', 'FRAME_ADDED']);
  });
});
