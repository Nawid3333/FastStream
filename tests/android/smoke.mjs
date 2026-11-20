// Smoke test of the extension on Firefox for Android in an emulator, over geckodriver's HTTP API
// (docs/notes/build-and-release.md, "Firefox for Android"). geckodriver runs with --allow-system-access, as
// extension pages are privileged:
//   node tests/android/smoke.mjs --build <unpacked build> --media <mp4> [--geckodriver <url>] [--device <serial>]
//     [--adb <adb>] [--out <dir>]
// It packs the build without nativeMessaging, which Firefox for Android refuses in a temporary add-on (mpv mode's;
// Android has no mpv), installs it, waits for the welcome page an install opens, loads the player page from the
// extension's origin, asks the background (it answers, with no script error in the browser console) and plays the
// mp4 in the player, served from this machine (adb reverse); then it turns on "Use player to play MP4 videos" and
// puts the test site in "Auto-enable URLs", opens the mp4's own address, which the player should take, and a page
// with the mp4 in a video element of its own, whose place FastStream's player should take. Each check prints PASS
// or FAIL; any FAIL sets the exit code.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {parseArgs} from 'node:util';
import zlib from 'node:zlib';

const {values: args} = parseArgs({options: {
  'build': {type: 'string'},
  'media': {type: 'string'},
  'adb': {type: 'string', default: 'adb'},
  'geckodriver': {type: 'string', default: 'http://127.0.0.1:4444'},
  'device': {type: 'string', default: 'emulator-5554'},
  'out': {type: 'string', default: 'android-smoke'},
}});
if (!args.build || !args.media) {
  throw new Error('--build <unpacked build folder> and --media <mp4> are required');
}
// The mp4's server, on this machine; adb reverse gives the emulator the same address.
const MediaPort = 41901;
const MediaUrl = `http://127.0.0.1:${MediaPort}/sample.mp4`;
// A site's page with the mp4 in a video element of its own, from the same server.
const PageUrl = `http://127.0.0.1:${MediaPort}/watch`;
const PageHtml = '<!doctype html><title>A page with a video</title>' +
  '<video muted playsinline preload="metadata" src="/sample.mp4" style="width: 640px; height: 360px"></video>';

const ExtensionId = 'thanatus@Nawid';
// Fenix 153+ waits at its first-run screens under automation without automationtest.
const IntentArguments = ['-a', 'android.intent.action.VIEW', '-d', 'about:blank', '--ez', 'automationtest', 'true'];
// The rule loadOptions adds for "Use player to play MP4 videos" (chrome/background/background.mjs).
const Mp4RuleId = 1;

/** @type {Array<string>} */
const failures = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {*} [detail]
 */
function check(name, ok, detail) {
  const shown = detail === undefined ? '' : '  ::  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${shown}`);
  if (!ok) failures.push(name);
}

/**
 * One adb command on the device, bounded: a stuck device must not hold the run.
 * @param {...string} argv
 * @return {Buffer}
 */
function adb(...argv) {
  return execFileSync(args.adb, ['-s', args.device, ...argv], {timeout: 30_000, maxBuffer: 64 * 1024 * 1024});
}

/**
 * One WebDriver command.
 * @param {string} method
 * @param {string} route
 * @param {*} [body]
 * @return {Promise<*>} The answer's value.
 */
