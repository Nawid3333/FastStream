import vm from 'node:vm';
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

// A player naming a frame as its parent counts only when that frame's page opened it.
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

// SCRAPE_CAPTIONS: a track request that fails at once must not end the loop before the next track.
describe('SCRAPE_CAPTIONS', () => {
  it('waits for every track when one request fails at once', async () => {
    const page = loadContentScript({responses: {'https://cdn.example/en.vtt': 'WEBVTT'}});
    addTrack(page, 'http://[bad');
    addTrack(page, 'https://cdn.example/en.vtt');
    const tracks = await page.send({type: 'SCRAPE_CAPTIONS'});
    expect(tracks.map((track) => track.source)).toEqual(['https://cdn.example/en.vtt']);
    expect(tracks[0].data).toBe('WEBVTT');
  });

  it('asks for a track with a plain GET of its own address', async () => {
    const asked = [];
    const page = loadContentScript({responses: {'https://cdn.example/en.vtt': (init) => {
      asked.push({method: init.method, body: init.body, headers: init.headers});
      return new Response('WEBVTT', {status: 200});
    }}});
    addTrack(page, 'https://cdn.example/en.vtt');
    const tracks = await page.send({type: 'SCRAPE_CAPTIONS'});
    expect(tracks.map((track) => track.data)).toEqual(['WEBVTT']);
    expect(asked).toEqual([{method: 'GET', body: undefined, headers: undefined}]);
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

  // A page must not send the background any number of files of any size.
  it('reads at most 64 tracks', async () => {
    const responses = {};
    for (let i = 0; i < 70; i++) responses[`https://cdn.example/${i}.vtt`] = 'WEBVTT';
    const page = loadContentScript({responses});
    for (let i = 0; i < 70; i++) addTrack(page, `https://cdn.example/${i}.vtt`);
    const tracks = await page.send({type: 'SCRAPE_CAPTIONS'});
    expect(tracks).toHaveLength(64);
  });

  it('gives up the track that goes past 64 MB, and keeps the one read at the same time', async () => {
    // Two 40 MB files, read a megabyte at a time by turns.
    const megabyte = new Uint8Array(1024 * 1024).fill(0x41);
    const big = () => {
      let pulls = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (pulls++ === 40) controller.close();
          else controller.enqueue(megabyte);
        },
      }), {status: 200});
    };
    const page = loadContentScript({responses: {'https://cdn.example/a.vtt': big, 'https://cdn.example/b.vtt': big}});
    addTrack(page, 'https://cdn.example/a.vtt');
    addTrack(page, 'https://cdn.example/b.vtt');
    const tracks = await page.send({type: 'SCRAPE_CAPTIONS'});
    expect(tracks).toHaveLength(1);
    expect(tracks[0].data).toHaveLength(40 * 1024 * 1024);
  }, 30000);

  it('gives the bytes of a track that stalled back to the others', async () => {
    const megabyte = new Uint8Array(1024 * 1024).fill(0x41);
    // A: 60 MB at once, then nothing; stopped when nothing has come for 2 s.
    const stalling = (init) => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 60; i++) controller.enqueue(megabyte);
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
      },
    }), {status: 200});
    // B: 1 MB, 1 MB when let go, then 4 MB when let go again: 66 MB with A's.
    const gates = [Promise.withResolvers(), Promise.withResolvers()];
    const pieces = [() => [megabyte], async () => (await gates[0].promise, [megabyte]),
      async () => (await gates[1].promise, [megabyte, megabyte, megabyte, megabyte])];
    const slow = () => new Response(new ReadableStream({
      async pull(controller) {
        const piece = pieces.shift();
        if (!piece) return controller.close();
        for (const chunk of await piece()) controller.enqueue(chunk);
      },
    }), {status: 200});
    const page = loadContentScript({responses: {'https://cdn.example/a.vtt': stalling, 'https://cdn.example/b.vtt': slow}});
    addTrack(page, 'https://cdn.example/a.vtt');
    addTrack(page, 'https://cdn.example/b.vtt');
    const answer = page.send({type: 'SCRAPE_CAPTIONS'});
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    // B's second megabyte a second later, so that only A has had nothing for 2 s.
    page.advance(1000);
    gates[0].resolve();
    await settle();
    page.advance(1000);
    await settle();
    gates[1].resolve();
    const tracks = await answer;
    expect(tracks.map((track) => [track.source, track.data.length])).toEqual([['https://cdn.example/b.vtt', 6 * 1024 * 1024]]);
  }, 30000);
});

const PLAYER_URL = 'moz-extension://test/player/index.html';

