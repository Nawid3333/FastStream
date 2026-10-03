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
