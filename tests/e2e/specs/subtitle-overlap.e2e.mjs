// Subtitle cues that overlap (#181).
//
// A track's cues are sorted by start time only. renderSubtitles looked back from the last
// cue that had started only as far as the first one already over, so a long cue (a sign,
// a song, a narrator) went off screen whenever a shorter cue that started after it ended.
// And the cues on screen were only ever appended, so after a seek back into an overlap a
// cue that came back was drawn below one that started after it.

import {browser, expect} from '@wdio/globals';

describe('Overlapping subtitle cues', function() {
  before(async function() {
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
      globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.mp4');
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.player),
        {timeout: 60000, timeoutMsg: 'the player never loaded'});
    await browser.execute(() => window.fastStream.currentVideo.pause());
  });

  it('keeps a long cue on screen over shorter ones, and the lines in start order', async function() {
    const result = await browser.executeAsync((done) => {
      import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
        const client = window.fastStream;
        const manager = client.interfaceController.subtitlesManager;
        const track = new SubtitleTrack('Overlap', 'en');
        track.loadText('WEBVTT\n\n00:00.000 --> 00:10.000\nSIGN\n\n' +
          '00:02.000 --> 00:03.000\nA\n\n00:02.500 --> 00:04.000\nB\n');
        client.loadSubtitleTrack(track);
        manager.activateTrack(track);

        // The video is paused, so nothing moves the time between these renders.
        const shownAt = (time) => {
          client.state.currentTime = time;
          manager.renderSubtitles();
          const container = manager.subtitleTrackDisplayElements[0];
          return container.style.opacity === '0' ? [] :
            Array.from(container.children).map((cue) => cue.textContent);
        };
        done({
          at1: shownAt(1),
          at3_5: shownAt(3.5),
          // back into the overlap: A comes back, and goes above B, which started after it
          at2_7: shownAt(2.7),
          at5: shownAt(5),
          at11: shownAt(11),
        });
      }, (e) => done({error: String(e)}));
    });
    console.log('      ', JSON.stringify(result));

    expect(result.error).toBeUndefined();
    expect(result.at1).toEqual(['SIGN']);
    expect(result.at3_5).toEqual(['SIGN', 'B']);
    expect(result.at2_7).toEqual(['SIGN', 'A', 'B']);
    expect(result.at5).toEqual(['SIGN']);
    expect(result.at11).toEqual([]);
  });
});
