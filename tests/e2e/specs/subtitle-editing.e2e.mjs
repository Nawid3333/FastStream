// Editing subtitles in the player: the resync tool's cue prompts, the keys on a track's row
// in the subtitles menu, and the menu's file upload.
//
// Each case opens the web player with no source and hands it one the way main.mjs does,
// with autoplay and remembered positions off.
import {browser, expect} from '@wdio/globals';

const mp4Url = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/sample.mp4`;

/**
 * Opens the player on the MP4 fixture, autoplay and remembered positions off, and waits
 * for its picture.
 * @return {Promise<void>}
 */
async function openPlayer() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  // main.mjs applies the stored options once the client exists, which would undo the
  // overrides below; it sets optionsApplied when it has.
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player options never loaded'});
  const error = await browser.executeAsync((url, done) => {
    window.fastStream.options.autoPlay = false;
    window.fastStream.options.storeProgress = false;
    Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
        .then(([{VideoSource}, {URLUtils}]) => {
          window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
          done(null);
        }).catch((e) => done(String(e)));
  }, mp4Url());
  expect(error).toBe(null);
  await browser.waitUntil(async () => browser.execute(() => {
    const client = window.fastStream;
    return !!client.player && client.duration > 0 && client.currentVideo?.readyState >= 2;
  }), {timeout: 30000, timeoutMsg: 'the video never loaded'});
}

/**
 * Loads a track with one cue, 1 to 3 s, and opens it in the resync tool in edit mode.
 * @return {Promise<void>}
 */
async function editTrack() {
  await browser.executeAsync((done) => {
    import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
      const client = window.fastStream;
      const track = new SubtitleTrack('Edit test', 'en');
      track.loadText('1\n00:00:01,000 --> 00:00:03,000\nOld line\n\n');
      window.__track = client.loadSubtitleTrack(track);
      window.subEditMode = true;
      client.interfaceController.subtitlesManager.subtitleSyncer.toggleTrack(window.__track);
      done();
    });
  });
}

/**
 * Double-clicks the resync tool's track at a time, which opens its text prompt, and
 * answers the prompt.
 * @param {number} time - Where on the track, in seconds.
 * @param {?string} text - What to confirm, or null to press Cancel.
 * @return {Promise<Array<{start: number, end: number, text: string}>>} The track's cues then.
 */
async function doubleClickAndAnswer(time, text) {
  await browser.execute((time) => {
    const client = window.fastStream;
    client.interfaceController.fineTimeControls.mousePositionToTime = () => time;
    client.interfaceController.subtitlesManager.subtitleSyncer.ui.timelineTrack
        .dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}));
  }, time);
  const popup = await browser.$('.fs-dialog');
  await popup.waitForDisplayed({timeout: 5000});
  if (text === null) {
    await (await browser.$('.fs-dialog-cancel')).click();
  } else {
    await browser.execute((text) => {
      document.querySelector('.fs-dialog-input').value = text;
    }, text);
    await (await browser.$('.fs-dialog-confirm')).click();
  }
  await popup.waitForDisplayed({reverse: true, timeout: 5000});
  await browser.pause(300);
  return browser.execute(() => window.__track.cues.map((cue) => ({start: cue.startTime, end: cue.endTime, text: cue.text})));
}

describe('Subtitle editing', function() {
  it('keeps a cue whose edit is cancelled', async function() {
    // Cancel gives the prompt no value, which was taken for emptied text: the cue went.
    await openPlayer();
    await editTrack();
    const cues = await doubleClickAndAnswer(2, null);
    console.log('      after cancel:', JSON.stringify(cues));
    expect(cues).toEqual([{start: 1, end: 3, text: 'Old line'}]);
  });

  it('removes a cue whose text is emptied, and edits one whose text is changed', async function() {
    await openPlayer();
    await editTrack();
    expect(await doubleClickAndAnswer(2, 'New line')).toEqual([{start: 1, end: 3, text: 'New line'}]);
    expect(await doubleClickAndAnswer(2, '')).toEqual([]);
  });

  it('adds no cue when the new one is cancelled', async function() {
    // The cue was added before the prompt, and stayed as "New subtitle".
    await openPlayer();
    await editTrack();
    const cues = await doubleClickAndAnswer(6, null);
    console.log('      after cancel:', JSON.stringify(cues));
    expect(cues).toEqual([{start: 1, end: 3, text: 'Old line'}]);
    expect(await doubleClickAndAnswer(6, 'Added')).toEqual([
      {start: 1, end: 3, text: 'Old line'},
      {start: 6, end: 8, text: 'Added'},
    ]);
  });

  it('leaves Shift+Backspace over a track\'s row to the player, which undoes a seek', async function() {
    // The row has the focus while the mouse is over it, and took Shift+Backspace for its
    // own Backspace: the track was removed and the seek stayed.
    await openPlayer();
    const state = await browser.executeAsync((done) => {
      import('/player/SubtitleTrack.mjs').then(async ({SubtitleTrack}) => {
        const client = window.fastStream;
        const track = new SubtitleTrack('Row test', 'en');
        track.loadText('1\n00:00:01,000 --> 00:00:03,000\nA line\n\n');
        client.loadSubtitleTrack(track);
        client.currentTime = 2;
        client.currentTime = 7;
        await new Promise((resolve) => setTimeout(resolve, 300));
        const row = document.querySelector('.mainplayer .subtitles_list .subtitle-track-element');
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown',
            {key: 'Backspace', code: 'Backspace', shiftKey: true, bubbles: true, cancelable: true}));
        await new Promise((resolve) => setTimeout(resolve, 300));
        done({tracks: client.interfaceController.subtitlesManager.tracks.length, currentTime: client.currentTime});
      });
    });
    console.log('      after Shift+Backspace:', JSON.stringify(state));
    expect(state.tracks).toBe(1);
    expect(state.currentTime).toBeCloseTo(2, 1);
  });

  it('names a downloaded track after the track, not after its row', async function() {
    // With two tracks on, a row reads "1: (en) Foo Bar", and the name offered was
    // "1:__(en)_Foo_Bar"; Firefox refuses a file name with a colon.
    await openPlayer();
    await browser.executeAsync((done) => {
      import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
        const client = window.fastStream;
        const manager = client.interfaceController.subtitlesManager;
        for (const [label, language] of [['Foo Bar', 'en'], ['Other', 'de']]) {
          const track = new SubtitleTrack(label, language);
          track.loadText('1\n00:00:01,000 --> 00:00:03,000\nA line\n\n');
          const loaded = client.loadSubtitleTrack(track);
          if (!manager.activeTracks.includes(loaded)) manager.activateTrack(loaded);
        }
        done();
      });
    });
    const rowText = await browser.execute(() => document.querySelector('.mainplayer .subtitles_list .subtitle-track-name').textContent);
    console.log('      first row:', JSON.stringify(rowText));
    expect(rowText.startsWith('1: ')).toBe(true);
    await browser.execute(() => document.querySelector('.mainplayer .subtitles_list .subtitle-download-tool')
        .dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
    const popup = await browser.$('.fs-dialog');
    await popup.waitForDisplayed({timeout: 5000});
    const offered = await browser.execute(() => document.querySelector('.fs-dialog-input').value);
    await (await browser.$('.fs-dialog-cancel')).click();
    await popup.waitForDisplayed({reverse: true, timeout: 5000});
    expect(offered).toBe('(en)_Foo_Bar');
  });

  it('saves the track that was clicked when the tracks change while its name is asked for', async function() {
    // The track was looked up after the name prompt, so a new video's tracks by then had
    // another track saved under this one's name (and an emptied list threw).
    await openPlayer();
    await browser.executeAsync((done) => {
      Promise.all([import('/player/SubtitleTrack.mjs'), import('/player/utils/Utils.mjs')]).then(([{SubtitleTrack}, {Utils}]) => {
        window.__saved = [];
        Utils.downloadURL = async (url, name) => {
          window.__saved.push({name, text: await (await fetch(url)).text()});
        };
        const client = window.fastStream;
        const manager = client.interfaceController.subtitlesManager;
        const track = new SubtitleTrack('Clicked', 'en');
        track.loadText('1\n00:00:01,000 --> 00:00:03,000\nThe clicked line\n\n');
        const loaded = client.loadSubtitleTrack(track);
        if (!manager.activeTracks.includes(loaded)) manager.activateTrack(loaded);
        done();
      });
    });
    await browser.execute(() => document.querySelector('.mainplayer .subtitles_list .subtitle-download-tool')
        .dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
    const popup = await browser.$('.fs-dialog');
    await popup.waitForDisplayed({timeout: 5000});
    // Another track takes the row's place while the prompt is open, as a new video's does.
    await browser.executeAsync((done) => {
      import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
        const client = window.fastStream;
        client.interfaceController.subtitlesManager.clearTracks();
        const other = new SubtitleTrack('Other', 'de');
        other.loadText('1\n00:00:01,000 --> 00:00:03,000\nAnother video\'s line\n\n');
        client.loadSubtitleTrack(other);
        done();
      });
    });
    await (await browser.$('.fs-dialog-confirm')).click();
    await browser.waitUntil(async () => browser.execute(() => window.__saved.length > 0), {timeout: 5000}).catch(() => {});
    const saved = await browser.execute(() => window.__saved);
    console.log('      saved:', JSON.stringify(saved));
    expect(saved.length).toBe(1);
    expect(saved[0].name).toBe('(en)_Clicked.srt');
    expect(saved[0].text).toContain('The clicked line');
  });

  it('can load the same subtitle file twice', async function() {
    // The file input kept the file it had read, and picking the same file again fires no
    // change event, so nothing happened.
    await openPlayer();
    const state = await browser.executeAsync((done) => {
      const input = document.querySelector('.mainplayer input[type=file][accept=".vtt, .srt"]');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['1\n00:00:01,000 --> 00:00:03,000\nA line\n\n'], 'lines.srt'));
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event('change'));
      // The file is read on its own time (file.arrayBuffer()), up to 5 s.
      const started = Date.now();
      const read = () => {
        const tracks = window.fastStream.interfaceController.subtitlesManager.tracks.length;
        if (tracks || Date.now() - started > 5000) {
          done({value: input.value, tracks});
        } else {
          setTimeout(read, 25);
        }
      };
      read();
    });
    console.log('      after one upload:', JSON.stringify(state));
    expect(state.tracks).toBe(1);
    // An empty input fires change for any file picked next, the same one included.
    expect(state.value).toBe('');
  });
});
