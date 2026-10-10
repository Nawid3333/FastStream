// The player's controls: the volume block's keys, a file dropped on the player, and the
// messages the save controls show.
//
// Each case opens the web player with no source and hands it one the way main.mjs does,
// with autoplay and remembered positions off, so that nothing but the case moves the video.
import {browser, expect} from '@wdio/globals';
import fs from 'node:fs';

const mp4Url = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/sample.mp4`;
const hlsUrl = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/hls-ts/index.m3u8`;
// An HLS source whose manifest never loads, so its video never gets a duration.
const missingUrl = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/missing/stream.m3u8`;
const dashUrl = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/dash-template/manifest.mpd`;
const en = JSON.parse(fs.readFileSync(new URL('../../../chrome/_locales/en/messages.json', import.meta.url), 'utf8'));

/**
 * Opens the player with no source, autoplay and remembered positions off.
 * @return {Promise<void>}
 */
async function openEmptyPlayer() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  // main.mjs applies the stored options once the client exists, which would undo the
  // overrides below; it sets optionsApplied when it has.
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player options never loaded'});
  await browser.execute(() => {
    window.fastStream.options.autoPlay = false;
    window.fastStream.options.storeProgress = false;
  });
}

/**
 * Hands the player a source, as main.mjs does for a URL in the page's hash.
 * @param {string} url - The source.
 * @return {Promise<void>}
 */
async function addSource(url) {
  const error = await browser.executeAsync((url, done) => {
    Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
        .then(([{VideoSource}, {URLUtils}]) => {
          window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
          done(null);
        }).catch((e) => done(String(e)));
  }, url);
  expect(error).toBe(null);
}

/**
 * Waits until the video the player shows has a frame to show.
 * @return {Promise<void>}
 */
async function waitForPicture() {
  await browser.waitUntil(async () => browser.execute(() => {
    const client = window.fastStream;
    return !!client.player && client.duration > 0 && client.currentVideo?.readyState >= 2;
  }), {timeout: 30000, timeoutMsg: 'the video never loaded'});
}

/**
 * Presses a key on the focused volume block, as the keyboard would: the event starts
 * there and bubbles up through the player.
 * @param {string} key - The key, which is also its code for the arrows.
 * @return {Promise<{volume: number, currentTime: number}>} The state a moment later.
 */
async function pressOnVolumeBlock(key) {
  await browser.execute((key) => {
    const block = document.querySelector('.mainplayer .volume_block');
    block.focus();
    block.dispatchEvent(new KeyboardEvent('keydown', {key, code: key, bubbles: true, cancelable: true}));
  }, key);
  // A seek lands a moment later.
  await browser.pause(300);
  return browser.execute(() => ({volume: window.fastStream.volume, currentTime: window.fastStream.currentTime}));
}

/**
 * Reads a value until it passes a check or the time is up, and gives the last one read:
 * the player redraws on its own time after a seek or a switch, later on a busy machine.
 * @param {function(): Promise<*>} read - Reads the value.
 * @param {function(*): boolean} check - Whether it is the one waited for.
 * @param {number} [timeout] - How long to wait, in ms.
 * @return {Promise<*>}
 */
async function settle(read, check, timeout = 10000) {
  let value;
  await browser.waitUntil(async () => check(value = await read()), {timeout, interval: 100}).catch(() => {});
  return value;
}

