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
    await addSource(missingUrl());
    const after = await settle(() => browser.execute(() => document.querySelector('.mainplayer .reset_failed').style.display),
        (display) => display === 'none');
    console.log('      after the switch, display:', JSON.stringify(after));
    expect(after).toBe('none');
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

  it('clears the chapter name in a gap between chapters', async function() {
    // The name of the chapter before the gap stayed on.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    // The name follows the player's time updates, so each read waits for the one expected.
    const chapterAt = async (time, expected) => {
      await browser.execute((time) => {
        window.fastStream.currentTime = time;
      }, time);
      return settle(() => browser.execute(() => window.fastStream.interfaceController.statusManager.statusMessages.get('chapter').message),
          (message) => (message || null) === expected);
    };
    await browser.execute(() => window.fastStream.setChapters([
      {name: 'Opening', startTime: 0, endTime: 2},
      {name: 'Closing', startTime: 6, endTime: 10},
    ]));
    expect(await chapterAt(1, 'Opening')).toBe('Opening');
    const inGap = await chapterAt(4, null);
    console.log('      in the gap:', JSON.stringify(inGap));
    expect(inGap || null).toBe(null);
    expect(await chapterAt(7, 'Closing')).toBe('Closing');
  });

  it('can be used from the keyboard: the skip button, the big play button, the volume slider', async function() {
    // Tab reached "Skip intro" but Enter did nothing, Tab skipped the big play button, and
    // the volume slider had no value for a screen reader (#270).
    await openEmptyPlayer();
    const big = await browser.execute(() => {
      const circle = document.querySelector('.mainplayer .fluid_control_playpause_big_circle');
      return {tabIndex: circle.tabIndex, role: circle.getAttribute('role')};
    });
    expect(big).toEqual({tabIndex: 0, role: 'button'});

    await addSource(mp4Url());
    await waitForPicture();
    await browser.execute(() => {
      const client = window.fastStream;
      client.videoAnalyzer.getIntro = () => ({startTime: 0, endTime: 5});
      client.volume = 1.5;
      client.currentTime = 1;
    });
    await settle(() => browser.execute(() => document.querySelector('.mainplayer .skip_button').style.display),
        (display) => display === '');
    await browser.execute(() => {
      const button = document.querySelector('.mainplayer .skip_button');
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true, cancelable: true}));
    });
    const time = await settle(() => browser.execute(() => window.fastStream.currentTime), (t) => t >= 4.9);
    expect(time).toBeGreaterThanOrEqual(4.9);

    const slider = await browser.execute(() => {
      const block = document.querySelector('.mainplayer .volume_block');
      return ['role', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].map((name) => block.getAttribute(name));
    });
    expect(slider).toEqual(['slider', '0', '300', '150', '150%']);
  });

  it('does not carry the previous video\'s skip markers and button over', async function() {
    // They were redrawn only once the next video had a duration.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    const read = () => browser.execute(() => ({
      button: document.querySelector('.mainplayer .skip_button').style.display,
      shiftedUp: document.querySelector('.mainplayer .skip_button').classList.contains('shiftup'),
      banner: document.querySelector('.mainplayer .next_video_button').style.display,
      frozen: document.querySelector('.mainplayer .fluid_controls_progress_container').classList.contains('skip_freeze'),
      markers: document.querySelectorAll('.mainplayer .intro_outro_container .skip_segment').length,
      chapters: document.querySelectorAll('.mainplayer .intro_outro_container .chapter').length,
    }));
    await browser.execute(() => {
      const client = window.fastStream;
      // An outro the analyzer found, which the video is in, and the next video in a
      // playlist, whose banner an outro brings up.
      client.videoAnalyzer.getOutro = () => ({startTime: 7, endTime: 100});
      client.options.autoplayNext = true;
      client.hasNextVideo = () => true;
      client.currentTime = 8;
    });
    // The skip button comes with a time update inside the outro.
    await settle(() => browser.execute(() => document.querySelector('.mainplayer .skip_button').style.display),
        (display) => display === '');
    // And a chapter marker. This draws them all.
    await browser.execute(() => window.fastStream.setChapters([
      {name: 'Opening', startTime: 0},
      {name: 'Closing', startTime: 5},
    ]));
    const shown = {button: '', shiftedUp: true, banner: '', frozen: true, markers: 1, chapters: 1};
    const before = await settle(read, (state) => JSON.stringify(state) === JSON.stringify(shown));
    console.log('      before the switch:', JSON.stringify(before));
    expect(before).toEqual(shown);
    await addSource(missingUrl());
    const cleared = {button: 'none', shiftedUp: false, banner: 'none', frozen: false, markers: 0, chapters: 0};
    const after = await settle(read, (state) => JSON.stringify(state) === JSON.stringify(cleared));
    console.log('      after the switch:', JSON.stringify(after));
    expect(after).toEqual(cleared);
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
});
