// Exercises vendored libraries that the playback suite never reaches.
//
// The playback specs cover hls.js, dash.js and mp4box because those sit on
// the path a video takes. The encoding libraries do not: they run only when
// someone exports a GIF or remuxes a download. That gap is not theoretical -
// migrating mp4box on a "the diff only adds things" argument shipped a
// regression that no test caught, and only a real end-to-end check found it.
//
// So each library migrated from npm gets a test that makes it do its actual
// job and inspects the bytes it produces. Importing the module and finding
// its exports present proves nothing; a wrong worker URL or a broken UMD
// unwrap both import cleanly and then fail at run time.
//
// These load the modules straight from the served web build rather than
// through the player UI, because the UI paths need a loaded video, a set loop
// region and several seconds of playback to reach the same code.

import {browser, expect} from '@wdio/globals';

/**
 * Runs an async snippet in the page and waits for it to settle.
 *
 * `browser.execute` returns as soon as the synchronous part of the script is
 * done, so a promise-returning body would report success before the work it
 * started had finished - or failed. This parks the outcome on `window` and
 * polls for it, which reports the page-side error text instead of a bare
 * timeout when something goes wrong.
 *
 * @param {Function} fn async function to run in the page
 * @param {number} [timeout] how long to allow, in ms
 * @return {Promise<any>} whatever fn resolved with
 */
async function runInPage(fn, timeout = 60000) {
  await browser.execute((body) => {
    window.__out = undefined;
    window.__err = undefined;
    (0, eval)(`(${body})()`)
        .then((v) => {
          window.__out = v;
        })
        .catch((e) => {
          window.__err = (e && e.stack) || String(e);
        });
  }, fn.toString());

  await browser.waitUntil(
      async () => browser.execute(
          () => window.__out !== undefined || window.__err !== undefined),
      {timeout, interval: 250, timeoutMsg: 'the page never settled'},
  );

  const {out, err} = await browser.execute(
      () => ({out: window.__out, err: window.__err}));
  if (err) throw new Error('page-side failure: ' + err);
  return out;
}

