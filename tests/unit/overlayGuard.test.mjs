import {describe, expect, it} from 'vitest';
import {loadContentScript} from './contentDom.mjs';

// overlay-guard.js hides what a page lays over FastStream's player (a bar, a button, an
// ad layer), by geometry: what is painted over the player's iframe and lies mostly inside
// its box, or covers half of it. Run here on a stand-in page (contentDom.mjs) whose
// window is 1280x720 and whose elements are placed by hand; later elements are painted
// above earlier ones.

/**
 * A page with FastStream's player iframe in it.
 * @param {{x: number, y: number, width: number, height: number}} rect - The iframe's box.
 * @return {{page: Object, iframe: Object}}
 */
function pageWithPlayerAt(rect) {
  const page = loadContentScript();
  const {document} = page;
  document.documentElement.rect = {x: 0, y: 0, width: 1280, height: 2000};
  document.body.rect = {x: 0, y: 0, width: 1280, height: 2000};
  const iframe = document.createElement('iframe');
  iframe.src = 'moz-extension://test/player/index.html?opener=x';
  iframe.rect = rect;
  document.body.appendChild(iframe);
  return {page, iframe};
}

/**
 * Adds an element to the page, painted above everything added before it.
 * @param {Object} page - From loadContentScript.
 * @param {Object} parent - Where it goes.
 * @param {{x: number, y: number, width: number, height: number}} rect - Its box.
 * @param {Object<string, string>} [attributes] - Its attributes.
 * @return {Object} The element.
 */
function addLayer(page, parent, rect, attributes = {}) {
  const el = page.document.createElement('div');
  el.rect = rect;
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  parent.appendChild(el);
  return el;
}

const VIEWPORT = {x: 0, y: 0, width: 1280, height: 720};
const PLAYER = {x: 0, y: 0, width: 640, height: 360};

/**
 * @param {Object} el - An element.
 * @return {string} Its inline visibility, '' when it has none.
 */
function visibility(el) {
  return el.style.getPropertyValue('visibility');
}

describe('OverlayGuard', () => {
  it('hides a layer over the whole page, and gives it back on release', () => {
    // What the e2e's veil and stage pages pin: an ad layer goes.
    const {page, iframe} = pageWithPlayerAt(PLAYER);
    const layer = addLayer(page, page.document.body, VIEWPORT);
    page.overlayGuard.guard(iframe);
    expect(visibility(layer)).toBe('hidden');
    page.overlayGuard.releaseAll();
    expect(visibility(layer)).toBe('');
  });

  it('hides a bar on the player', () => {
    const {page, iframe} = pageWithPlayerAt(PLAYER);
    const bar = addLayer(page, page.document.body, {x: 0, y: 320, width: 640, height: 40});
    page.overlayGuard.guard(iframe);
    expect(visibility(bar)).toBe('hidden');
  });

  // A site's sign-in, cookie or settings dialog opened while the player was up: a backdrop
  // over the whole page with the dialog in it, the same geometry as an ad layer. Hidden,
  // the user saw no dialog, and clicks went through its backdrop (#226).
  describe('a site\'s dialog over the player', () => {
    it('leaves a layer holding a dialog alone, and all that is in it', () => {
      const {page, iframe} = pageWithPlayerAt(PLAYER);
      const modal = addLayer(page, page.document.body, VIEWPORT);
      const backdrop = addLayer(page, modal, VIEWPORT);
      const dialog = addLayer(page, modal, {x: 440, y: 200, width: 400, height: 300}, {'role': 'dialog'});
      page.overlayGuard.guard(iframe);
      expect([modal, backdrop, dialog].map(visibility)).toEqual(['', '', '']);
    });

    it('leaves alone a dialog that says it is one in any of the usual ways', () => {
      for (const attributes of [{'role': 'alertdialog'}, {'aria-modal': 'true'}]) {
        const {page, iframe} = pageWithPlayerAt(PLAYER);
        const dialog = addLayer(page, page.document.body, VIEWPORT, attributes);
        page.overlayGuard.guard(iframe);
        expect(visibility(dialog), JSON.stringify(attributes)).toBe('');
      }
      const {page, iframe} = pageWithPlayerAt(PLAYER);
      const dialog = page.document.createElement('dialog');
      dialog.rect = VIEWPORT;
      dialog.setAttribute('open', '');
      page.document.body.appendChild(dialog);
      page.overlayGuard.guard(iframe);
      expect(visibility(dialog)).toBe('');
    });

    it('leaves alone a layer the user is typing in', () => {
      const {page, iframe} = pageWithPlayerAt(PLAYER);
      const form = addLayer(page, page.document.body, VIEWPORT);
      const input = page.document.createElement('input');
      input.rect = {x: 500, y: 300, width: 200, height: 30};
      form.appendChild(input);
      page.document.activeElement = input;
      page.overlayGuard.guard(iframe);
      expect(visibility(form)).toBe('');
    });

    it('gives back a layer that became a dialog after it was hidden', () => {
      const {page, iframe} = pageWithPlayerAt(PLAYER);
      const layer = addLayer(page, page.document.body, VIEWPORT);
      page.overlayGuard.guard(iframe);
      expect(visibility(layer)).toBe('hidden');
      layer.setAttribute('aria-modal', 'true');
      page.runIntervals();
      expect(visibility(layer)).toBe('');
    });
  });

  // A sticky header over a player scrolled mostly out of view: the header covered more than
  // half of the player's part on screen, so it went, came back when the player left the
  // screen, and went again on the way back (#226).
  it('leaves a page header alone over a player scrolled mostly out of view', () => {
    const {page, iframe} = pageWithPlayerAt({x: 0, y: -260, width: 640, height: 360});
    const header = addLayer(page, page.document.body, {x: 0, y: 0, width: 1280, height: 60});
    page.overlayGuard.guard(iframe);
    expect(visibility(header)).toBe('');
  });

  it('still hides a bar on a player partly out of view', () => {
    const {page, iframe} = pageWithPlayerAt({x: 0, y: -100, width: 640, height: 360});
    const bar = addLayer(page, page.document.body, {x: 0, y: 220, width: 640, height: 40});
    page.overlayGuard.guard(iframe);
    expect(visibility(bar)).toBe('hidden');
  });
});
