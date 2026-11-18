// TTML and DFXP subtitles, read by Firefox's own XML parser into the player's cues: the
// document walk TtmlSubtitles.test.mjs cannot run without a DOM.

import {browser, expect} from '@wdio/globals';

const IMSC = `<?xml version="1.0" encoding="UTF-8"?>
<!-- an IMSC text profile document -->
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xml:lang="en" ttp:timeBase="media">
  <head>
    <styling>
      <style xml:id="base" tts:color="white"/>
      <style xml:id="em" style="base" tts:fontStyle="italic"/>
    </styling>
  </head>
  <body style="base">
    <div begin="10s">
      <p begin="00:00:01.000" end="00:00:02.500">Hello,
        <br/>   world</p>
      <p begin="00:00:03.000" end="00:00:04.000"><span style="em">Whispers</span> and <span tts:fontWeight="bold">shouts</span></p>
      <p begin="5s" dur="1.5s">A &lt; B &amp; C --&gt; D</p>
    </div>
    <div begin="00:00:30.000" end="00:00:31.000">
      <p begin="0s" end="5s">cut at its div's end</p>
      <p begin="2s" end="3s">after its div: never shown</p>
    </div>
  </body>
</tt>`;

const DFXP = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/2006/10/ttaf1" xmlns:ttp="http://www.w3.org/2006/10/ttaf1#parameter"
    xmlns:tts="http://www.w3.org/2006/10/ttaf1#styling" ttp:tickRate="10000000">
  <body><div>
    <p begin="15000000t" end="25000000t">Ticks</p>
    <p begin="30000000t">Open<span tts:fontStyle="italic"> end</span></p>
    <p begin="45000000t" end="50000000t">Next</p>
    <p begin="60000000t">Last open</p>
  </div></body>
</tt>`;

const EBU = `<?xml version="1.0"?>
<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    ttp:timeBase="smpte" ttp:frameRate="25">
  <tt:body><tt:div>
    <tt:p begin="00:00:01:12" end="00:00:02:00"><tt:span>Frames</tt:span></tt:p>
  </tt:div></tt:body>
</tt:tt>`;

const TIMING = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><body>
  <div timeContainer="seq">
    <p dur="2s">A</p>
    <p dur="2s">B</p>
    <p begin="1s" dur="1s">C</p>
  </div>
  <div begin="20s">
    <p begin="1s" end="10s" dur="2s">the earlier end</p>
    <p begin="5s" end="6s" tts:fontStyle="italic"><br/>after a break</p>
    <p begin="7s" end="8s" tts:fontStyle="italic">slanted <span tts:fontStyle="normal">upright</span></p>
  </div>
</body></tt>`;

/**
 * The cues SubtitleTrack.loadText reads from this text, in the player page.
 * @param {string} text
 * @return {Promise<Array<{start: number, end: number, text: string}>|string>} An error's message instead.
 */
const cuesOf = (text) => browser.execute((text) => new Promise((done) => {
  import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
    const track = new SubtitleTrack('t', 'en');
    track.loadText(text);
    done(track.cues.map((cue) => ({start: Math.round(cue.startTime * 1000) / 1000,
      end: Math.round(cue.endTime * 1000) / 1000, text: cue.text})));
  }).catch((e) => done(String(e)));
}), text);

describe('TTML and DFXP subtitles', function() {
  before(async function() {
    await browser.url(`/player/index.html?t=${Date.now()}`);
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied),
        {timeout: 30000, timeoutMsg: 'the player never started'});
  });

  it('reads TTML: nested times, line breaks, styles by reference, escaped text', async function() {
    expect(await cuesOf(IMSC)).toEqual([
      {start: 11, end: 12.5, text: 'Hello,\nworld'},
      {start: 13, end: 14, text: '<i>Whispers</i> and <b>shouts</b>'},
      {start: 15, end: 16.5, text: 'A &lt; B &amp; C --&gt; D'},
      {start: 30, end: 31, text: 'cut at its div\'s end'},
    ]);
  });

  it('reads DFXP in ticks, and ends an open cue at the next one', async function() {
    expect(await cuesOf(DFXP)).toEqual([
      {start: 1.5, end: 2.5, text: 'Ticks'},
      {start: 3, end: 4.5, text: 'Open<i> end</i>'},
      {start: 4.5, end: 5, text: 'Next'},
      {start: 6, end: 8, text: 'Last open'},
    ]);
  });

  it('places a seq container\'s children one after another, takes the earlier of end and dur, and styles each run', async function() {
    expect(await cuesOf(TIMING)).toEqual([
      {start: 0, end: 2, text: 'A'},
      {start: 2, end: 4, text: 'B'},
      {start: 5, end: 6, text: 'C'},
      {start: 21, end: 23, text: 'the earlier end'},
      {start: 25, end: 26, text: '<i>after a break</i>'},
      {start: 27, end: 28, text: '<i>slanted </i>upright'},
    ]);
  });

  it('reads a prefixed EBU-TT document in frames', async function() {
    expect(await cuesOf(EBU)).toEqual([{start: 1.48, end: 2, text: 'Frames'}]);
  });

  it('reads nothing from a broken document, and timed-text XML as before', async function() {
    expect(await cuesOf('<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="1s" end="2s">open')).toEqual([]);
    expect(await cuesOf('<?xml version="1.0"?><transcript><text start="1" dur="2">old format</text></transcript>'))
        .toEqual([{start: 1, end: 3, text: 'old format'}]);
  });

  it('adds a .ttml file from disk', async function() {
    const added = await browser.execute((text) => new Promise((done) => {
      const chooser = Array.from(document.querySelectorAll('input[type="file"]')).find((input) => input.accept.includes('.ttml'));
      if (!chooser) return done('no chooser takes .ttml');
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], 'episode.en.ttml'));
      chooser.files = transfer.files;
      chooser.dispatchEvent(new Event('change'));
      const subtitles = window.fastStream.interfaceController.subtitlesManager;
      const started = Date.now();
      const wait = () => {
        const track = subtitles.tracks.find((t) => t.label === 'episode.en.ttml');
        if (track) return done({label: track.label, cues: track.cues.length});
        if (Date.now() - started > 5000) return done('never added');
        setTimeout(wait, 50);
      };
      wait();
    }), IMSC);
    expect(added).toEqual({label: 'episode.en.ttml', cues: 4});
  });
});
