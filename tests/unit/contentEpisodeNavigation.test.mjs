import {describe, expect, it} from 'vitest';
import {loadContentScript} from './contentDom.mjs';

// Going on to the next episode in the page (content.js handlePlaylistNavigation): which link
// counts, and how it is followed. HTML matches target and rel keywords in any case, and a
// page's <base target> says where its links open (final review, 2026-10-11).

/**
 * A page on site.example, its location.assign() and its links' clicks recorded.
 * @return {Object} The page, a way to add a link, and what was followed how.
 */
function episodePage() {
  const p = loadContentScript();
  const assigned = [];
  const clicked = [];
  p.window.location.assign = (url) => assigned.push(url);
  /**
   * A link in the page.
   * @param {string} href - Its address.
   * @param {string} text - What it says.
   * @param {Object<string, string>} [attributes] - target, rel...
   * @return {Object} The link.
   */
  const link = (href, text, attributes = {}) => {
    const a = p.document.createElement('a');
    a.href = href;
    a.textContent = text;
    for (const [name, value] of Object.entries(attributes)) a.setAttribute(name, value);
    a.click = () => clicked.push(href);
    p.document.body.appendChild(a);
    return a;
  };
  const base = (target) => {
    const b = p.document.createElement('base');
    b.setAttribute('target', target);
    p.document.head.appendChild(b);
  };
  const next = () => p.send({type: 'PLAYLIST_NAVIGATION', direction: 'next'});
  return {p, link, base, next, assigned, clicked};
}

describe('the next episode\'s link', () => {
  it('is followed by its address in this frame', async () => {
    const {link, next, assigned, clicked} = episodePage();
    link('https://site.example/watch/2', 'Next episode');
    expect(await next()).toBe('clicked');
    expect(assigned).toEqual(['https://site.example/watch/2']);
    expect(clicked).toEqual([]);
  });

  it('is not one into a new tab, in whatever case its target is written', async () => {
    const {link, next, assigned} = episodePage();
    link('https://site.example/ad', 'Next episode', {target: '_BLANK'});
    expect(await next()).toBe('no_button');
    expect(assigned).toEqual([]);
  });

  it('is found by rel="Next" as by rel="next"', async () => {
    const {link, next, assigned} = episodePage();
    link('https://site.example/list?p=2', 'Seite 2 von 9', {rel: 'Next'});
    expect(await next()).toBe('clicked');
    expect(assigned).toEqual(['https://site.example/list?p=2']);
  });

  it('keeps its click where the page\'s <base target> sends links to the whole tab', async () => {
    // A frame whose links open in the top page: its address in this frame would change only
    // the frame, and the page around it stayed.
    const {link, base, next, assigned, clicked} = episodePage();
    base('_top');
    link('https://site.example/watch/2', 'Next episode');
    expect(await next()).toBe('clicked');
    expect(assigned).toEqual([]);
    expect(clicked).toEqual(['https://site.example/watch/2']);
  });

  it('opens here where the page\'s <base target> would open a new tab', async () => {
    const {link, base, next, assigned, clicked} = episodePage();
    base('_blank');
    link('https://site.example/watch/2', 'Next episode');
    expect(await next()).toBe('clicked');
    expect(assigned).toEqual(['https://site.example/watch/2']);
    expect(clicked).toEqual([]);
  });

  it('keeps its own target over the page\'s <base target>', async () => {
    const {link, base, next, assigned} = episodePage();
    base('_top');
    link('https://site.example/watch/2', 'Next episode', {target: '_self'});
    expect(await next()).toBe('clicked');
    expect(assigned).toEqual(['https://site.example/watch/2']);
  });
});
