import vm from 'node:vm';
import {describe, expect, it} from 'vitest';
import {loadContentScript} from './contentDom.mjs';

// content.js answers PAGE_QUALITY_PROBE with the page player's menu (page-quality-control.js) and the size its
// video plays: the background finds the entry in use by it when the menu marks none (PageMenuQuality.mjs).

const MENU = {id: 1, choices: [{label: '360p', height: 360, auto: false, selected: false},
  {label: '1080p', height: 1080, auto: false, selected: false}]};

/**
 * A page whose video plays a 640x360 file; its menu as the stand-in answers it.
 * @param {*} menu - What PageQualityControl.probe finds.
 * @return {Object} The page.
 */
function page(menu) {
  const p = loadContentScript();
  const video = p.document.createElement('video');
  video.currentSrc = 'https://hoster.example/v/1_360p.mp4';
  video.videoWidth = 640;
  video.videoHeight = 360;
  p.document.body.appendChild(video);
  const control = vm.runInContext('PageQualityControl', p.window);
  control.probe = async (probed) => (probed === video ? menu : null);
  return p;
}

describe('the page player\'s menu, asked for', () => {
  it('comes with the size the page\'s video plays', async () => {
    const p = page(MENU);
    expect(await p.send({type: 'PAGE_QUALITY_PROBE', url: 'https://hoster.example/v/1_360p.mp4'}))
        .toEqual({...MENU, width: 640, height: 360});
  });

  it('says so when the page\'s player has none', async () => {
    const p = page(null);
    expect(await p.send({type: 'PAGE_QUALITY_PROBE', url: 'https://hoster.example/v/1_360p.mp4'})).toEqual({none: true});
  });

  it('is not looked for beside a video shown too small for a menu (a teaser): no word on the hoster', async () => {
    const p = page(MENU);
    const video = p.document.querySelector('video');
    video.rect = {x: 0, y: 0, width: 160, height: 90};
    expect(await p.send({type: 'PAGE_QUALITY_PROBE', url: 'https://hoster.example/v/1_360p.mp4'})).toBeNull();
    // Not laid out yet (hidden until a click): looked for.
    video.rect = {x: 0, y: 0, width: 0, height: 0};
    expect(await p.send({type: 'PAGE_QUALITY_PROBE', url: 'https://hoster.example/v/1_360p.mp4'}))
        .toEqual({...MENU, width: 640, height: 360});
  });
});
