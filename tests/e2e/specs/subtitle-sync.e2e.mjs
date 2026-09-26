// Regression coverage for the subtitle resync tool (SubtitleSyncer): the
// timeline strip that shows a track's cues under the audio so they can be
// dragged into place. Three bugs, none of which showed as an error on screen:
//
//  - renderTracks() picked the cues in view with `start <= max || end >= min`,
//    which is true for every cue, so the whole track sat in the DOM as
//    .timeline_track_cue elements and each was repositioned on every frame.
//  - shiftSubtitles(), what the ShiftSubtitlesLater/Earlier keys call while the
//    tool is open, ended with this.onVideoTimeUpdate(), which SubtitleSyncer
//    does not have: every key press threw a TypeError after shifting, which
//    the key dispatcher (EventEmitter.emit) caught and only logged.
//  - The track row started a drag on any mouse button. A right-click opens a
//    context menu that swallows the mouseup, and the cues then followed the
//    pointer with no button held.
//
// The tool now also says how far the track has been shifted in total.

import {browser, expect} from '@wdio/globals';

describe('Subtitle resync tool', function() {
  before(async function() {
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
      globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/long-av.mp4');
    await browser.waitUntil(
        async () => browser.execute(() => {
          const video = document.querySelector('video');
          return !!(window.fastStream && video && video.readyState >= 2);
        }),
        {timeout: 60000, timeoutMsg: 'video never became ready'});
  });

  it('draws only the cues in view, shifts by key without an error, and drags on the left button only', async function() {
    const result = await browser.executeAsync(async (done) => {
      const out = {uncaught: [], statuses: []};
      window.addEventListener('error', (e) => out.uncaught.push(e.message));
      window.addEventListener('unhandledrejection', (e) => {
        out.uncaught.push(String((e.reason && e.reason.message) || e.reason));
      });
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const client = window.fastStream;
      const controller = client.interfaceController;
      const setStatus = controller.setStatusMessage.bind(controller);
      controller.setStatusMessage = (key, message, ...rest) => {
        if (key === 'subtitles' && message) out.statuses.push(message);
        return setStatus(key, message, ...rest);
      };

      // 300 one-second cues, one every 2 s: 600 s of subtitles on a 160 s video
      const {SubtitleTrack} = await import('/player/SubtitleTrack.mjs');
      const time = (s) => new Date(s * 1000).toISOString().substring(11, 23).replace('.', ',');
      let srt = '';
      for (let i = 0; i < 300; i++) {
        srt += `${i + 1}\n${time(i * 2)} --> ${time(i * 2 + 1)}\nline ${i + 1}\n\n`;
      }
      const track = new SubtitleTrack('Resync test', 'en');
      track.loadText(srt);
      client.loadSubtitleTrack(track);
      out.cues = track.cues.length;

      const syncer = controller.subtitlesManager.subtitleSyncer;
      syncer.toggleTrack(track);
      controller.showControlBar();
      await wait(1000);
      controller.showControlBar();
      await wait(300);
      out.cueElements = document.querySelectorAll('.timeline_track_cue').length;

      // emit() catches a handler's error and hands it to console.error
      const first = track.cues[0].startTime;
      const consoleError = console.error;
      console.error = (...args) => {
        out.uncaught.push('console.error: ' + args.map((a) => (a && a.message) || String(a)).join(' '));
        consoleError(...args);
      };
      client.keybindManager.emit('ShiftSubtitlesLater');
      console.error = consoleError;
      out.keyShift = track.cues[0].startTime - first;

      const row = document.querySelector('.timeline_track');
      const box = document.querySelector('.fluid_controls_timeline_syncer').getBoundingClientRect();
      const x = box.left + box.width / 2;
      const container = row.closest('.fluid_video_wrapper') || document.body;
      const mouse = (target, type, clientX, button) => target.dispatchEvent(
          new MouseEvent(type, {bubbles: true, cancelable: true, clientX, clientY: box.top + 60, button}));

      // right button: no drag
      const beforeRight = track.cues[0].startTime;
      mouse(row, 'mousedown', x, 2);
      mouse(container, 'mousemove', x + 150, 2);
      out.rightDragShift = track.cues[0].startTime - beforeRight;
      mouse(container, 'mouseup', x + 150, 2);

      // left button: the track follows the pointer, and the total is shown
      const beforeLeft = track.cues[0].startTime;
      mouse(row, 'mousedown', x, 0);
      mouse(container, 'mousemove', x + 150, 0);
      mouse(container, 'mouseup', x + 150, 0);
      out.leftDragShift = track.cues[0].startTime - beforeLeft;
      out.shiftTotal = track.shiftTotal;
      out.lastStatus = out.statuses[out.statuses.length - 1] || null;

      syncer.toggleTrack(track);
      done(out);
    });

    console.log('      result:', JSON.stringify(result));
    expect(result.uncaught).toEqual([]);
    expect(result.cues).toBe(300);
    // 60 s in view plus 5 s each side: about 35 cues, never the whole track
    expect(result.cueElements).toBeGreaterThan(0);
    expect(result.cueElements).toBeLessThan(60);
    expect(result.keyShift).toBeCloseTo(0.2, 5);
    expect(result.rightDragShift).toBe(0);
    expect(result.leftDragShift).toBeGreaterThan(0);
    expect(result.shiftTotal).toBeCloseTo(0.2 + result.leftDragShift, 5);
    const total = (Math.round(result.shiftTotal * 100) / 100).toFixed(2);
    expect(result.lastStatus).toContain('+' + total);
  });
});