/**
 * Gives an element a closed shadow root as Firefox shows one to a content script (shadowRoot null).
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
 * A page with a 640x360 video in a same-size wrapper (#wrap), which a player replaces.
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
 * Links a player that loaded in an iframe to it, as the background and the player do.
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

// Opening or removing a player sends the background no message nobody reads.
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

  it('keeps the player at the measured size when it takes over the element\'s border', async () => {
    const {page} = pageWithVideo();
    const {iframe} = await openPlayer(page);
    expect(iframe.style.getPropertyValue('width')).toBe('640px');
    expect(iframe.style.getPropertyValue('box-sizing')).toBe('border-box');
  });

  it('answers when the page\'s video cannot be measured', async () => {
    const {page, video} = pageWithVideo();
    video.getBoundingClientRect = () => {
      throw new Error('can\'t access dead object');
    };
    const answer = page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, noRedirect: true, frameId: 0, parentFrameId: -1, attempt: 1});
    const late = new Promise((resolve) => setTimeout(() => resolve('no answer'), 200));
    expect(await Promise.race([answer, late])).toBe('error');
  });

  it('pauses the page\'s video when it is the element replaced itself', async () => {
    const {page, wrap, video} = pageWithVideo();
    wrap.rect = {x: 0, y: 0, width: 1280, height: 720};
    video.paused = false;
    const {answer, iframe} = await openPlayer(page);
    expect(answer).toBe('replace');
    expect(iframe.id).toBe('');
    expect(video.paused).toBe(true);
  });
});

// hideSoft and showSoft keep and give back the page's own inline styles.
describe('the page\'s own inline styles after a soft replace', () => {
  it('come back as they were, !important too, and a later replace restores nothing stale', async () => {
    const {page, wrap} = pageWithVideo();
    wrap.setAttribute('style', 'width: 640px; overflow: hidden; margin: 0px !important;');
    let {iframe} = await openPlayer(page);
    await linkPlayer(page, iframe, 5);
    expect(wrap.style.width).toBe('0px');
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(wrap.style.getPropertyValue('width')).toBe('640px');
    expect(wrap.style.getPropertyValue('overflow')).toBe('hidden');
    expect(wrap.style.getPropertyValue('margin')).toBe('0px');
    expect(wrap.style.getPropertyPriority('margin')).toBe('important');
    expect(wrap.style.getPropertyValue('height')).toBe('');
    expect(Object.keys(wrap.dataset).filter((key) => /^(old|fsSoft)/.test(key))).toEqual([]);

    // the page drops its width; the next player must not bring the old one back
    wrap.style.removeProperty('width');
    ({iframe} = await openPlayer(page));
    await linkPlayer(page, iframe, 6);
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(wrap.style.getPropertyValue('width')).toBe('');
  });

  it('take no share of a flex box while hidden, and the page\'s flex comes back', async () => {
    // An element sized by `flex: 1 1 0%` in a column keeps half the box at height 0 (as on
    // bilibili).
    const {page, wrap} = pageWithVideo();
    wrap.setAttribute('style', 'flex-grow: 1; flex-basis: 0%;');
    const {iframe} = await openPlayer(page);
    await linkPlayer(page, iframe, 5);
    expect(wrap.style.getPropertyValue('flex-grow')).toBe('0');
    expect(wrap.style.getPropertyValue('flex-basis')).toBe('0px');
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(wrap.style.getPropertyValue('flex-grow')).toBe('1');
    expect(wrap.style.getPropertyValue('flex-basis')).toBe('0%');
  });

  // a value the page set while the player was up wins
  it('come back as the page set them last, while the player was up', async () => {
    const {page, wrap} = pageWithVideo();
    wrap.setAttribute('style', 'width: 640px;');
    const {iframe} = await openPlayer(page);
    await linkPlayer(page, iframe, 5);
    page.advance(2000);
    wrap.style.setProperty('width', '500px');
    wrap.rect = {x: 0, y: 0, width: 500, height: 360};
    page.dispatchWindow('resize');
    page.advance(150);
    expect(iframe.style.width).toBe('500px');
    expect(wrap.style.getPropertyValue('width')).toBe('0px');
    // the saves are not in the page's DOM, for the page to change
    expect(Object.keys(wrap.dataset).filter((key) => /^(old|fsSoft)/.test(key))).toEqual([]);
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(wrap.style.getPropertyValue('width')).toBe('500px');
  });
});

// The answer is the visible area, a number the background sorts frames by.
describe('OPEN_PLAYER overtaken by REMOVE_PLAYERS', () => {
  it('puts no player in the page given back meanwhile', async () => {
    // A removal while the open waits for visibility gives the page back, and the open must not go
    // on.
    const {page, wrap} = pageWithVideo();
    const opening = page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, noRedirect: true, frameId: 0, parentFrameId: -1, attempt: 1});
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(await opening).toBe('error');
    expect(page.document.querySelectorAll('iframe').filter((f) => f.src.startsWith(PLAYER_URL))).toEqual([]);
    expect(wrap.children.map((el) => el.tagName)).toEqual(['VIDEO']);
  });
});

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

// A page with no video, where the frame cannot go fullscreen, goes to the player itself: its
// beforeunload then tells the background nothing (the player asks for the frame's sources).
describe('the redirect to the player', () => {
  it('lays the player over a frame the page wrote (about:srcdoc) instead: the page\'s script drives it', async () => {
    const page = loadContentScript();
    page.document.fullscreenEnabled = false;
    page.window.location = {...page.window.location, href: 'about:srcdoc', protocol: 'about:', origin: 'null', pathname: 'srcdoc'};
    expect(await page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, frameId: 0, parentFrameId: -1,
      attempt: 1, force: true})).toBe('replaceall');
  });

  it('lays it over an about:blank frame the page wrote too, which document.open() gave the page\'s address', async () => {
    const page = loadContentScript({inFrame: true,
      location: {hostname: '', href: 'about:blank', protocol: 'about:', origin: 'null', pathname: 'blank', search: ''}});
    page.document.fullscreenEnabled = false;
    page.window.location = {hostname: 'site.example', href: 'https://site.example/page', protocol: 'https:',
      origin: 'https://site.example', pathname: '/page', search: ''};
    expect(await page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, frameId: 3, parentFrameId: 0,
      attempt: 1, force: true})).toBe('replaceall');
  });

  it('reports the page\'s next leave once it stayed after all', async () => {
    const page = loadContentScript();
    page.document.fullscreenEnabled = false;
    expect(await page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, frameId: 0, parentFrameId: -1,
      attempt: 1, force: true})).toBe('redirect');
    const removed = () => page.sent.filter((message) => message.type === 'FRAME_REMOVED').length;
    page.dispatchWindow('beforeunload');
    expect(removed()).toBe(0);
    // A "Leave page?" the user said no to: the page is still here. Its next leave is told.
    page.dispatchWindow('beforeunload');
    expect(removed()).toBe(1);
  });

  it('tells nothing when the old page goes slowly, after a leave that never happened', async () => {
    // a page back from a cancelled leave reports its pagehide later
    const page = loadContentScript();
    page.document.fullscreenEnabled = false;
    const removed = () => page.sent.filter((message) => message.type === 'FRAME_REMOVED').length;
    page.dispatchWindow('beforeunload');
    page.advance(2000);
    expect(removed()).toBe(1);
    expect(await page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, frameId: 0, parentFrameId: -1,
      attempt: 1, force: true})).toBe('redirect');
    page.dispatchWindow('beforeunload');
    page.advance(5000);
    page.dispatchWindow('pagehide', {persisted: false});
    expect(removed()).toBe(1);
  });
});

// A click on the player moves the focus into its iframe and blurs the page: the moment a
// site's own blur handler opens a pop-up. The background's guard is armed then.
describe('the pop-up guard', () => {
  const armed = (page) => page.sent.filter((message) => message.type === 'POPUP_GUARD_ARM').length;

  it('is armed when the focus goes into the player, in a shadow root too', async () => {
    const {page, iframe} = await pageWithPlayer();
    page.document.activeElement = iframe;
    page.dispatchWindow('blur');
    expect(armed(page)).toBe(1);
    // A player in a web component's root: the document's active element is the host.
    const [host] = addElements(page, 1);
    const root = closedShadowRoot(page, host);
    root.activeElement = iframe;
    page.document.activeElement = host;
    page.dispatchWindow('blur');
    expect(armed(page)).toBe(2);
  });

  it('is not armed when something else of the page has the focus', async () => {
    const {page} = await pageWithPlayer();
    const [other] = addElements(page, 1);
    page.document.activeElement = other;
    page.dispatchWindow('blur');
    expect(armed(page)).toBe(0);
  });
});

// Windowed fullscreen hides every other element: linear on a 50,000-element page, and never the
// <head>'s.
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

  it('gives what holds the player its style back, and keeps what the page wrote to it meanwhile', async () => {
    // A page that draws the element again while the player fills the screen keeps what it drew.
    for (const pageWrites of [false, true]) {
      const {page, iframe} = await pageWithPlayer();
      // What the page draws the player in (the player is the body's here).
      const wrap = page.document.createElement('div');
      page.document.body.appendChild(wrap);
      wrap.appendChild(iframe);
      wrap.setAttribute('style', 'width: 50px; transform: scale(2);');
      await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5});
      expect(wrap.style.getPropertyValue('position')).toBe('fixed');
      expect(wrap.style.getPropertyValue('transform')).toBe('');
      if (pageWrites) {
        wrap.style.setProperty('color', 'blue');
        wrap.style.setProperty('width', '70px');
      }
      await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5});
      expect(wrap.style.getPropertyValue('position')).toBe('');
      expect(wrap.style.getPropertyValue('transform')).toBe('scale(2)');
      if (pageWrites) {
        expect(wrap.style.getPropertyValue('color')).toBe('blue');
        expect(wrap.style.getPropertyValue('width')).toBe('70px');
      } else {
        expect(wrap.getAttribute('style')).toBe('width: 50px; transform: scale(2);');
      }
    }
  });

  it('stays out when told to leave before it was ever entered', async () => {
    // a frame's state starts empty: force false must not enter
    const {page, iframe} = await pageWithPlayer();
    const [plain] = addElements(page, 1);
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5, force: false})).toBe('exit');
    expect(plain.style.getPropertyValue('display')).toBe('');
    expect(iframe.style.getPropertyValue('position')).not.toBe('fixed');
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5, force: true})).toBe('enter');
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5, force: true})).toBe('enter');
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5, force: false})).toBe('exit');
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

  // A bar the overlay guard gave back meanwhile must not stay hidden after windowed fullscreen.
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

  it('gives the page its own bar over an embed back once the player under it went', async () => {
    // The embed's own page went elsewhere (same iframe, same src): the bar the guard hid comes
    // back.
    const page = loadContentScript();
    const {document} = page;
    document.documentElement.rect = {x: 0, y: 0, width: 1280, height: 2000};
    document.body.rect = {x: 0, y: 0, width: 1280, height: 2000};
    const embed = document.createElement('iframe');
    embed.src = 'https://embed.example/e/1';
    embed.rect = {x: 0, y: 0, width: 640, height: 360};
    document.body.appendChild(embed);
    const bar = document.createElement('div');
    bar.rect = {x: 0, y: 320, width: 640, height: 40};
    document.body.appendChild(bar);
    await linkPlayer(page, embed, 7);
    await page.send({type: 'IS_FULL', frameId: 7});
    expect(bar.style.getPropertyValue('visibility')).toBe('hidden');

    // Another iframe's release leaves this one's guard alone.
    await page.send({type: 'RELEASE_OVERLAY_GUARD', frameId: 8});
    expect(bar.style.getPropertyValue('visibility')).toBe('hidden');

    await page.send({type: 'RELEASE_OVERLAY_GUARD', frameId: 7});
    expect(bar.style.getPropertyValue('visibility')).toBe('');
    // Let go for good: the guard's check no longer runs.
    page.runIntervals();
    expect(bar.style.getPropertyValue('visibility')).toBe('');
  });

  it('fits the player to its place at once when it ends', async () => {
    // The fit uses the box the page has after it gets its styles back.
    const {page, wrap, video, iframe} = await pageWithPlayer();
    await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5});
    // The page's box for the video changed meanwhile (the window was made larger).
    wrap.rect = {x: 0, y: 0, width: 800, height: 450};
    video.rect = {x: 0, y: 0, width: 800, height: 450};
    await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5});
    expect(iframe.style.getPropertyValue('width')).toBe('800px');
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

  it('keeps the player for a link the page\'s <base target> opens in a new tab', async () => {
    // <base target="_blank">: a link that opens a new tab keeps the player in this one.
    const {page, iframe} = await pageWithPlayer();
    const base = page.document.createElement('base');
    base.setAttribute('target', '_blank');
    page.document.head.appendChild(base);
    const a = page.document.createElement('a');
    a.href = 'https://site.example/other';
    page.document.body.appendChild(a);
    page.dispatchDocument('click', {target: a, button: 0});
    page.advance(0);
    expect(iframe.isConnected).toBe(true);
    // Without one, the link leaves the page here, and the player goes as before (once the
    // page's own listeners had the click).
    base.remove();
    page.dispatchDocument('click', {target: a, button: 0});
    page.advance(0);
    expect(iframe.isConnected).toBe(false);
  });

  it('takes the player down for a link clicked inside a web component', async () => {
    // A click in an open shadow root: the walk starts from the composed path, not the host.
    const {page, iframe} = await pageWithPlayer();
    const [host] = addElements(page, 1);
    const root = page.document.createElement('div');
    root.nodeType = 11;
    root.host = host;
    root.parentNode = host;
    host.shadowRoot = root;
    const a = page.document.createElement('a');
    a.href = 'https://site.example/other';
    root.appendChild(a);
    page.dispatchDocument('click', {target: host, button: 0, composedPath: () => [a, root, host, page.document.body]});
    page.advance(0);
    expect(iframe.isConnected).toBe(false);
  });

  it('gives the page back when the page takes the player out', async () => {
    // A page that draws its player again takes the iframe out: the rest of the page comes back.
    const {page, iframe} = await pageWithPlayer();
    const [plain] = addElements(page, 1);
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 5})).toBe('enter');
    expect(plain.style.getPropertyValue('display')).toBe('none');
    iframe.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(plain.style.getPropertyValue('display')).toBe('');
  });
});

// A same-site link takes the player down; a click the page's own listener cancels does not.
describe('a click on a link to another page of the site', () => {
  /**
   * Clicks a link in the page: content.js's listener has the click first, then the page's.
   * @param {Object} page - From loadContentScript.
   * @param {Object} a - The link.
   * @param {function(Object): void} [pageListener] - The page's own listener.
   */
  function click(page, a, pageListener) {
    const event = {type: 'click', isTrusted: true, target: a, button: 0, defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      }};
    for (const {type, listener} of page.document.listeners) {
      if (type === 'click') listener(event);
    }
    if (pageListener) pageListener(event);
  }

  /**
   * @param {Object} page - From loadContentScript.
   * @return {Object} A link to another page of the site.
   */
  function linkElsewhere(page) {
    const a = page.document.createElement('a');
    a.href = 'https://site.example/login';
    page.document.body.appendChild(a);
    return a;
  }

  it('keeps the player when the page handles the link itself', async () => {
    const {page, iframe} = await pageWithPlayer();
    click(page, linkElsewhere(page), (event) => event.preventDefault());
    page.advance(0);
    expect(iframe.isConnected).toBe(true);
  });

  it('takes the player down when the page leaves the link to the browser', async () => {
    const {page, iframe} = await pageWithPlayer();
    click(page, linkElsewhere(page));
    page.advance(0);
    expect(iframe.isConnected).toBe(false);
  });

  it('takes the player down when the page cancels the link and goes there itself', async () => {
    // A single-page site's router: the address changes, the page does not load.
    const {page, iframe} = await pageWithPlayer();
    click(page, linkElsewhere(page), (event) => {
      event.preventDefault();
      page.window.location.pathname = '/login';
    });
    page.advance(0);
    expect(iframe.isConnected).toBe(false);
  });
});