async function wd(method, route, body) {
  const response = await fetch(args.geckodriver + route, {
    method,
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const answer = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${route}: ${answer.value?.error}: ${answer.value?.message}`);
  }
  return answer.value;
}

/**
 * Asks until the answer is not null, or the time is up.
 * @template T
 * @param {() => Promise<T|null>} ask
 * @param {number} ms
 * @return {Promise<T|null>}
 */
async function waitFor(ask, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await ask();
    if (value !== null || Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * The build as a zip, without nativeMessaging. Written here, as Windows has no zip command.
 * @param {string} build - The unpacked build.
 * @return {Buffer}
 */
function testPackage(build) {
  const names = fs.readdirSync(build, {recursive: true, withFileTypes: true})
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(build, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();
  /** @type {Array<Buffer>} */
  const local = [];
  /** @type {Array<Buffer>} */
  const central = [];
  let offset = 0;
  for (const name of names) {
    let data = fs.readFileSync(path.join(build, name));
    if (name === 'manifest.json') {
      const manifest = JSON.parse(data.toString('utf8'));
      manifest.permissions = manifest.permissions.filter((/** @type {string} */ p) => p !== 'nativeMessaging');
      data = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    const packed = zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    // The fields both headers share: version 2.0, UTF-8 names, deflate, 1980-01-01, CRC, sizes, name length.
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0);
    common.writeUInt16LE(0x0800, 2);
    common.writeUInt16LE(8, 4);
    common.writeUInt16LE(0x21, 8);
    common.writeUInt32LE(zlib.crc32(data), 10);
    common.writeUInt32LE(packed.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(nameBytes.length, 22);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(0x04034b50);
    local.push(head, common, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    common.copy(entry, 6, 0, 26);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/**
 * Serves the mp4 with byte ranges, as a video host does (RFC 9110: a range only for GET, 416 for one past the end,
 * a backwards one ignored).
 * @param {string} file
 * @return {Promise<http.Server>}
 */
function serveMedia(file) {
  const size = fs.statSync(file).size;
  const server = http.createServer((request, response) => {
    if (new URL(request.url ?? '/', PageUrl).pathname === '/watch') {
      response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      response.end(PageHtml);
      return;
    }
    const range =request.method === 'GET' ? /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '') : null;
    const first = range?.[1] ? Number(range[1]) : null;
    const last = range?.[2] ? Number(range[2]) : null;
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (first !== null && (last === null || last >= first)) {
      start = first;
      end = Math.min(last ?? size - 1, size - 1);
      partial = true;
    } else if (first === null && last !== null) {
      start = Math.max(0, size - last);
      partial = true;
    }
    const headers = {
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    };
    if (partial && (start >= size || (first === null && last === 0))) {
      response.writeHead(416, {...headers, 'Content-Range': `bytes */${size}`});
      response.end();
      return;
    }
    response.writeHead(partial ? 206 : 200, {
      ...headers,
      'Content-Type': 'video/mp4',
      'Content-Length': end - start + 1,
      ...(partial ? {'Content-Range': `bytes ${start}-${end}/${size}`} : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      fs.createReadStream(file, {start, end}).on('error', () => response.destroy()).pipe(response);
    }
  });
  return new Promise((resolve) => server.listen(MediaPort, '127.0.0.1', () => resolve(server)));
}

fs.mkdirSync(args.out, {recursive: true});
const testZip = testPackage(args.build);
fs.writeFileSync(path.join(args.out, 'faststream-android-test.zip'), testZip);

// geckodriver may still be starting.
const ready = await waitFor(async () => {
  const status = await fetch(args.geckodriver + '/status', {signal: AbortSignal.timeout(5000)})
      .then((response) => response.json(), () => null);
  return status?.value?.ready ? true : null;
}, 30_000);
if (!ready) throw new Error(`geckodriver does not answer at ${args.geckodriver}`);

const mediaServer = await serveMedia(args.media);
adb('reverse', `tcp:${MediaPort}`, `tcp:${MediaPort}`);

/** @type {string} */
let session = '';
try {
  const {sessionId, capabilities} = await wd('POST', '/session', {capabilities: {alwaysMatch: {
    'browserName': 'firefox',
    'moz:firefoxOptions': {
      androidPackage: 'org.mozilla.firefox',
      androidDeviceSerial: args.device,
      androidIntentArguments: IntentArguments,
      prefs: {
        // Plays without a tap, silent.
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.volume_scale': '0.0',
      },
    },
  }}});
  session = `/session/${sessionId}`;
  // An emulator without a GPU is slow: the player's modules alone may take longer than the 30 s default.
  await wd('POST', `${session}/timeouts`, {script: 120_000, pageLoad: 120_000});
  console.log(`Firefox for Android ${capabilities.browserVersion}, session ${sessionId}`);
  await run();
} finally {
  // What the screen shows, from the device: WebDriver's screenshot leaves out video frames.
  try {
    fs.writeFileSync(path.join(args.out, 'screen.png'), adb('exec-out', 'screencap', '-p'));
  } catch (e) {
    console.log(`(no screen capture: ${e})`);
  }
  if (session) await wd('DELETE', session).catch(() => {});
  try {
    adb('reverse', '--remove', `tcp:${MediaPort}`);
  } catch (e) {
    // The emulator is going away with it.
  }
  mediaServer.close();
  mediaServer.closeAllConnections();
}

console.log(failures.length ? `${failures.length} failed` : 'all passed');
process.exitCode = failures.length ? 1 : 0;

/**
 * Runs a script in the page the session is in, with a callback (WebDriver's execute/async).
 * @param {string} body - Its last argument is the callback; whatever the body's promise gives or throws is passed.
 * @param {Array<*>} [scriptArgs]
 * @return {Promise<*>} The body's result, or {error} when it threw.
 */
function inPage(body, scriptArgs = []) {
  return wd('POST', `${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      (async (...args) => { ${body} })(...Array.prototype.slice.call(arguments, 0, -1))
          .then((value) => done({value: value ?? null}), (e) => done({error: String(e)}));`,
    args: scriptArgs,
  });
}

/**
 * The extension's origin from Firefox's own record of it, read in the chrome context: for when no page of it opened.
 * @return {Promise<string|null>}
 */
async function originFromProfile() {
  await wd('POST', `${session}/moz/context`, {context: 'chrome'});
  try {
    const uuid = await wd('POST', `${session}/execute/sync`, {
      script: `return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids', '{}'))[arguments[0]] ?? null;`,
      args: [ExtensionId],
    });
    return uuid ? `moz-extension://${uuid}` : null;
  } finally {
    await wd('POST', `${session}/moz/context`, {context: 'content'});
  }
}

