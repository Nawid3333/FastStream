import {describe, expect, it} from 'vitest';
import {loadContentScript} from './contentDom.mjs';

// The next episode's page after an autoplay next (content.js startPagePlayer, background.mjs
// startPagePlayers), and a fullscreen carried into it (content.js's Escape). Final review,
// 2026-10-11.

/**
 * A page with a video that waits to be played, in a background tab: its visibility comes
 * only when the test lets it (IntersectionObserver every second or so there).
 * @return {Object} The page, its video and its play() calls, and a way to let the visibility
 *   come.
 */
function backgroundTabPage() {
  const p = loadContentScript();
  const video = p.document.createElement('video');
  video.rect = {x: 0, y: 0, width: 640, height: 360};
  video.currentSrc = 'https://cdn.example/episode.mp4';
  video.paused = true;
  let plays = 0;
  video.play = () => {
    plays++;
    return Promise.resolve();
  };
  p.document.body.appendChild(video);
  const waiting = [];
  p.window.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      waiting.push(() => this.callback([{intersectionRatio: 1}], this));
    }
    disconnect() {}
  };
  return {p, video, plays: () => plays, see: () => waiting.splice(0).forEach((fn) => fn())};
}

describe('the page\'s own player, started for an autoplay next', () => {
  it('is started once when the background asks again while the first ask looks for the video', async () => {
    const {p, plays, see} = backgroundTabPage();
    const first = p.send({type: 'START_PAGE_PLAYER'});
    const second = p.send({type: 'START_PAGE_PLAYER'});
    see();
    expect([await first, await second]).toEqual(['play', null]);
    expect(plays()).toBe(1);
  });

  it('is started by a later ask when the first found nothing', async () => {
    const {p, video, plays, see} = backgroundTabPage();
    video.rect = {x: 0, y: 0, width: 0, height: 0};
    const first = p.send({type: 'START_PAGE_PLAYER'});
    see();
    expect(await first).toBe(null);
    video.rect = {x: 0, y: 0, width: 640, height: 360};
    const later = p.send({type: 'START_PAGE_PLAYER'});
    see();
    expect(await later).toBe('play');
    expect(plays()).toBe(1);
  });

  it('is played by a later ask when the browser refused the first play', async () => {
    // A tab the autoplay next went on in has had no click: Firefox may refuse the play, and
    // the latch kept every later ask from trying again (glm's review, 2026-10-22).
    const {p, video, plays, see} = backgroundTabPage();
    const play = video.play;
    let refuse = true;
    video.play = () => {
      const done = play();
      if (!refuse) return done;
      refuse = false;
      return Promise.reject(new DOMException('no activation', 'NotAllowedError'));
    };
    const first = p.send({type: 'START_PAGE_PLAYER'});
    see();
    expect(await first).toBe('play');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const later = p.send({type: 'START_PAGE_PLAYER'});
    see();
    expect(await later).toBe('play');
    expect(plays()).toBe(2);
  });
});

describe('a fullscreen carried into the next episode', () => {
  const exits = (p) => p.sent.filter((m) => m.type === 'EXIT_CARRIED_FULLSCREEN');

  it('ends on the user\'s Escape, not on one the page made', async () => {
    const p = loadContentScript();
    await p.send({type: 'CARRIED_FULLSCREEN', active: true});
    p.dispatchWindow('keydown', {key: 'Escape', isTrusted: false, preventDefault() {}});
    expect(exits(p)).toHaveLength(0);
    p.dispatchWindow('keydown', {key: 'Escape', preventDefault() {}});
    expect(exits(p)).toHaveLength(1);
  });
});