// REMOVE_PLAYERS also gives the embed iframe its own style back after windowed fullscreen.
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

  it('leaves an element the page closed during windowed fullscreen closed', async () => {
    const page = loadContentScript();
    const embed = page.document.createElement('iframe');
    page.document.body.appendChild(embed);
    const menu = page.document.createElement('div');
    menu.setAttribute('style', 'display: block;');
    page.document.body.appendChild(menu);
    await linkPlayer(page, embed, 7);
    expect(await page.send({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 7})).toBe('enter');
    expect(menu.style.getPropertyPriority('display')).toBe('important');
    menu.style.setProperty('display', 'none');
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(menu.style.getPropertyValue('display')).toBe('none');
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
// corner, with a placeholder in its place.
describe('TOGGLE_MINIPLAYER', () => {
  it('lifts only the iframe inside display: contents wrappers', async () => {
    const {page, wrap, video} = pageWithVideo();
    const [outer] = addElements(page, 1);
    outer.appendChild(wrap);
    for (const element of [outer, wrap]) {
      element.computed = {display: 'contents'};
      element.rect = {x: 0, y: 0, width: 0, height: 0};
    }
    const other = page.document.createElement('button');
    outer.appendChild(other);
    const {iframe} = await openPlayer(page);
    iframe.rect = video.rect;
    await linkPlayer(page, iframe, 5);
    expect(await requestMiniplayer(page)).toBe('enter');
    expect(iframe.style.position).toBe('fixed');
    expect(wrap.style.position).not.toBe('fixed');
    expect(outer.style.position).not.toBe('fixed');
    expect(other.parentNode).toBe(outer);
    const siblings = wrap.children;
    const placeholder = siblings[siblings.indexOf(iframe) - 1];
    expect(placeholder.tagName).toBe('DIV');
    expect(placeholder.style.width).toBe('640px');
    expect(placeholder.style.height).toBe('360px');
  });

  it('answers, and changes nothing, when the page took the player\'s iframe out', async () => {
    // no throw on the missing parent
    const {page, iframe} = await pageWithPlayer();
    iframe.remove();
    const childrenBefore = page.document.body.children.length;
    expect(await requestMiniplayer(page)).toBe('exit');
    expect(page.document.body.children.length).toBe(childrenBefore);
  });

  it('stays out when told to leave before it was ever entered', async () => {
    const {page, iframe} = await pageWithPlayer();
    expect(await page.send({type: 'TOGGLE_MINIPLAYER', frameId: 5, playerFrameId: 5, force: false, size: 0.25,
      styles: {bottom: '0px', right: '0px'}})).toBe('exit');
    expect(iframe.style.getPropertyValue('position')).not.toBe('fixed');
  });

  it('never makes the body the miniplayer', async () => {
    // A wrapper that came to fill the body: the body is never the element moved to the corner.
    const {page, iframe} = await pageWithPlayer();
    iframe.rect = {x: 0, y: 0, width: 1280, height: 2000};
    expect(await requestMiniplayer(page)).toBe('enter');
    expect(page.document.documentElement.children.map((el) => el.tagName)).toEqual(['HEAD', 'BODY']);
    expect(page.document.body.getAttribute('style')).toBeNull();
    expect(iframe.style.getPropertyValue('position')).toBe('fixed');
  });

  // The placeholder is a <div>: a copy of the element's tag would run a new browsing context or the
  // site's own code.
  it('stands a <div> in for the player\'s iframe', async () => {
    const {page, iframe} = await pageWithPlayer();
    expect(await requestMiniplayer(page)).toBe('enter');
    expect(page.document.querySelectorAll('iframe')).toEqual([iframe]);
    const siblings = iframe.parentNode.children;
    expect(siblings[siblings.indexOf(iframe) - 1].tagName).toBe('DIV');
  });

  it('stands a <div> in for a site\'s custom element, and its own tag for any other wrapper', async () => {
    // Any other: the page's rules for that tag (margins) hold the page's layout as it did.
    for (const tag of ['site-player', 'section']) {
      const page = loadContentScript();
      const {document} = page;
      document.documentElement.rect = {x: 0, y: 0, width: 1280, height: 2000};
      document.body.rect = {x: 0, y: 0, width: 1280, height: 2000};
      // The site's player: its video, and a bar below it.
      const sitePlayer = document.createElement(tag);
      sitePlayer.rect = {x: 0, y: 0, width: 640, height: 400};
      const wrap = document.createElement('div');
      wrap.rect = {x: 0, y: 0, width: 640, height: 360};
      const video = document.createElement('video');
      video.rect = {x: 0, y: 0, width: 640, height: 360};
      wrap.appendChild(video);
      sitePlayer.appendChild(wrap);
      document.body.appendChild(sitePlayer);
      const {iframe} = await openPlayer(page);
      await linkPlayer(page, iframe, 5);
      expect(iframe.parentNode).toBe(sitePlayer);
      // The player fills the site's player now: that is what the miniplayer takes.
      iframe.rect = {x: 0, y: 0, width: 640, height: 400};
      expect(await requestMiniplayer(page)).toBe('enter');
      expect(document.body.children.map((el) => el.tagName)).toEqual([tag === 'section' ? 'SECTION' : 'DIV', tag.toUpperCase()]);
    }
  });

  it('gives the miniplayer a size when its placeholder has none', async () => {
    // laid out at 0x0 here: no NaN sizes
    const {page, iframe} = await pageWithPlayer();
    expect(await requestMiniplayer(page)).toBe('enter');
    expect(iframe.style.getPropertyValue('width')).toMatch(/^[\d.]+px$/);
    expect(iframe.style.getPropertyValue('height')).toMatch(/^[\d.]+px$/);
  });

  it('fits a portrait player into its share of the screen, height too', async () => {
    // Sized by the screen's shorter measure, so a portrait player's miniplayer stays small.
    const {page, iframe} = await pageWithPlayer();
    const create = page.document.createElement.bind(page.document);
    page.document.createElement = (tag) => {
      const el = create(tag);
      el.rect = {x: 0, y: 0, width: 360, height: 640};
      return el;
    };
    expect(await requestMiniplayer(page)).toBe('enter');
    page.document.createElement = create;
    const height = parseFloat(iframe.style.getPropertyValue('height'));
    const width = parseFloat(iframe.style.getPropertyValue('width'));
    expect(height).toBeLessThanOrEqual(1080 * 0.25 + 0.5);
    expect(width / height).toBeCloseTo(360 / 640);
  });
});

// A soft replace whose element collapses (under 100 px square) turns hard, also for a player linked
// late.
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

// "Reload Frame" on the player links the same iframe again: leaving still gives the page back.
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

// REPORT_LOADED_MEDIA: the manifest is reported even after more requests than the timeline keeps
// (250).
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

  it('names a srcdoc frame\'s media by the page it is in, which its requests name as theirs, never by a <base>', async () => {
    const page = loadContentScript({entries: requests(1), observer: true, inFrame: true});
    const srcdoc = {...page.window.location, href: 'about:srcdoc', protocol: 'about:', origin: 'null', pathname: 'srcdoc'};
    page.window.location = srcdoc;
    page.document.baseURI = 'http://127.0.0.1/';
    const top = {location: {href: 'https://site.example/watch/1', protocol: 'https:'}};
    top.parent = top;
    page.window.parent = {location: srcdoc, parent: top};
    expect(await reported(page)).toEqual(['https://cdn.example/film.m3u8']);
    expect(page.sent.find((message) => message.type === 'LOADED_MEDIA').url).toBe('https://site.example/watch/1');
  });

  it('keeps a sandboxed srcdoc frame\'s own address, its page out of reach', async () => {
    const page = loadContentScript({entries: requests(1), observer: true, inFrame: true});
    page.window.location = {...page.window.location, href: 'about:srcdoc', protocol: 'about:', origin: 'null', pathname: 'srcdoc'};
    page.window.parent = {get location() {
      throw new Error('SecurityError');
    }};
    await reported(page);
    expect(page.sent.find((message) => message.type === 'LOADED_MEDIA').url).toBe('about:srcdoc');
  });

  /**
   * Requests a page's player makes with fetch, each to an address of its own.
   * @param {number} count - How many.
   * @param {function(number): string} url - The i-th one's address.
   * @param {number} from - The first one's start time.
   * @return {Array<Object>} Resource Timing entries.
   */
  function fetches(count, url, from) {
    return Array.from({length: count}, (_, i) =>
      ({name: url(i), initiatorType: 'fetch', responseStatus: 200, startTime: from + i}));
  }

  // The newest manifest is reported on a long-lived page, past the observer's 1,000 entries.
  it('reports a manifest the page asked for after 1,200 other requests of the kind', async () => {
    const entries = requests(300).slice(0, 300);
    entries.push(...fetches(1200, (i) => `https://api.example/item${i}.json`, 300));
    entries.push({name: 'https://cdn.example/next.m3u8', initiatorType: 'fetch', responseStatus: 200, startTime: 1500});
    const urls = await reported(loadContentScript({entries, observer: true}));
    expect(urls).toContain('https://cdn.example/next.m3u8');
    // The timeline's 250 are images; the observer keeps 1,000 at most.
    expect(urls.length).toBeLessThanOrEqual(1000);
  });

  it('keeps a manifest asked for once while thousands of its segments follow', async () => {
    for (const [manifest, segment] of [
      ['https://cdn.example/film.m3u8', (i) => `https://cdn.example/seg${i}.ts`],
      // Through a proxy that names the stream in its query, segments as well.
      ['https://proxy.example/get?url=https%3A%2F%2Fcdn.example%2Ffilm.m3u8',
        (i) => `https://proxy.example/get?url=https%3A%2F%2Fcdn.example%2Fseg${i}.ts`],
    ]) {
      const entries = requests(300).slice(0, 300);
      entries.push({name: manifest, initiatorType: 'fetch', responseStatus: 200, startTime: 300});
      entries.push(...fetches(3000, segment, 301));
      const urls = await reported(loadContentScript({entries, observer: true}));
      expect(urls).toContain(manifest);
      expect(urls.length).toBeLessThanOrEqual(1000);
    }
  });

  it('reports what the timeline has where there is no observer', async () => {
    const page = loadContentScript({entries: requests(10)});
    expect(await reported(page)).toEqual(['https://cdn.example/film.m3u8']);
  });
});