/**
 * Script errors from the extension's files in the browser console, read in the chrome context: its background, the
 * modules it imports from player/, its pages and content scripts. Not Firefox's own report of a page that went while
 * a message it sent awaited its answer (a player's FRAME_REMOVED on pagehide): the message arrives, and no code of
 * the page can catch the report. Any other rejection after unload counts.
 * @param {string} prefix - The extension's moz-extension:// origin and a slash, or the scheme alone.
 * @return {Promise<Array<string>>}
 */
async function scriptErrors(prefix) {
  await wd('POST', `${session}/moz/context`, {context: 'chrome'});
  try {
    return await wd('POST', `${session}/execute/sync`, {
      script: `const [prefix, teardown] = arguments;
        const notErrors = Ci.nsIScriptError.warningFlag | Ci.nsIScriptError.infoFlag;
        return Services.console.getMessageArray()
            .filter((m) => m instanceof Ci.nsIScriptError && !(m.flags & notErrors) &&
              String(m.sourceName || '').startsWith(prefix) && !String(m.errorMessage).startsWith(teardown))
            .map((m) => m.errorMessage + ' @ ' + m.sourceName + ':' + m.lineNumber);`,
      args: [prefix, 'Promise rejected after context unloaded: Actor \'Conduits\' destroyed before query \'RuntimeMessage\''],
    });
  } finally {
    await wd('POST', `${session}/moz/context`, {context: 'content'});
  }
}

/**
 * Waits for the video of FastStream's player page (the session's page or frame), starts it through FastStream (the
 * player's own play()) and watches its time pass 1.5 s; the watching only looks.
 * @param {string} name
 * @param {boolean} [framed] - The player is a frame in a site's page.
 */
async function checkPlays(name, framed = false) {
  const look = () => wd('POST', `${session}/execute/sync`, {
    script: `const v = document.querySelector('video');
      return {page: location.pathname, framed: window !== window.top, ready: v ? v.readyState : -1,
        paused: v ? v.paused : null, time: v ? v.currentTime : 0,
        error: window.__addSourceError || (v && v.error ? 'media error ' + v.error.code : null)};`,
    args: [],
  }).catch(() => null);
  const loaded = await waitFor(async () => {
    const seen = await look();
    return seen && (seen.ready >= 2 || seen.error) ? seen : null;
  }, 60_000);
  if (!loaded || loaded.error) {
    check(name, false, loaded ?? 'no video data after 60 s');
    return;
  }
  if (loaded.paused) {
    const started = await inPage('await window.fastStream.play();');
    if (started?.error) {
      check(name, false, `FastStream's play() failed: ${started.error}`);
      return;
    }
  }
  const played = await waitFor(async () => {
    const seen = await look();
    return seen && (seen.time >= 1.5 || seen.error) ? seen : null;
  }, 60_000);
  check(name, played !== null && played.page === '/player/index.html' && played.framed === framed &&
      played.time >= 1.5 && !played.error, played ?? 'its time stood still for 60 s');
}

async function run() {
  let installed = '';
  try {
    installed = await wd('POST', `${session}/moz/addon/install`, {
      addon: testZip.toString('base64'),
      temporary: true,
    });
  } catch (e) {
    installed = String(e);
  }
  check('the extension installs as a temporary add-on', installed === ExtensionId, installed);

  // The welcome page opens in a tab of its own once the background has started.
  const welcome = await waitFor(async () => {
    for (const handle of await wd('GET', `${session}/window/handles`)) {
      // A tab may close between the list and the look.
      const url = await wd('POST', `${session}/window`, {handle})
          .then(() => wd('GET', `${session}/url`), () => '').catch(() => '');
      if (url.startsWith('moz-extension://')) return url;
    }
    return null;
  }, 60_000);
  check('its welcome page opens (the background started)', welcome !== null, welcome ?? 'no moz-extension tab');
  const origin = welcome?.match(/^moz-extension:\/\/[^/]+/)?.[0];
  try {
    if (origin) await runInExtension(origin);
  } finally {
    // Also when no welcome page came: the console then names the file and line the background stopped at.
    const known = origin ?? await originFromProfile().catch(() => null);
    const errors = await scriptErrors(known ? known + '/' : 'moz-extension://')
        .catch((e) => [`the console was not read: ${e}`]);
    check('no script error from the extension at the end', errors.length === 0, errors.join(' | '));
  }
}

/**
 * The checks from the player page on, in the welcome page's tab.
 * @param {string} origin - The extension's moz-extension:// origin.
 */
