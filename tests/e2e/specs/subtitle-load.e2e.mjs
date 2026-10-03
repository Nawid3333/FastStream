// Adding a subtitle file from disk or from a URL.
//
// Something that is no subtitles - another kind of file, a web page in place of the file -
// parses to no cue at all, and the parser does not complain. From disk it became an empty
// track without a word, or, when the parse threw, vanished without one; from a URL it
// became an empty track, and the player said it was added.

import {browser, expect} from '@wdio/globals';

const VTT = 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n';
const HTML = '<!doctype html><title>Sign in</title><p>Please sign in to download</p>';

/**
 * Opens the player with no source, with its toasts, prompts and simple requests recorded
 * by the test.
 * @return {Promise<void>}
 */
async function openPlayer() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  const error = await browser.executeAsync((done) => {
    Promise.all([
      import('/player/utils/AlertPolyfill.mjs'),
      import('/player/utils/RequestUtils.mjs'),
    ]).then(([{AlertPolyfill}, {RequestUtils}]) => {
      window.__toasts = [];
      AlertPolyfill.toast = async (icon, message) => {
        window.__toasts.push(icon);
      };
      AlertPolyfill.prompt = async () => window.__promptAnswer;
      // The URL is read as bytes now (decodeSubtitleBytes), as the request gives them.
      RequestUtils.requestSimple = (details, callback) => setTimeout(() => callback(null,
          {getResponseHeader: () => null}, Array.isArray(window.__urlBody) ?
          new Uint8Array(window.__urlBody).buffer : new TextEncoder().encode(window.__urlBody).buffer), 0);
      done(null);
    }).catch((e) => done(String(e)));
  });
  expect(error).toBe(null);
}

const state = () => browser.execute(() => ({
  tracks: window.fastStream.interfaceController.subtitlesManager.tracks.map((track) => track.label),
  toasts: window.__toasts,
}));

/**
 * Picks a file in the subtitle menu's file chooser.
 * @param {string} name - The file's name.
 * @param {string|number[]} text - Its contents, as text or as bytes.
 * @return {Promise<void>}
 */
async function pickFile(name, text) {
  await browser.execute((name, text) => {
    window.__toasts.length = 0;
    const chooser = Array.from(document.querySelectorAll('input[type="file"]')).find((input) => input.accept.includes('.vtt'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([Array.isArray(text) ? new Uint8Array(text) : text], name));
    chooser.files = transfer.files;
    chooser.dispatchEvent(new Event('change'));
  }, name, text);
  await browser.pause(300);
}

/**
 * Adds a subtitle URL through the subtitle menu, the page at it answering with a text.
 * @param {string|number[]} body - What the URL answers, as text or as bytes.
 * @return {Promise<void>}
 */
async function addUrl(body) {
  const error = await browser.executeAsync((body, done) => {
    import('/player/modules/Localize.mjs').then(({Localize}) => {
      window.__toasts.length = 0;
      window.__promptAnswer = 'https://subs.example/track.vtt';
      window.__urlBody = body;
      const label = Localize.getMessage('player_subtitlesmenu_urlbtn');
      const option = Array.from(document.querySelectorAll('.subtitle-menu-option')).find((el) => el.textContent === label);
      option.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      done(null);
    }).catch((e) => done(String(e)));
  }, body);
  expect(error).toBe(null);
  await browser.pause(300);
}

describe('Adding a subtitle file', function() {
  beforeEach(openPlayer);

  it('says so, and adds nothing, when a file from disk is no subtitles', async function() {
    await pickFile('notes.srt', HTML);
    expect(await state()).toEqual({tracks: [], toasts: ['error']});
    await pickFile('real.vtt', VTT);
    expect((await state()).tracks).toEqual(['real.vtt']);
  });

  it('says so, and adds nothing, when a subtitle URL is no subtitles', async function() {
    await addUrl(HTML);
    // 'info' is the "downloading" toast.
    expect(await state()).toEqual({tracks: [], toasts: ['info', 'error']});
    await addUrl(VTT);
    expect(await state()).toEqual({tracks: ['URL Track'], toasts: ['info', 'success']});
  });

  it('reads a Windows-1252 file with its umlauts, from disk and from a URL', async function() {
    // Read as UTF-8, as the browser does, each of these letters was the replacement mark.
    const srt = Array.from('1\n00:00:00,000 --> 00:00:01,000\nGr', (c) => c.charCodeAt(0)).concat([0xfc, 0xdf, 0x65]);
    const expected = 'Gr' + String.fromCharCode(0xfc, 0xdf) + 'e';
    await pickFile('de.srt', srt);
    await addUrl(srt);
    const texts = await browser.execute(() => window.fastStream.interfaceController.subtitlesManager.tracks
        .map((track) => track.cues.map((cue) => cue.text)));
    expect(texts).toEqual([[expected], [expected]]);
  });
});