// HOLD_PAGE_MEDIA: every frame keeps the page's own media paused while a FastStream player plays.
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

  // The hold's end must reach a page the bfcache gives back.
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

  // a watch party's voice chat in the same tab plays on
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
  // A play heard in a closed shadow root is paused there too.
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
  // MPV switched on over a YouTube video page (background startMpv): its video, though it autoplayed or is paused.
  it('reports any video with a file, with the address of its page, only when asked for any and only in the top page', async () => {
    for (const [inFrame, any, reported] of [[false, true, true], [false, undefined, false], [true, true, false]]) {
      const page = loadContentScript({inFrame});
      const video = page.document.createElement('video');
      video.currentSrc = 'blob:https://site.example/1';
      video.currentTime = 95;
      page.document.body.appendChild(video);
      page.sent.length = 0;
      expect(await page.send({type: 'MPV_REPORT_PLAYING', any}), JSON.stringify({inFrame, any})).toBe(reported);
      expect(page.sent.filter((m) => m.type === 'MPV_USER_PLAY')).toEqual(reported ?
        [expect.objectContaining({page: 'https://site.example/page', video: expect.objectContaining({time: 95})})] : []);
    }
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

// Fullscreen of an iframe in a shadow root: the document's fullscreenElement is the root's host.
describe('fullscreen of an iframe in a shadow root', () => {
  /**
   * A page with an embed's iframe (frame 7) in a closed shadow root, linked, and Firefox's
   * fullscreen of it.
   * @return {Promise<{page: Object, root: Object, embed: Object}>}
   */
  async function embedInShadowRoot() {
    const page = loadContentScript();
    const host = page.document.createElement('div');
    page.document.body.appendChild(host);
    const root = closedShadowRoot(page, host);
    root.nodeType = 11;
    root.host = host;
    root.fullscreenElement = null;
    const embed = page.document.createElement('iframe');
    root.appendChild(embed);
    embed.requestFullscreen = async () => {
      page.document.fullscreenElement = host;
      root.fullscreenElement = embed;
    };
    page.document.exitFullscreen = async () => {
      page.document.fullscreenElement = null;
      root.fullscreenElement = null;
    };
    await linkPlayer(page, embed, 7);
    return {page, root, embed};
  }

  const toggle = (page) => page.send({type: 'TOGGLE_FULLSCREEN', frameId: 7, playerFrameId: 7});

  it('leaves fullscreen on the toggle', async () => {
    const {page, root} = await embedInShadowRoot();
    expect(await toggle(page)).toBe('enter');
    page.dispatchDocument('fullscreenchange');
    expect(await toggle(page)).toBe('exit');
    expect(root.fullscreenElement).toBe(null);
  });

  it('tells the player nothing on entering, and that it left on leaving', async () => {
    const {page} = await embedInShadowRoot();
    await toggle(page);
    page.sent.length = 0;
    page.dispatchDocument('fullscreenchange');
    expect(page.sent).toEqual([]);
    // Left by Escape.
    await page.document.exitFullscreen();
    page.dispatchDocument('fullscreenchange');
    expect(page.sent.map((m) => m.data)).toEqual([{type: 'fullscreen-state', value: false}]);
  });
});

describe('a player put in a shadow root', () => {
  // A video straight in a shadow root: ResizeObserver refuses the root, so the host is watched.
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

    // The component renders again and takes the player out before it links: the frame stops
    // opening.
    const [iframe] = root.querySelectorAll('iframe');
    root.removeChild(iframe);
    await Promise.resolve();
    await Promise.resolve();
    expect(page.sent.filter((message) => message.type === 'PLAYER_OPEN_GONE')).toEqual([
      {type: 'PLAYER_OPEN_GONE', attempt: 1},
    ]);
  });
});

