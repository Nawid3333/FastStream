// "Dump buffer" writes what the player has downloaded into an .fsa archive; dropping the
// archive on a player opens the video again from it. Two ways that broke:
//
// - The archive had no manifest. To keep live streams moving, the HLS and DASH loaders
//   removed every playlist and MPD from the download store right after loading it, and
//   the archive is written from that store. A player opened from the archive had to fetch
//   the manifest again: offline, or once the URL had expired, it could not play at all.
// - Opening a large archive failed. The file is read in chunks as the archive is parsed,
//   through an object URL that was revoked once the first two chunks were requested, so
//   any archive over 500 MB (two 250 MB chunks) ended in "archive failed". Here the chunk
//   size is lowered to 64 KB, so that this small archive spans many chunks.
//
// Each case plays a local stream, writes its archive the way dumpBuffer does, drops it on
// a fresh player page through the player's own drop handler, and checks that the video
// plays again with no manifest fetched from the network. (A fresh page, as when an
// archive is opened later: dropped on the player still showing the same video, the
// archive's source is taken for the one already in the list.)

import {browser, expect} from '@wdio/globals';

const CASES = [
  {
    name: 'HLS with a separate audio rendition',
    source: '/fixtures/hls-audio/master.m3u8',
    manifests: ['/fixtures/hls-audio/master.m3u8', '/fixtures/hls-audio/stream_0/index.m3u8',
      '/fixtures/hls-audio/stream_1/index.m3u8'],
  },
  {
    name: 'DASH',
    source: '/fixtures/dash-template/manifest.mpd',
    manifests: ['/fixtures/dash-template/manifest.mpd'],
  },
];

/**
 * Resource Timing's record of the manifests fetched so far.
 * @param {string[]} manifests - Absolute manifest URLs.
 * @return {Promise<string[]>}
 */
async function fetchedManifests(manifests) {
  return browser.execute((manifests) => performance.getEntriesByType('resource')
      .map((entry) => entry.name.split('#')[0])
      .filter((name) => manifests.includes(name)), manifests);
}

/**
 * Waits for the video to have a frame to show, nudging it to play.
 * @param {string} label - For the log.
 * @return {Promise<Object>} The video's state.
 */
async function waitForPlayback(label) {
  let state = {};
  await browser.waitUntil(async () => {
    state = await browser.execute(() => {
      const client = window.fastStream;
      const video = client?.currentVideo;
      if (video?.paused) video.play().catch(() => {});
      return {
        readyState: video?.readyState ?? null,
        currentTime: video?.currentTime ?? null,
        fromArchive: !!client?.source?.loadedFromArchive,
        failed: !!client?.interfaceController?.failed,
        status: Array.from(document.querySelectorAll('.status_message'))
            .map((element) => element.textContent.trim()).filter(Boolean),
      };
    });
    return state.readyState >= 2 || state.failed;
  }, {timeout: 45000, interval: 250}).catch(() => {});
  console.log(`      ${label}:`, JSON.stringify(state));
  return state;
}

describe('An archive written by "dump buffer"', function() {
  for (const stream of CASES) {
    it(`opens again from the archive alone: ${stream.name}`, async function() {
      const origin = globalThis.__E2E_FIXTURES_ORIGIN__;
      const manifests = stream.manifests.map((path) => origin + path);
      await browser.url(`/player/index.html?t=${Date.now()}#${origin}${stream.source}`);
      await browser.execute(() => performance.setResourceTimingBufferSize(100000));
      const first = await waitForPlayback('first play');
      expect(first.readyState).toBeGreaterThanOrEqual(2);

      // The control: Resource Timing does see the player's manifest downloads.
      expect((await fetchedManifests(manifests)).length).toBeGreaterThan(0);

      const written = await browser.executeAsync((done) => {
        (async () => {
          const client = window.fastStream;
          const {FastStreamArchiveUtils} = await import('/player/utils/FastStreamArchiveUtils.mjs');
          const entries = client.downloadManager.getCompletedEntries();
          const chunks = [];
          await FastStreamArchiveUtils.writeFSAToStream(new WritableStream({
            write(chunk) {
              chunks.push(chunk);
            },
          }), client.player, entries);
          await new Promise((resolve) => setTimeout(resolve, 100));
          const file = new File(chunks, 'roundtrip.fsa');
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          return {stored: entries.map((entry) => entry.url), size: file.size, base64: dataUrl.split(',')[1]};
        })().then(done, (e) => done({error: String(e)}));
      });
      console.log('      archive:', JSON.stringify({error: written.error, stored: written.stored?.length, size: written.size}));
      expect(written.error).toBeUndefined();

      // Every manifest the player loaded is in the archive, which spans many chunks.
      for (const manifest of manifests) {
        expect(written.stored).toContain(manifest);
      }
      expect(written.size).toBeGreaterThan(4 * 64 * 1024);

      // A fresh player page, with nothing loaded, gets the archive dropped on it.
      await browser.url(`/player/index.html?t=${Date.now()}`);
      await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.interfaceController?.saveManager),
          {timeout: 30000, timeoutMsg: 'the empty player never set up'});
      const dropped = await browser.executeAsync((base64, done) => {
        (async () => {
          const client = window.fastStream;
          const {FastStreamArchiveUtils} = await import('/player/utils/FastStreamArchiveUtils.mjs');
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const file = new File([bytes], 'roundtrip.fsa');
          FastStreamArchiveUtils.fileChunkSize = 64 * 1024;
          performance.setResourceTimingBufferSize(100000);
          performance.clearResourceTimings();
          await client.interfaceController.saveManager.onFileDrop({
            stopPropagation() {},
            preventDefault() {},
            dataTransfer: {files: [file]},
          });
          return {fromArchive: !!client.source?.loadedFromArchive};
        })().then(done, (e) => done({error: String(e)}));
      }, written.base64);
      console.log('      dropped:', JSON.stringify(dropped));
      expect(dropped.error).toBeUndefined();
      expect(dropped.fromArchive).toBe(true);

      const again = await waitForPlayback('from the archive');
      expect(again.fromArchive).toBe(true);
      expect(again.failed).toBe(false);
      expect(again.readyState).toBeGreaterThanOrEqual(2);
      // Nothing of the manifests came from the network.
      expect(await fetchedManifests(manifests)).toEqual([]);
    });
  }
});
