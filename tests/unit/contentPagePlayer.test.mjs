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

describe('a hoster\'s frame made in a background tab', () => {
  // His report (2026-10-27): MPV autoplay went on to the next episode in a background tab,
  // and the hoster's player in it was never started. Measured in Firefox 158: such a frame
  // is hidden, its viewport 0x0, and IntersectionObserver gives everything in it 0.
  /**
   * The hoster's frame: an idle video, and a browser that sees nothing of it.
   * @return {Object} The page and its video.
   */
  function hiddenFrame() {
    const p = loadContentScript({hostname: 'hoster.example'});
    p.document.visibilityState = 'hidden';
    p.window.innerWidth = 0;
    p.window.innerHeight = 0;
    p.window.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        Promise.resolve().then(() => this.callback([{intersectionRatio: 0}], this));
      }
      disconnect() {}
    };
    const video = p.document.createElement('video');
    video.rect = {x: 8, y: 8, width: 640, height: 360};
    video.paused = true;
    p.document.body.appendChild(video);
    return {p, video};
  }

  it('tells the background the video\'s size, which picks the frame to start', async () => {
    const {p} = hiddenFrame();
    expect(await p.send({type: 'GET_VIDEO_SIZE'})).toBe(640 * 360);
  });

  it('plays the video its player gave a source but did not play', async () => {
    const {p, video} = hiddenFrame();
    video.currentSrc = 'https://cdn.example/episode.mp4';
    let plays = 0;
    video.play = () => {
      plays++;
      return Promise.resolve();
    };
    expect(await p.send({type: 'START_PAGE_PLAYER'})).toBe('play');
    expect(plays).toBe(1);
  });

  it('counts a video parked off-screen as not shown, as the browser does', async () => {
    const {p, video} = hiddenFrame();
    video.rect = {x: -2000, y: 8, width: 640, height: 360};
    expect(await p.send({type: 'GET_VIDEO_SIZE'})).toBe(0);
  });

  it('counts a video in a box that clips it to nothing as not shown, as an ad waits', async () => {
    // glm's review (2026-10-27): the box alone made a parked ad's video, larger than the
    // episode's, the one the background started.
    const {p} = hiddenFrame();
    const parked = p.document.createElement('div');
    parked.rect = {x: 0, y: 400, width: 854, height: 0};
    parked.computed = {overflow: 'hidden'};
    const ad = p.document.createElement('video');
    ad.rect = {x: 0, y: 400, width: 854, height: 480};
    ad.paused = true;
    parked.appendChild(ad);
    p.document.body.appendChild(parked);
    expect(await p.send({type: 'GET_VIDEO_SIZE'})).toBe(640 * 360);
  });

  it('counts a fixed video in such a box: the viewport places it', async () => {
    const {p, video} = hiddenFrame();
    const box = p.document.createElement('div');
    box.rect = {x: 0, y: 0, width: 10, height: 10};
    box.computed = {overflow: 'hidden'};
    video.remove();
    video.computed = {position: 'fixed'};
    box.appendChild(video);
    p.document.body.appendChild(box);
    expect(await p.send({type: 'GET_VIDEO_SIZE'})).toBe(640 * 360);
  });

  it('counts an absolutely placed video out of a clipping box that does not place it', async () => {
    // glm's review (2026-10-27): the player's box places it, the collapsed one between clips
    // nothing of it, as the browser draws it.
    const {p, video} = hiddenFrame();
    const player = p.document.createElement('div');
    player.rect = {x: 8, y: 8, width: 640, height: 360};
    player.computed = {position: 'relative'};
    const collapsed = p.document.createElement('div');
    collapsed.rect = {x: 8, y: 8, width: 640, height: 0};
    collapsed.computed = {overflow: 'hidden'};
    video.remove();
    video.computed = {position: 'absolute'};
    collapsed.appendChild(video);
    player.appendChild(collapsed);
    p.document.body.appendChild(player);
    expect(await p.send({type: 'GET_VIDEO_SIZE'})).toBe(640 * 360);
  });

  it('clips a fixed video by a transformed box, which places it', async () => {
    const {p, video} = hiddenFrame();
    const box = p.document.createElement('div');
    box.rect = {x: 0, y: 0, width: 10, height: 10};
    box.computed = {overflow: 'hidden', transform: 'translateZ(0px)'};
    video.remove();
    video.rect = {x: 100, y: 100, width: 640, height: 360};
    video.computed = {position: 'fixed'};
    box.appendChild(video);
    p.document.body.appendChild(box);
    expect(await p.send({type: 'GET_VIDEO_SIZE'})).toBe(0);
  });

  it('clips by a box with paint containment', async () => {
    const {p, video} = hiddenFrame();
    const box = p.document.createElement('div');
    box.rect = {x: 8, y: 8, width: 640, height: 0};
    box.computed = {contain: 'paint'};
    video.remove();
    box.appendChild(video);
    p.document.body.appendChild(box);
    expect(await p.send({type: 'GET_VIDEO_SIZE'})).toBe(0);
  });

  it('measures within the viewport of a hidden page that has one', async () => {
    const {p, video} = hiddenFrame();
    p.window.innerWidth = 1280;
    p.window.innerHeight = 720;
    // Half of it below the page's bottom edge.
    video.rect = {x: 0, y: 540, width: 640, height: 360};
    expect(await p.send({type: 'GET_VIDEO_SIZE'})).toBe(640 * 180);
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