// A player over the whole page pauses the page's media on every play, except a call's live stream.
describe('a player over the whole page', () => {
  it('pauses the page\'s media in a closed shadow root too', async () => {
    const page = loadContentScript();
    page.document.documentElement.rect = {x: 0, y: 0, width: 1280, height: 720};
    page.document.body.rect = {x: 0, y: 0, width: 1280, height: 720};
    const [host] = addElements(page, 1);
    const root = closedShadowRoot(page, host);
    const music = page.document.createElement('audio');
    root.appendChild(music);
    music.paused = false;
    await page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, noRedirect: true, frameId: 0, parentFrameId: -1,
      attempt: 1, force: true});
    expect(music.paused).toBe(true);
  });

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

  /**
   * Playing <audio> elements. Not in an async test: a loop there keeps its last element alive
   * across awaits.
   * @param {Object} parent - The element.
   * @param {number} count - How many.
   * @return {Array<Object>}
   */
  function addPlayingAudio(parent, count) {
    const media = Array.from({length: count}, () => parent.ownerDocument.createElement('audio'));
    for (const medium of media) {
      parent.appendChild(medium);
      medium.paused = false;
    }
    return media;
  }

  /**
   * A page with a player over it, opened with these media in the page.
   * @param {number} count - How many <audio> elements.
   * @return {Promise<{page: Object, media: Array<Object>}>}
   */
  async function pageWithMedia(count) {
    const page = loadContentScript();
    page.document.documentElement.rect = {x: 0, y: 0, width: 1280, height: 720};
    page.document.body.rect = {x: 0, y: 0, width: 1280, height: 720};
    const media = addPlayingAudio(page.document.body, count);
    await page.send({type: 'OPEN_PLAYER', url: PLAYER_URL, noRedirect: true, frameId: 0, parentFrameId: -1,
      attempt: 1, force: true});
    return {page, media};
  }
  const play = (medium) => {
    medium.paused = false;
    medium.listeners.filter((l) => l.type === 'play').forEach((l) => l.listener.call(medium, {target: medium}));
  };

  it('keeps none of the media the page dropped meanwhile alive', async () => {
    // The paused media are not kept alive until the player goes (pages that add and drop media).
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    // In the element the player replaces: a player over the whole page holds every element
    // it hid itself (to give each its style back), the page's media among them.
    const {page, wrap} = pageWithVideo();
    const media = addPlayingAudio(wrap, 50);
    await openPlayer(page);
    expect(media.every((medium) => medium.paused)).toBe(true);
    // The page drops them (a function of its own, for the reason addPlayingAudio gives).
    const refs = ((dropped) => {
      for (const medium of dropped) medium.remove();
      return dropped.map((medium) => new WeakRef(medium));
    })(media.splice(0));
    for (let i = 0; i < 5 && refs.some((ref) => ref.deref()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
    }
    expect(refs.map((ref, i) => ref.deref() ? i : -1).filter((i) => i >= 0)).toEqual([]);
  });

  it('pauses a medium the page took out while the player is up, and lets it play after', async () => {
    const {page, media: [kept]} = await pageWithMedia(1);
    kept.remove();
    play(kept);
    expect(kept.paused).toBe(true);
    await page.send({type: 'REMOVE_PLAYERS'});
    play(kept);
    expect(kept.paused).toBe(false);
  });

  it('takes its listener off the media still in the page when the player goes', async () => {
    const {page, media: [medium]} = await pageWithMedia(1);
    await page.send({type: 'REMOVE_PLAYERS'});
    expect(medium.listeners.filter((l) => l.type === 'play')).toEqual([]);
  });
});

