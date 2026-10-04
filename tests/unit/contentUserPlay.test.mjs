import {describe, expect, it} from 'vitest';
import {loadContentScript} from './contentDom.mjs';

// The shortcut's MPV sends only a video the user starts (MPV_USER_PLAY), told from an
// autoplay by the click or key behind the play. That was navigator.userActivation.isActive
// alone, and a site whose play button first opens a pop-up broke it: window.open()
// consumes the activation (Firefox's own web-platform tests check it), the video the same
// click started played with isActive false, and nothing went to mpv. A trusted press in the
// frame within Firefox's activation time (5 s) now counts as well.

/**
 * A page with a video, the user's activation as Firefox would report it.
 * @return {Object} The page, its video, and what it reported as user plays.
 */
function page() {
  const p = loadContentScript();
  const video = p.document.createElement('video');
  video.currentSrc = 'https://cdn.example/episode.mp4';
  video.duration = 1400;
  p.document.body.appendChild(video);
  const plays = () => p.sent.filter((m) => m.type === 'MPV_USER_PLAY');
  const activation = p.window.navigator.userActivation;
  return {p, video, plays, activation};
}

describe('a play the user started', () => {
  it('is reported when Firefox still counts the click (no pop-up)', () => {
    const {p, video, plays, activation} = page();
    activation.isActive = true;
    p.dispatchDocument('play', {target: video});
    // With the page's address as it is now (YouTube in MPV, #338).
    expect(plays()).toEqual([{type: 'MPV_USER_PLAY', src: 'https://cdn.example/episode.mp4',
      video: {src: 'https://cdn.example/episode.mp4', duration: 1400, playing: 'https://cdn.example/episode.mp4'},
      page: 'https://site.example/page'}]);
  });

  it('is reported when the click opened a pop-up first, which used up the activation', () => {
    const {p, video, plays, activation} = page();
    p.dispatchWindow('pointerdown');
    // The site's click handler: window.open(ad) consumes it, then video.play().
    activation.isActive = false;
    p.advance(300);
    p.dispatchDocument('play', {target: video});
    expect(plays().map((m) => m.src)).toEqual(['https://cdn.example/episode.mp4']);
  });

  it('is reported after a plain key that starts the video, the pop-up notwithstanding', () => {
    const {p, video, plays} = page();
    p.dispatchWindow('keydown', {key: ' '});
    p.advance(1000);
    p.dispatchDocument('play', {target: video});
    expect(plays().length).toBe(1);
  });

  it('is reported up to Firefox\'s activation time after the press', () => {
    const {p, video, plays} = page();
    p.dispatchWindow('pointerdown');
    p.advance(5000);
    p.dispatchDocument('play', {target: video});
    expect(plays().length).toBe(1);
  });
});

describe('a play nobody started', () => {
  it('is not reported without a press (an autoplay, a preview)', () => {
    const {p, video, plays} = page();
    p.dispatchDocument('play', {target: video});
    expect(plays()).toEqual([]);
  });

  it('is not reported once the press is older than Firefox\'s activation time', () => {
    const {p, video, plays} = page();
    p.dispatchWindow('pointerdown');
    p.advance(5001);
    p.dispatchDocument('play', {target: video});
    expect(plays()).toEqual([]);
  });

  it('does not count a press the page made up', () => {
    const {p, video, plays} = page();
    p.dispatchWindow('pointerdown', {isTrusted: false});
    p.dispatchDocument('play', {target: video});
    expect(plays()).toEqual([]);
  });

  it('does not count a play event the page made up', () => {
    const {p, video, plays, activation} = page();
    activation.isActive = true;
    p.dispatchDocument('play', {target: video, isTrusted: false});
    expect(plays()).toEqual([]);
  });

  // The MPV shortcut itself is one of these, whatever it is bound to in about:addons:
  // Ctrl+Shift+U by default, Alt+F on the owner's PC. Switching MPV on must not make a
  // preview that starts a moment later count as the user's.
  it('does not count a key that could be a shortcut, whatever it is bound to, nor Escape', () => {
    for (const key of [{key: 'f', altKey: true}, {key: 'U', ctrlKey: true, shiftKey: true},
      {key: 'k', metaKey: true}, {key: 'F9'}, {key: 'MediaPlayPause'}, {key: 'Escape'},
      {key: 'Shift', shiftKey: true}, {key: 'AltGraph'}]) {
      const {p, video, plays} = page();
      p.dispatchWindow('keydown', key);
      p.dispatchDocument('play', {target: video});
      expect(plays(), JSON.stringify(key)).toEqual([]);
    }
  });
});
