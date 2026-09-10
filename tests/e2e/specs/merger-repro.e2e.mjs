// Minimal reproduction of the MP4Merger finalize failure on the web build:
// slice a Blob (as stored by FSBlob's OPFS backend), then FileReader it -
// exactly what the new OPFS finalize path does per mdat chunk.

import {browser, expect} from '@wdio/globals';

describe('mp4merger finalize micro-repro', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  it('slice + FileReader on an OPFS-backed stored blob', async function() {
    await browser.waitUntil(
        async () => browser.execute(() => !!window.fastStream),
        {timeout: 30000, timeoutMsg: 'fastStream never appeared'});

    const result = await browser.executeAsync((done) => {
      (async () => {
        const out = {};
        try {
          const {FSBlob} = await import('/player/modules/FSBlob.mjs');
          const store = new FSBlob();

          // Simulate DownloadEntry.archiveEntryData: store a real blob.
          const payload = new Uint8Array(2048);
          for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
          const id = await store.saveBlobAsync(new Blob([payload]));

          const stored = store.getBlob(id);
          out.storedType = stored?.constructor?.name;
          out.storedSize = stored?.size;

          // What pushFragment now does:
          const slice = stored.slice(8, 1024);
          out.sliceSize = slice.size;

          // What finalize now does:
          const {BlobManager} = await import('/player/utils/BlobManager.mjs');
          const buf = await BlobManager.getDataFromBlob(slice, 'arraybuffer');
          out.readBackSize = buf.byteLength;
          out.readBackOk = buf.byteLength === slice.size;

          await store.deleteBlob(id);
          store.close();
          return out;
        } catch (e) {
          out.error = (e && e.stack) || String(e);
          return out;
        }
      })().then(done);
    });

    console.log('      micro-repro:', JSON.stringify(result));
    expect(result.error).toBe(undefined);
    expect(result.readBackOk).toBe(true);
  });
});