// The player follows a box that keeps changing to its last size.
describe('a player whose box keeps changing', () => {
  it('watches the nearest box above display: contents wrappers and follows its resize', async () => {
    const {page, wrap, video} = pageWithVideo();
    const [box, outer] = addElements(page, 2);
    box.rect = {x: 0, y: 0, width: 640, height: 420};
    box.appendChild(outer);
    outer.appendChild(wrap);
    for (const element of [outer, wrap]) {
      element.computed = {display: 'contents'};
      element.rect = {x: 0, y: 0, width: 0, height: 0};
    }
    const observers = new Map();
    page.window.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        observers.set(target, this.callback);
      }
      disconnect() {}
    };
    const {answer, iframe} = await openPlayer(page);
    expect(answer).toBe('replace');
    expect(iframe.parentNode).toBe(wrap);
    expect([...observers.keys()]).toEqual([box]);
    await linkPlayer(page, iframe, 5);
    page.advance(2000);
    expect(iframe.style.width).toBe('640px');

    box.rect = {x: 0, y: 0, width: 800, height: 500};
    video.rect = {x: 0, y: 0, width: 800, height: 450};
    observers.get(box)();
    page.advance(150);
    expect(iframe.style.width).toBe('800px');
    expect(iframe.style.height).toBe('450px');
  });

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

  // window resizes update the players at most every 100 ms
  it('follows a window being resized at most every 100 ms, and to its last size', async () => {
    const {page, wrap} = pageWithVideo();
    const {iframe} = await openPlayer(page);
    await linkPlayer(page, iframe, 5);
    page.advance(2000);
    wrap.rect = {x: 0, y: 0, width: 800, height: 450};
    page.dispatchWindow('resize');
    expect(iframe.style.width).toBe('800px');
    wrap.rect = {x: 0, y: 0, width: 900, height: 500};
    page.dispatchWindow('resize');
    expect(iframe.style.width).toBe('800px');
    page.advance(150);
    expect(iframe.style.width).toBe('900px');
  });

  // A throw while measuring must not leave the player hidden.
  it('keeps the player as it was when the page refuses the measurement, and measures again at the next resize', async () => {
    const {page, wrap, video} = pageWithVideo();
    const {iframe} = await openPlayer(page);
    await linkPlayer(page, iframe, 5);
    page.advance(2000);
    const style = iframe.getAttribute('style');
    const id = iframe.id;
    expect(iframe.style.display).not.toBe('none');

    // Whatever is measured (the page's element, or a stand-in in its place) throws.
    const parent = iframe.parentNode;
    const children = parent.children.length;
    const measure = page.window.getComputedStyle;
    page.window.getComputedStyle = (element, ...rest) => {
      if (element !== iframe && element !== page.document.documentElement && element !== page.document.body) {
        throw new Error('a page script threw');
      }
      return measure(element, ...rest);
    };
    wrap.rect = {x: 0, y: 0, width: 800, height: 450};
    page.dispatchWindow('resize');
    expect(iframe.getAttribute('style')).toBe(style);
    expect(iframe.style.display).not.toBe('none');
    expect(iframe.id).toBe(id);
    expect(parent.children.length).toBe(children);

    expect(wrap.parentNode !== null || video.parentNode !== null).toBe(true);
    page.window.getComputedStyle = measure;
    page.advance(150);
    page.dispatchWindow('resize');
    expect(iframe.style.width).toBe('800px');
    expect(iframe.style.display).not.toBe('none');
  });

  it('takes out again what it put in the page to measure a hard replace, when that throws', async () => {
    // Collapsed once replaced: the replace turns hard and the page's element leaves the page.
    const {page, wrap} = pageWithVideo();
    const {iframe} = await openPlayer(page);
    wrap.rect = {x: 0, y: 0, width: 5, height: 5};
    page.advance(500);
    await linkPlayer(page, iframe, 5);
    page.advance(3000);
    expect(wrap.isConnected).toBe(false);
    page.advance(200);
    const style = iframe.getAttribute('style');
    const parent = iframe.parentNode;
    const children = parent.children.slice();
    const measure = page.window.getComputedStyle;
    page.window.getComputedStyle = (element, ...rest) => {
      if (element !== iframe && element !== page.document.documentElement && element !== page.document.body) {
        throw new Error('a page script threw');
      }
      return measure(element, ...rest);
    };
    wrap.rect = {x: 0, y: 0, width: 800, height: 450};
    page.dispatchWindow('resize');
    page.window.getComputedStyle = measure;
    expect(iframe.getAttribute('style')).toBe(style);
    expect(parent.children).toEqual(children);
    expect(wrap.isConnected).toBe(false);
  });
});

// beforeunload for a navigation that never happens (a download, a 204, "Leave page?" refused): the
// page stays known.
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

describe('GET_PAGE_QUALITIES', () => {
  it('resolves the page player\'s relative addresses against the page\'s <base href>', async () => {
    const page = loadContentScript();
    page.document.baseURI = 'https://cdn.example/media/';
    const bases = [];
    vm.runInContext('PageQualities', page.window).find = (doc, win, base) => {
      bases.push(base);
      return [];
    };
    await page.send({type: 'GET_PAGE_QUALITIES'});
    expect(bases).toEqual(['https://cdn.example/media/']);
  });
});
