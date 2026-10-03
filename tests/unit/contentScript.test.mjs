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
