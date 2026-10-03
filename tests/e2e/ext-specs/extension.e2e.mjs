// Smoke tests for the AMO build running as an installed extension.
//
// Everything here is about the extension origin and its CSP. Anything that can
// be proved over http belongs in the other suite, which is faster.

import {expect} from '@wdio/globals';

// openExtensionPage finds the page by its URL: the newest handle can be the welcome page
// a temporary install opens at no fixed moment, which shares the extension's origin.
import {openExtensionPage} from '../extension-page.mjs';
import {runInPage} from '../runInPage.mjs';

describe('the installed extension', function() {
  it('serves its player page from the extension origin', async function() {
    await openExtensionPage('/player/index.html');
    const result = await runInPage(async () => ({
      origin: location.origin,
      protocol: location.protocol,
      path: location.pathname,
      title: document.title,
      // The player builds its UI on load; a near-empty body would mean the
      // page rendered but its scripts never ran. The welcome screen is small
      // - 45 elements with no video loaded - so this is a floor, not a
      // measurement of the UI.
      nodes: document.body.querySelectorAll('*').length,
    }));

    console.log('      page:', JSON.stringify(result));
    expect(result.protocol).toBe('moz-extension:');
    // The player page, not the welcome page a fresh install opens on the same origin.
    expect(result.path).toBe('/player/index.html');
    // Set by the player's own localisation, so this also shows
    // that its startup path ran, not merely that HTML parsed.
    expect(result.title).toContain('FastStream');
    expect(result.nodes).toBeGreaterThan(20);
  });

  it('compiles WebAssembly under the extension CSP', async function() {
    // The manifest allows 'wasm-unsafe-eval'. If that were ever dropped, or
    // Firefox tightened what it means, every wasm feature in the extension
    // would break - and no http-based test could tell, because the CSP does
    // not apply there. This compiles the smallest valid module there is.
    await openExtensionPage('/player/index.html');
    const result = await runInPage(async () => {
      const empty = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ]);
      try {
        const mod = await WebAssembly.compile(empty);
        return {ok: mod instanceof WebAssembly.Module};
      } catch (e) {
        return {ok: false, error: String(e)};
      }
    });

    console.log('      wasm:', JSON.stringify(result));
    expect(result.ok).toBe(true);
  });

  it('runs the remuxer\'s modules under the extension\'s CSP', async function() {
    // The module suite runs the remuxer over http, where the manifest's
    // content_security_policy (script-src 'self' 'wasm-unsafe-eval': no eval, no blob:
    // workers) is not enforced. Mediabunny is a 1.5 MB bundle: this loads it from the
    // extension origin, as a save does, and has it write a file.
    await openExtensionPage('/player/index.html');
    const result = await runInPage(async () => {
      await import(location.origin + '/player/modules/remux/remuxer.mjs');
      const {MP4Writer} = await import(location.origin + '/player/modules/remux/mp4-writer.mjs');
      const {FSBlob} = await import(location.origin + '/player/modules/FSBlob.mjs');
      const blobManager = new FSBlob();
      const writer = new MP4Writer(blobManager, {video: 'vp9'});
      await writer.start();
      const file = await writer.finalize();
      await blobManager.close();
      return {
        size: file.size,
        type: file.type,
        box: new TextDecoder().decode(await file.slice(4, 8).arrayBuffer()),
      };
    });

    console.log('      remux modules:', JSON.stringify(result));
    expect(result.box).toBe('ftyp');
    expect(result.type).toBe('video/mp4');
  });

  it('ships no YouTube support', async function() {
    // NO_YOUTUBE is the splice that makes a Firefox submission possible at
    // all: it removes the path that ran new Function() on code fetched from
    // YouTube at run time. Asserting the files are gone from the *installed*
    // package is the only check that cannot be fooled by a stale build dir.
    await openExtensionPage('/player/index.html');
    const result = await runInPage(async () => {
      const paths = [
        '/player/modules/yt.mjs',
        '/player/modules/googlevideo.mjs',
        '/player/players/yt/YTPlayer.mjs',
        '/player/players/yt/SandboxedEvaluator.mjs',
        '/userscripts/yt_runner.js',
        '/custom/yt_content.js',
        // Removed from web_accessible_resources; StreamSaver cannot build
        // these URLs on Firefox anyway.
        '/temp/probe',
      ];
      const found = [];
      for (const p of paths) {
        const res = await fetch(location.origin + p).catch(() => null);
        if (res && res.ok) found.push(p);
      }
      return {found};
    });

    console.log('      removed:', JSON.stringify(result));
    expect(result.found).toEqual([]);
  });
});
