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

// His report (2026-10-11, aniworld.cc): after a season's last episode, autoplay went on to
// another series. The next episode stays in the series: its next season's first, or none.
describe('the next episode, within the series', () => {
  const SERIES = 'https://site.example/anime/stream/girlfriends';

  /**
   * A season's episode page as aniworld.cc has it: the seasons, the season's episodes, and
   * other series after them (a "similar anime" list).
   * @param {number} season
   * @param {number} episode
   * @param {number} [seasons] - How many seasons the page links.
   * @return {Object} episodePage()'s page.
   */
  function seasonPage(season, episode, seasons = 3) {
    const page = episodePage();
    Object.assign(page.p.window.location, {href: `${SERIES}/staffel-${season}/episode-${episode}`,
      pathname: `/anime/stream/girlfriends/staffel-${season}/episode-${episode}`});
    for (let s = 1; s <= seasons; s++) page.link(`${SERIES}/staffel-${s}`, `Staffel ${s}`);
    for (let e = 1; e <= 12; e++) page.link(`${SERIES}/staffel-${season}/episode-${e}`, String(e));
    page.link('https://site.example/anime/stream/kaiju-girl', 'KAIJU GIRL CARAMELISE');
    page.link('https://site.example/anime/stream/yowayowa-sensei', 'Yowayowa Sensei');
    return page;
  }

  it('goes on to the season\'s next episode', async () => {
    const {next, assigned} = seasonPage(3, 11);
    expect(await next()).toBe('clicked');
    expect(assigned).toEqual([`${SERIES}/staffel-3/episode-12`]);
  });

  it('goes on to the next season\'s first episode after a season\'s last', async () => {
    const {next, assigned} = seasonPage(2, 12);
    expect(await next()).toBe('clicked');
    expect(assigned).toEqual([`${SERIES}/staffel-3/episode-1`]);
  });

  it('stops after the last season\'s last episode, and never takes another series', async () => {
    const {next, assigned, clicked} = seasonPage(3, 12);
    expect(await next()).toBe('series_end');
    expect(assigned).toEqual([]);
    expect(clicked).toEqual([]);
  });

  it('does not take a "next episode" link of another series either', async () => {
    const {link, next, assigned} = seasonPage(3, 12);
    link('https://site.example/anime/stream/kaiju-girl/staffel-1/episode-1', 'Next episode');
    expect(await next()).toBe('series_end');
    expect(assigned).toEqual([]);
  });

  it('takes the next episode\'s link into a new tab, in this tab, not the next season (deepseek\'s review)', async () => {
    // Its address is the very next episode's: no ad's. Missed, autoplay went on to the next
    // season, past the rest of this one.
    const page = episodePage();
    Object.assign(page.p.window.location, {href: `${SERIES}/staffel-3/episode-5`,
      pathname: '/anime/stream/girls/staffel-3/episode-5'});
    page.link(`${SERIES}/staffel-4`, 'Staffel 4');
    page.link(`${SERIES}/staffel-3/episode-4`, '4');
    page.link(`${SERIES}/staffel-3/episode-6`, '6', {target: '_blank'});
    expect(await page.next()).toBe('clicked');
    expect(page.assigned).toEqual([`${SERIES}/staffel-3/episode-6`]);
    expect(page.clicked).toEqual([]);
  });

  it('goes on past a gap in the season, not to the next season (glm\'s review)', async () => {
    // Episode 13 removed: the list has 1-12 and 14-20, and a season 4.
    const page = episodePage();
    Object.assign(page.p.window.location, {href: `${SERIES}/staffel-3/episode-12`,
      pathname: '/anime/stream/girls/staffel-3/episode-12'});
    page.link(`${SERIES}/staffel-4`, 'Staffel 4');
    for (const e of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16]) page.link(`${SERIES}/staffel-3/episode-${e}`, String(e));
    expect(await page.next()).toBe('clicked');
    expect(page.assigned).toEqual([`${SERIES}/staffel-3/episode-14`]);
  });

  it('goes on to the next season\'s lowest episode where a site numbers on across seasons (glm\'s review)', async () => {
    const page = episodePage();
    Object.assign(page.p.window.location, {href: `${SERIES}/staffel-1/episode-12`,
      pathname: '/anime/stream/girls/staffel-1/episode-12'});
    for (let e = 1; e <= 12; e++) page.link(`${SERIES}/staffel-1/episode-${e}`, String(e));
    page.link(`${SERIES}/staffel-2`, 'Staffel 2');
    page.link(`${SERIES}/staffel-2/episode-14`, '14');
    page.link(`${SERIES}/staffel-2/episode-13`, '13');
    expect(await page.next()).toBe('clicked');
    expect(page.assigned).toEqual([`${SERIES}/staffel-2/episode-13`]);
  });

  it('goes on to the next season\'s episode 1, not to a "continue watching" episode of it (glm\'s review)', async () => {
    const page = episodePage();
    Object.assign(page.p.window.location, {href: `${SERIES}/staffel-3/episode-12`,
      pathname: '/anime/stream/girls/staffel-3/episode-12'});
    for (let e = 1; e <= 12; e++) page.link(`${SERIES}/staffel-3/episode-${e}`, String(e));
    page.link(`${SERIES}/staffel-4`, 'Staffel 4');
    page.link(`${SERIES}/staffel-4/episode-5`, 'Weiterschauen: Staffel 4, Folge 5');
    expect(await page.next()).toBe('clicked');
    expect(page.assigned).toEqual([`${SERIES}/staffel-4/episode-1`]);
  });

  it('presses no "next episode" button on a season\'s first episode either (deepseek\'s review)', async () => {
    // A season's first episode has no previous one to link: the season's other episodes (here
    // 5, after a gap) tell the page lists it, and the list, not the button, goes on.
    const page = episodePage();
    Object.assign(page.p.window.location, {href: `${SERIES}/staffel-3/episode-1`,
      pathname: '/anime/stream/girls/staffel-3/episode-1'});
    page.link(`${SERIES}/staffel-3/episode-1`, '1');
    page.link(`${SERIES}/staffel-3/episode-5`, '5');
    const button = page.p.document.createElement('button');
    button.textContent = 'Next episode';
    let pressed = false;
    button.click = () => {
      pressed = true;
    };
    page.p.document.body.appendChild(button);
    expect(await page.next()).toBe('clicked');
    expect(pressed).toBe(false);
    expect(page.assigned).toEqual([`${SERIES}/staffel-3/episode-5`]);
  });

  it('answers whether the user types in the page, for the next episode\'s keyboard', async () => {
    const p = episodePage().p;
    p.document.visibilityState = 'visible';
    expect(await p.send({type: 'PAGE_TYPING'})).toBe(false);
    const field = p.document.createElement('input');
    p.document.body.appendChild(field);
    p.document.activeElement = field;
    expect(await p.send({type: 'PAGE_TYPING'})).toBe(true);
    p.document.activeElement = p.document.body;
    p.document.visibilityState = 'hidden';
    expect(await p.send({type: 'PAGE_TYPING'})).toBe(true);
  });

  it('does not press a "next episode" button on a series page its links tell all of (kimi\'s review)', async () => {
    const {p, next, clicked} = seasonPage(3, 12);
    const button = p.document.createElement('button');
    button.textContent = 'Next episode';
    let pressed = false;
    button.click = () => {
      pressed = true;
    };
    p.document.body.appendChild(button);
    expect(await next()).toBe('series_end');
    expect(pressed).toBe(false);
    expect(clicked).toEqual([]);
  });

  it('tells the player the series ended there, and not where it cannot read the page', async () => {
    const last = seasonPage(3, 12);
    expect(await last.p.send({type: 'PLAYLIST_POLL'})).toEqual({next: false, previous: true, seriesEnd: true});
    expect(await seasonPage(3, 11).p.send({type: 'PLAYLIST_POLL'})).toEqual({next: true, previous: true, seriesEnd: false});
    // An address with no season or episode in it: a page FastStream cannot read, no end.
    const unknown = episodePage();
    expect(await unknown.p.send({type: 'PLAYLIST_POLL'})).toEqual({next: false, previous: false, seriesEnd: false});
    expect(await unknown.next()).toBe('no_button');
  });
});