describe('Player controls', function() {
  it('raises the volume from the volume block past 100%, as the volume keys do', async function() {
    // The block's ArrowRight capped the volume at 100%, so above that it lowered it.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    await browser.execute(() => {
      window.fastStream.volume = 2;
    });
    const state = await pressOnVolumeBlock('ArrowRight');
    console.log('      after ArrowRight:', JSON.stringify(state));
    expect(state.volume).toBeCloseTo(2.1, 5);
  });

  it('lowers the volume from the volume block without seeking the video', async function() {
    // The block's ArrowLeft went on to the player's own ArrowLeft, a seek back.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    await browser.execute(() => {
      window.fastStream.volume = 1;
      window.fastStream.currentTime = 6;
    });
    await browser.pause(300);
    const state = await pressOnVolumeBlock('ArrowLeft');
    console.log('      after ArrowLeft:', JSON.stringify(state));
    expect(state.volume).toBeCloseTo(0.9, 5);
    expect(state.currentTime).toBeCloseTo(6, 1);
  });

  it('plays a video dropped together with a .json that is not JSON', async function() {
    // The .json threw, and the drop ended there, video and all.
    await openEmptyPlayer();
    const error = await browser.executeAsync((url, done) => {
      fetch(url).then((response) => response.blob()).then((blob) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(['{not json'], 'notes.json', {type: 'application/json'}));
        dataTransfer.items.add(new File([blob], 'dropped.mp4', {type: 'video/mp4'}));
        document.querySelector('.mainplayer').dispatchEvent(
            new DragEvent('drop', {dataTransfer, bubbles: true, cancelable: true}));
        done(null);
      }).catch((e) => done(String(e)));
    }, mp4Url());
    expect(error).toBe(null);
    await waitForPicture();
    const identifier = await browser.execute(() => window.fastStream.source?.identifier);
    expect(identifier).toMatch(/^dropped\.mp4size\d+$/);
  });

  it('opens the timeline quietly on a video that has no duration yet', async function() {
    // The timeline drew itself every frame with the video's NaN duration, which threw.
    await openEmptyPlayer();
    await addSource(missingUrl());
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream.currentVideo),
        {timeout: 10000, timeoutMsg: 'the player never started'});
    await browser.execute(() => {
      window.__errors = [];
      window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
      window.fastStream.interfaceController.showControlBar();
      window.fastStream.interfaceController.openTimeline();
    });
    await browser.pause(1000);
    const state = await browser.execute(() => ({
      errors: window.__errors.slice(0, 3),
      count: window.__errors.length,
      started: window.fastStream.interfaceController.fineTimeControls.started,
      duration: window.fastStream.currentVideo?.duration,
    }));
    console.log('      state:', JSON.stringify(state));
    expect(state.started).toBe(true);
    expect(state.count).toBe(0);
  });

  // Let go outside the player, a drag on the bar never ended: every later move seeked, and
  // the next click played the video (review, 2026-10-09).
  it('ends a drag on the bar on a move with no button held, and on a reset', async function() {
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    const drag = () => browser.execute(() => {
      const bar = document.querySelector('.mainplayer .fluid_controls_progress_container');
      const box = bar.getBoundingClientRect();
      bar.dispatchEvent(new MouseEvent('mousedown', {button: 0, buttons: 1, bubbles: true,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2}));
      return window.fastStream.interfaceController.progressBar.isSeeking;
    });
    expect(await drag()).toBe(true);
    const after = await browser.execute(() => {
      const container = document.querySelector('.mainplayer');
      const box = container.getBoundingClientRect();
      container.dispatchEvent(new MouseEvent('mousemove', {buttons: 0, bubbles: true,
        clientX: box.left + 5, clientY: box.top + 5}));
      const time = window.fastStream.currentTime;
      container.dispatchEvent(new MouseEvent('mousemove', {buttons: 0, bubbles: true,
        clientX: box.left + box.width - 5, clientY: box.top + 5}));
      return {seeking: window.fastStream.interfaceController.progressBar.isSeeking, time,
        later: window.fastStream.currentTime};
    });
    expect(after.seeking).toBe(false);
    expect(after.later).toBe(after.time);

    // A drag paused the playing video; a reset (a new video) during it played it again.
    await browser.execute(() => window.fastStream.play());
    await browser.waitUntil(async () => browser.execute(() => !window.fastStream.paused), {timeout: 10000});
    expect(await drag()).toBe(true);
    expect(await browser.execute(() => {
      window.fastStream.interfaceController.progressBar.reset();
      return {seeking: window.fastStream.interfaceController.progressBar.isSeeking, paused: window.fastStream.paused};
    })).toEqual({seeking: false, paused: true});
  });

  it('does not carry the previous video\'s failed-fragments button over', async function() {
    // It was hidden only by a video with fragments to count.
    await openEmptyPlayer();
    await addSource(hlsUrl());
    await waitForPicture();
    const shown = await browser.executeAsync((done) => {
      import('/player/enums/DownloadStatus.mjs').then(({DownloadStatus}) => {
        const client = window.fastStream;
        // A fragment that failed to download, as a network error leaves it.
        client.getFragments(client.getCurrentVideoLevelID()).find((fragment) => fragment).status = DownloadStatus.DOWNLOAD_FAILED;
        client.interfaceController.updateFragmentsLoaded();
        done(document.querySelector('.mainplayer .reset_failed').style.display !== 'none');
      }).catch((e) => done('failed: ' + e));
    });
    expect(shown).toBe(true);
    // Its "all buffered" said too (review): the next video, buffered from the start, said nothing.
    await browser.execute(() => {
      window.fastStream.interfaceController.shownDownloadComplete = true;
    });
    await addSource(missingUrl());
    const after = await settle(() => browser.execute(() => document.querySelector('.mainplayer .reset_failed').style.display),
        (display) => display === 'none');
    console.log('      after the switch, display:', JSON.stringify(after));
    expect(after).toBe('none');
    expect(await browser.execute(() => window.fastStream.interfaceController.shownDownloadComplete)).toBe(false);
  });

  it('shows the next video\'s time, not the previous one\'s', async function() {
    // Nothing redrew the bar and the time until the next video sent a time update, and one
    // that never loads never sends one.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    await browser.execute(() => {
      window.fastStream.currentTime = 8;
    });
    const read = () => browser.execute(() => ({
      width: document.querySelector('.mainplayer .fluid_controls_currentprogress').style.width,
      label: document.querySelector('.mainplayer .fluid_control_duration').textContent,
      time: window.fastStream.state.currentTime,
    }));
    const before = await settle(read, (state) => parseFloat(state.width) > 50);
    console.log('      before the switch:', JSON.stringify(before));
    expect(parseFloat(before.width)).toBeGreaterThan(50);
    await addSource(missingUrl());
    const after = await settle(read, (state) => state.width === '0%' && state.label.startsWith('00:00 /') && state.time === 0);
    console.log('      after the switch:', JSON.stringify(after));
    expect(after.width).toBe('0%');
    expect(after.label.startsWith('00:00 /')).toBe(true);
    expect(after.time).toBe(0);
  });

  it('can be used from the keyboard: the big play button, the volume slider', async function() {
    // Tab skipped the big play button, and the volume slider had no value for a screen
    // reader (#270).
    await openEmptyPlayer();
    const big = await browser.execute(() => {
      const circle = document.querySelector('.mainplayer .fluid_control_playpause_big_circle');
      return {tabIndex: circle.tabIndex, role: circle.getAttribute('role')};
    });
    expect(big).toEqual({tabIndex: 0, role: 'button'});

    await addSource(mp4Url());
    await waitForPicture();
    await browser.execute(() => {
      window.fastStream.volume = 1.5;
    });

    const slider = await browser.execute(() => {
      const block = document.querySelector('.mainplayer .volume_block');
      return ['role', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].map((name) => block.getAttribute(name));
    });
    expect(slider).toEqual(['slider', '0', '300', '150', '150%']);
  });

  it('copies a link from the time readout without the login headers', async function() {
    // The copied link held the page's Cookie and Authorization in its query (#185).
    await openEmptyPlayer();
    const error = await browser.executeAsync((url, done) => {
      Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
          .then(([{VideoSource}, {URLUtils}]) => {
            const headers = {Cookie: 'session=secret', Authorization: 'Bearer secret', Referer: 'https://site.example/'};
            window.fastStream.addSource(new VideoSource(url, headers, URLUtils.getModeFromURL(url)), true);
            done(null);
          }).catch((e) => done(String(e)));
    }, mp4Url());
    expect(error).toBe(null);
    await waitForPicture();
    // The copy goes through navigator.clipboard (WebUtils.copyText), asynchronously; caught
    // there, and at the old execCommand way it falls back to, should the first refuse.
    const {copied, via} = await browser.executeAsync((done) => {
      const clipboard = navigator.clipboard;
      const writeText = clipboard.writeText;
      const execCommand = document.execCommand;
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clipboard.writeText = writeText;
        document.execCommand = execCommand;
        done(result);
      };
      clipboard.writeText = async (text) => finish({copied: text, via: 'clipboard'});
      document.execCommand = (command) => {
        finish({copied: document.activeElement.value, via: command});
        return true;
      };
      setTimeout(() => finish({copied: null, via: 'nothing within 5 s'}), 5000);
      document.querySelector('.mainplayer .fluid_control_duration').click();
    });
    console.log('      copied:', copied, 'via', via);
    expect(via).toBe('clipboard');
    const headers = JSON.parse(new URL(copied).searchParams.get('faststream-headers'));
    expect(headers).toEqual({referer: 'https://site.example/'});
    expect(copied).not.toContain('secret');
  });

  it('does not carry the previous video\'s next-video banner over', async function() {
    // It was taken down only once the next video had a duration.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    const banner = () => browser.execute(() => document.querySelector('.mainplayer .next_video_button').style.display);
    await browser.execute(() => {
      const client = window.fastStream;
      // The next video in a playlist, whose banner comes up in the last 10 seconds.
      client.options.autoplayNext = true;
      client.hasNextVideo = () => true;
      client.currentTime = 8;
    });
    expect(await settle(banner, (display) => display === '')).toBe('');
    await addSource(missingUrl());
    expect(await settle(banner, (display) => display === 'none')).toBe('none');
  });

  it('says the archive failed when it could not be written', async function() {
    // The status line said "Unreachable Error".
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    const message = await browser.executeAsync((done) => {
      import('/player/utils/FastStreamArchiveUtils.mjs').then(async ({FastStreamArchiveUtils}) => {
        FastStreamArchiveUtils.writeFSAToStream = () => Promise.reject(new Error('no archive here'));
        const interfaceController = window.fastStream.interfaceController;
        await interfaceController.saveManager.dumpBuffer('probe');
        done(interfaceController.statusManager.statusMessages.get('save-video').message);
      }).catch((e) => done('failed: ' + e));
    });
    expect(message).toBe(en.player_archiver_fail.message);
  });

  it('loads a source set again whose manifest was asked for while the reset had no downloaders', async function() {
    // The real-streams check, 2026-10-06 (1 run in 4): a live DASH stream reloaded without
    // a codec that failed never loaded. The seek preview's build, still running, asked for
    // the manifest in the reset's gap - no downloaders while it cleared storage - and the
    // request sat in the queue: the reset added downloaders without starting it, and the new
    // player's request for the same manifest joined it. Made to happen here: the same
    // source set again, as reloadWithoutFailedCodec does, and that request in the gap.
    await openEmptyPlayer();
    await addSource(dashUrl());
    await waitForPicture();
    const playable = () => browser.execute(() => (window.fastStream?.player?.getVideo?.()?.readyState || 0) >= 2);
    for (let i = 0; i < 2; i++) {
      const gap = await browser.execute((url) => {
        const client = window.fastStream;
        const downloads = client.downloadManager;
        client.setSource(client.source, []).catch(() => {});
        const downloaders = downloads.downloaders.length;
        // dash.js asks for a manifest with responseType ''.
        downloads.getFile({url, responseType: ''}, {onSuccess() {}, onFail() {}, onAbort() {}});
        return {downloaders, queued: downloads.queue.length};
      }, dashUrl());
      // The gap the request has to land in, or this checks nothing.
      expect(gap).toEqual({downloaders: 0, queued: 1});
      const loaded = await settle(playable, (value) => value === true, 15000);
      const queue = await browser.execute(() => window.fastStream.downloadManager.queue.length);
      console.log(`      reload ${i + 1}:`, JSON.stringify({loaded, queue}));
      expect(loaded).toBe(true);
    }
  });

  it('redraws a short video\'s time every frame while it plays, and not while it is paused', async function() {
    // A video under five minutes is redrawn every frame (requestAnimationFrame), so its bar
    // moves smoothly. The loop ran on at 60 a second while the video sat paused.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    // How often the player's time is updated in one second: the loop's frames, and the
    // video's own timeupdate events.
    const perSecond = () => browser.executeAsync((done) => {
      const client = window.fastStream;
      const updateTime = client.updateTime;
      let calls = 0;
      client.updateTime = function(...args) {
        calls++;
        return updateTime.apply(this, args);
      };
      setTimeout(() => {
        delete client.updateTime;
        done(calls);
      }, 1000);
    });
    const paused = await perSecond();
    await browser.execute(() => {
      window.fastStream.play();
    });
    await settle(() => browser.execute(() => window.fastStream.player.getVideo().paused), (value) => value === false);
    const playing = await perSecond();
    await browser.execute(() => {
      window.fastStream.pause();
    });
    await browser.pause(300);
    const pausedAgain = await perSecond();
    console.log('      time updates per second:', JSON.stringify({paused, playing, pausedAgain}));
    expect(paused).toBeLessThan(5);
    expect(playing).toBeGreaterThan(20);
    expect(pausedAgain).toBeLessThan(5);
  });
});

