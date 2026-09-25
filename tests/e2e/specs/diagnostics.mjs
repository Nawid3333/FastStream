// Page state for a failure message, shared by the specs whose waits have timed out on
// the Windows runner with nothing else in the log. Not a spec itself: wdio only runs
// *.e2e.mjs files.

import {browser} from '@wdio/globals';

/**
 * What the video and the OPFS storage were doing: the video's readiness, network state
 * and buffered ranges, and every OPFS worker call that has not answered, with its age.
 * @return {Promise<Object>}
 */
export async function pageState() {
  return browser.executeAsync((done) => {
    const video = document.querySelector('video');
    const state = {
      video: video ? {
        readyState: video.readyState, networkState: video.networkState, paused: video.paused,
        currentTime: video.currentTime, duration: video.duration,
        buffered: Array.from({length: video.buffered.length},
            (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
        error: video.error?.message ?? null,
      } : null,
    };
    import('/player/network/OPFSManager.mjs').then(({OPFSManager}) => {
      state.opfs = [...OPFSManager.live].map((manager) => ({
        session: manager.sessionName, pending: manager.pendingCalls(),
      }));
    }, (e) => {
      state.opfs = 'unreadable: ' + e.message;
    }).finally(() => done(state));
  });
}

/**
 * A logger of phase times: phase('ready') prints "ready after 1.2 s".
 * @return {function(string): void}
 */
export function phaseTimer() {
  const started = Date.now();
  return (what) => console.log(`      ${what} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