async function runInExtension(origin) {
  // geckodriver navigates to no moz-extension:// address; the welcome tab, on that origin, may.
  await wd('POST', `${session}/execute/sync`, {script: 'location.assign(arguments[0]);', args: ['/player/index.html']});
  // The player builds its UI and sets its localised title on load: a near-empty body would mean its scripts never
  // ran (the floor is the desktop smoke test's, tests/e2e/ext-specs/extension.e2e.mjs); window.fastStream is the
  // player itself, there once it has started.
  const page = await waitFor(async () => {
    const seen = await wd('POST', `${session}/execute/sync`, {
      script: 'return {path: location.pathname, title: document.title, player: !!window.fastStream, ' +
        'nodes: document.body ? document.body.querySelectorAll("*").length : 0};',
      args: [],
    }).catch(() => null);
    return seen?.path === '/player/index.html' && seen.title.includes('FastStream') && seen.nodes > 20 &&
      seen.player ? seen : null;
  }, 120_000);
  check('the player page loads from the extension origin and its scripts run', page !== null, page ?? '');
  if (!page) return;

  // The welcome page opened also when the background stopped part-way (Firefox for Android 160 refused
  // tabs.onUpdated's filter, BackgroundUtils.onTabUpdated) and never heard its own pages.
  const pong = await inPage(`return await chrome.runtime.sendMessage({type: 'PING'});`);
  check('the background answers the player', pong?.value === 'PONG', pong);
  const errors = await scriptErrors(origin + '/').catch((e) => [`the console was not read: ${e}`]);
  check('no script error from the extension in the browser console', errors.length === 0, errors.join(' | '));

  // The call main.mjs makes for a player tab's #url (tests/e2e/extension-page.mjs addSourceInPlayer).
  const added = await inPage(`const [url] = args;
    const [{VideoSource}, {PlayerModes}, {URLUtils}] = await Promise.all([
      import('/player/VideoSource.mjs'),
      import('/player/enums/PlayerModes.mjs'),
      import('/player/utils/URLUtils.mjs'),
    ]);
    const mode = URLUtils.getModeFromExtension(URLUtils.get_url_extension(url)) || PlayerModes.DIRECT;
    window.fastStream.addSource(new VideoSource(url, {}, mode), true)
        .catch((e) => { window.__addSourceError = String(e); });
    window.fastStream.userInteracted();`, [MediaUrl]);
  check('the player takes the mp4 as its source', !added?.error, added);
  await checkPlays('it plays: the video time moves on');

  // Saved as the options page saves them: "Use player to play MP4 videos", for which the background adds a redirect
  // rule that hands a top-level .mp4 address to the player instead of Firefox's own viewer, and the test site in
  // "Auto-enable URLs", where FastStream then takes a page's own video.
  const saved = await inPage(`const {OptionsStore} = await import('/player/options/OptionsStore.mjs');
    const options = await OptionsStore.init();
    await OptionsStore.replace({...options, playMP4URLs: true, autoEnableURLs: [args[0]]});`, [new URL(PageUrl).origin + '/']);
  check('"Use player to play MP4 videos" and "Auto-enable URLs" are saved', !saved?.error, saved);
  const rule = await waitFor(async () => {
    const seen = await inPage(`const rules = await chrome.declarativeNetRequest.getDynamicRules();
      return rules.find((rule) => rule.id === ${Mp4RuleId}) ?? null;`).catch(() => null);
    return seen?.value ? seen.value : null;
  }, 20_000);
  check('the background adds its .mp4 redirect rule', rule !== null, rule ?? 'no rule after 20 s');

  const taken = await waitFor(async () => {
    await wd('POST', `${session}/url`, {url: MediaUrl});
    const url = await wd('GET', `${session}/url`);
    return url.startsWith(origin + '/player/index.html') ? url : null;
  }, 30_000);
  check('a direct .mp4 link opens in the player', taken !== null, taken ?? 'it stayed in the browser viewer');
  if (taken) await checkPlays('... and plays there');

  // A site's own video, as users meet one (the content script, the background's tabs.onUpdated and webRequest, the
  // player frame put in the video's place).
  await wd('POST', `${session}/url`, {url: PageUrl});
  const frame = await waitFor(async () => {
    const found = await wd('POST', `${session}/elements`, {using: 'css selector', value: 'iframe[src*="/player/index.html"]'});
    return found.length ? found[0] : null;
  }, 120_000);
  check('FastStream\'s player takes a page\'s own video', frame !== null, frame ? undefined : 'no player frame after 120 s');
  if (!frame) return;
  await wd('POST', `${session}/frame`, {id: frame});
  try {
    await checkPlays('... and plays it', true);
  } finally {
    await wd('POST', `${session}/frame`, {id: null}).catch(() => {});
  }
}