// #383: "sometimes the progress bar stays visible for a long time or forever; pausing and
// playing a few times makes it go." The hide was decided once, when its timer fired, from
// flags that can be stale.
describe('Player controls, hiding by themselves', function() {
  const controlsVisible = () => browser.execute(() =>
    document.querySelector('.mainplayer').classList.contains('controls_visible'));

  /**
   * An empty player whose bar may hide (as if a video played), with the pointer over the
   * video at its top left, away from the bar at the bottom.
   * @return {Promise<void>}
   */
  async function playerWithPointerAway() {
    await openEmptyPlayer();
    await browser.execute(() => {
      window.fastStream.interfaceController.hideBigPlayButton();
      window.fastStream.state.playing = true;
    });
    const player = await browser.$('.mainplayer');
    const {width, height} = await player.getSize();
    await browser.action('pointer')
        .move({origin: player, x: -Math.floor(width / 2) + 10, y: -Math.floor(height / 2) + 10})
        .perform();
  }

  it('hides the bar when the pointer left it without a mouseleave', async function() {
    await playerWithPointerAway();
    // The pointer move's own hide goes first.
    await browser.waitUntil(async () => !(await controlsVisible()),
        {timeout: 5000, timeoutMsg: 'the bar never hid at all'});
    // The pointer came onto the bar, and the bar never heard it go (a mouseleave that did
    // not come): it refused every hide after it, and with no mouse move over the video
    // after that, nothing asked again.
    await browser.execute(() => window.fastStream.interfaceController.onControlsMouseEnter());
    expect(await controlsVisible()).toBe(true);
    await browser.waitUntil(async () => !(await controlsVisible()),
        {timeout: 5000, timeoutMsg: 'the bar stayed up for a pointer that had left it'});
  });

  it('still keeps the bar up while the pointer is over it', async function() {
    await playerWithPointerAway();
    const bar = await browser.$('.mainplayer .fluid_controls_container');
    await bar.moveTo();
    await browser.execute(() => window.fastStream.interfaceController.queueControlsHide(50));
    await browser.pause(2600);
    expect(await controlsVisible()).toBe(true);
  });

  it('hides the bar shown by a way that asks for no hide (the show-controls key)', async function() {
    await playerWithPointerAway();
    await browser.waitUntil(async () => !(await controlsVisible()),
        {timeout: 5000, timeoutMsg: 'the bar never hid at all'});
    await browser.execute(() => window.fastStream.interfaceController.toggleControlBar());
    expect(await controlsVisible()).toBe(true);
    await browser.waitUntil(async () => !(await controlsVisible()),
        {timeout: 5000, timeoutMsg: 'the bar the key showed stayed up'});
  });

  it('hides the bar once it may, after a hide was refused', async function() {
    await playerWithPointerAway();
    // Refused while paused; then played on by a way that asks for no hide.
    await browser.execute(() => {
      window.fastStream.state.playing = false;
      window.fastStream.interfaceController.queueControlsHide(50);
    });
    await browser.pause(300);
    expect(await controlsVisible()).toBe(true);
    await browser.execute(() => {
      window.fastStream.state.playing = true;
    });
    await browser.waitUntil(async () => !(await controlsVisible()),
        {timeout: 5000, timeoutMsg: 'the bar stayed up after the refused hide'});
  });
});