describe('vendored encoding libraries', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  it('gif.js encodes a real GIF through its worker', async function() {
    // This is the test that matters for the gif.js migration. The npm build
    // spawns its worker from `options.workerScript`, a bare filename resolved
    // against the *document*, which in the extension is not this directory.
    // sync-vendor.mjs rewrites that to resolve from `import.meta.url`. If the
    // rewrite is wrong the worker 404s, no frame ever finishes, and render()
    // hangs rather than throwing - so a timeout here is a real failure, not
    // flakiness.
    const result = await runInPage(async () => {
      const {GIF} = await import('/player/modules/gif/gif.mjs');
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');

      const gif = new GIF({workers: 1, quality: 10});
      for (const colour of ['#ff0000', '#0000ff']) {
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 32, 32);
        // The canvas element, not its context - matching LoopMenu.mjs. gif.js
        // takes the frame size from the object it is handed, and a context
        // has no width, so passing one leaves the encoder sizeless.
        gif.addFrame(canvas, {copy: true, delay: 100});
      }

      const blob = await new Promise((resolve, reject) => {
        gif.on('finished', resolve);
        gif.on('abort', () => reject(new Error('gif.js aborted')));
        gif.render();
      });
      const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
      return {
        size: blob.size,
        type: blob.type,
        magic: String.fromCharCode(...head),
      };
    });

    console.log('      gif:', JSON.stringify(result));
    // GIF89a is the header every GIF written by this encoder starts with.
    expect(result.magic).toBe('GIF89a');
    expect(result.type).toBe('image/gif');
    expect(result.size).toBeGreaterThan(100);
  });

  it('mp4-muxer writes a valid MP4 container', async function() {
    const result = await runInPage(async () => {
      const {Muxer, ArrayBufferTarget} =
        await import('/player/modules/reencoder/mp4-muxer.mjs');
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: {codec: 'avc', width: 64, height: 64},
        fastStart: 'in-memory',
      });
      muxer.finalize();
      const bytes = new Uint8Array(target.buffer);
      return {
        length: bytes.length,
        // Every ISO-BMFF file opens with a size field then the 'ftyp' box
        // type at offset 4. Getting this right means the muxer actually ran
        // its box writers, not merely that the module imported.
        boxType: String.fromCharCode(...bytes.slice(4, 8)),
      };
    });

    console.log('      mp4-muxer:', JSON.stringify(result));
    expect(result.boxType).toBe('ftyp');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('vendored demuxers', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  it('webm.mjs demuxes a real VP9 stream', async function() {
    // Every change in patches/jswebm@0.1.2.patch is exercised here, which is
    // the point: webm.mjs stopped being a hand-made blob and became jswebm's
    // published sources plus that patch, and nothing else in the suite
    // touches this code path.
    //
    // demux()'s boolean return is the one to watch. Upstream returns
    // nothing, so WebMDemuxer.process() - `while (this.demuxer.demux())` -
    // stops on the first call and the demuxer yields no packets at all.
    // Verified by removing the return and watching this fail; a test that
    // only imported the module would not notice.
    const result = await runInPage(async () => {
      const {WebMDemuxer} =
        await import('/player/modules/reencoder/demuxers.mjs');
      const bytes = new Uint8Array(
          await (await fetch('/fixtures/sample.webm')).arrayBuffer());

      const demuxer = new WebMDemuxer();
      demuxer.initialize(bytes.buffer);
      const config = demuxer.getVideoDecoderConfig();
      const chunks = demuxer.getVideoChunks(10);
      return {
        codec: config && config.codec,
        width: config && config.codedWidth,
        height: config && config.codedHeight,
        chunks: chunks.length,
        keyframes: chunks.filter((c) => c.type === 'key').length,
      };
    });

    console.log('      webm:', JSON.stringify(result));
    // The full codec string comes from initVp9Headers, which reads the VP9
    // profile out of the first frame. Upstream jswebm reports a bare "vp9",
    // which WebCodecs rejects as an incomplete codec string.
    expect(result.codec).toMatch(/^vp09\.\d\d\.\d\d\.\d\d/);
    expect(result.width).toBe(160);
    expect(result.height).toBe(120);
    expect(result.chunks).toBeGreaterThan(0);
    // Chunk types come from `isKeyframe`, which upstream sets from a
    // misspelled field and so leaves undefined on every frame.
    expect(result.keyframes).toBeGreaterThan(0);
  });
});

describe('the colour picker', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  it('coloris opens inside the player and sets a colour', async function() {
    // coloris.mjs is generated from a git dependency the lockfile pins by
    // commit, plus patches/Coloris@0.21.1.patch. Nothing else in the suite
    // touches the picker, and what that patch does is scope it to a
    // container element instead of the document - so this drives the page's
    // own instance, the one InterfaceController creates with
    // `parent: '.mainplayer'`, rather than standing up a second one.
    //
    // That matters for more than realism: coloris addresses its own UI by
    // fixed element ids, so two pickers in one document would collide and a
    // document-wide query would silently test the wrong one.
    const result = await runInPage(async () => {
      const {Coloris} = await import('/player/modules/coloris.mjs');

      const picker = document.querySelector('#clr-picker');
      if (!picker) throw new Error('the player never built its picker');

      const input = document.createElement('input');
      input.value = '#ff0000';
      document.querySelector('.mainplayer').appendChild(input);
      Coloris.bindElement(input);

      input.click();
      await new Promise((r) => setTimeout(r, 200));
      const open = picker.classList.contains('clr-open');

      const colorValue = picker.querySelector('#clr-color-value');
      colorValue.value = '#00ff00';
      colorValue.dispatchEvent(new Event('change', {bubbles: true}));
      await new Promise((r) => setTimeout(r, 200));

      return {
        // The patch renders the picker into the configured parent. Left
        // unpatched it attaches to document.body, so this is the assertion
        // that separates a working container rebinding from a broken one.
        parent: picker.parentElement.className,
        open,
        value: input.value,
      };
    });

    console.log('      coloris:', JSON.stringify(result));
    expect(result.parent).toContain('mainplayer');
    expect(result.open).toBe(true);
    expect(result.value).toBe('#00ff00');
  });
});
