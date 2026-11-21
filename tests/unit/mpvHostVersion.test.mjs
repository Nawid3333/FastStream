import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';
import {spawn} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {MpvBackend, RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {EnvUtils} from '../../chrome/player/utils/EnvUtils.mjs';
import {Capabilities, HostVersion, withHostVersion} from '../../native-host/faststream-mpv-host.mjs';

// The host is not part of the extension (install.ps1's copy stays through updates): it reports its
// version, and the extension sends an older one nothing but a ping, and says what to run.
//
// That only works while the version moves with the host, so this file is the ratchet: a
// change to the host or its installer fails it until HostVersion and RECORDED agree.
// RequiredHostVersion follows only when the extension needs what the new host does.

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const hostFile = path.join(root, 'native-host/faststream-mpv-host.mjs');
const installerFile = path.join(root, 'native-host/install.ps1');

// The host as it was when its version was last raised: the SHA-256 of the host and of its
// installer, line ends as LF. The installer counts because what it writes (the wrapper, the
// manifest, config.json) is part of the host a PC has, and update-local.ps1 tells an
// installed host from the repository's by the host file alone: raising HostVersion changes
// that file, so a change to install.ps1 reaches the PC the same way. After a change to
// either: raise HostVersion in the host by one, and RequiredHostVersion in
// chrome/background/MpvBackend.mjs with it when the extension needs the new host; then put
// the new values here (a failure prints the hashes).
const RECORDED = {
  version: 32,
  host: '75e41ed8ac4c905f71f094f84bf15f1e68e5726f5de6c976c85ad0842a1bd808',
  installer: 'db3b8027b508556b8af66eb4b8188460c2a5a6e1feb32d32b490f2e234b29b3a',
};

/**
 * A file's SHA-256, its line ends read as LF (a Windows checkout may have CRLF).
 * @param {string} file - The file.
 * @return {string} The hash, in hex.
 */
function sha256Of(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('the mpv host\'s version', () => {
  it('is raised with every change to the host or its installer', () => {
    const next = HostVersion === RECORDED.version ? HostVersion + 1 : HostVersion;
    expect({version: HostVersion, host: sha256Of(hostFile), installer: sha256Of(installerFile)},
        'native-host/faststream-mpv-host.mjs or install.ps1 changed. A PC keeps running its ' +
        'installed copy, so the version has to move: set HostVersion in the host to ' +
        `${next} (and RequiredHostVersion in chrome/background/MpvBackend.mjs too if the extension needs it), then run this test ` +
        'again and record the version and the hashes it prints in RECORDED').toEqual(RECORDED);
  });

  it('is at least the one the extension asks for', () => {
    // Higher than the host and a release would call its own host outdated; lower is a host change
    // the extension does not need.
    expect(RequiredHostVersion).toBeLessThanOrEqual(HostVersion);
    expect(Number.isInteger(HostVersion) && HostVersion >= 1).toBe(true);
  });

  it('goes out with every answer', () => {
    // With the messages it understands, which an extension from before host 32 looks for.
    expect(withHostVersion({ok: true, mpv: false}))
        .toEqual({ok: true, mpv: false, hostVersion: HostVersion, capabilities: ['play', 'ipc', 'relay', 'hls', 'windows']});
    expect(withHostVersion({ok: false, error: 'unknown message'}))
        .toEqual({ok: false, error: 'unknown message', hostVersion: HostVersion, capabilities: [...Capabilities]});
  });

  /**
   * Runs the host as Firefox does: one framed message in, one framed answer out.
   * @param {Object} message - The message.
   * @return {Promise<Object>} The host's answer.
   */
  function askHost(message, file = hostFile) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [file], {stdio: ['pipe', 'pipe', 'inherit']});
      // A host that never answers (a mutant's endless read loop) must not outlive the test.
      const timer = setTimeout(() => child.kill(), 15000);
      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const out = Buffer.concat(chunks);
          resolve(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
      const payload = Buffer.from(JSON.stringify(message), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length, 0);
      child.stdin.end(Buffer.concat([header, payload]));
    });
  }

  it('is in the running host\'s answer to a ping, and to a message it does not know', async () => {
    expect((await askHost({type: 'ping'})).hostVersion).toBe(HostVersion);
    expect(await askHost({type: 'nonsense'}))
        .toEqual({ok: false, error: 'unknown message', hostVersion: HostVersion, capabilities: [...Capabilities]});
  }, 30000);

  // The window reaches the pipe's name: anything but one of the helper's ids is refused before a pipe is asked.
  it('refuses a window that is not one of the helper\'s ids in ipc, relay, raise and play, and finds a gone one closed',
      async () => {
        const bad = '../faststream-mpv';
        const refused = {error: 'the window is not one of the helper\'s', hostVersion: HostVersion};
        expect(await askHost({type: 'ipc', window: bad, commands: [['get_property', 'pid']]}))
            .toMatchObject({ok: false, error: 'refused', reason: refused.error});
        expect(await askHost({type: 'relay', window: bad})).toMatchObject({type: 'closed', reason: 'refused', ...refused});
        expect(await askHost({type: 'raise', window: bad})).toMatchObject({ok: false, ...refused});
        expect(await askHost({type: 'play', target: 'https://cdn.test/v.m3u8', window: bad})).toMatchObject({ok: false, ...refused});
        // An id no mpv has (randomly drawn): the window is gone, and nothing on the helper's own pipe is asked.
        const gone = crypto.randomBytes(8).toString('hex');
        expect(await askHost({type: 'raise', window: gone})).toMatchObject({ok: false, closed: true});
        expect(await askHost({type: 'ipc', window: gone, commands: [['get_property', 'pid']]}))
            .toMatchObject({ok: false, error: 'no mpv ipc'});
      }, 60000);

  // Node names the program by its real path: started through a link to its folder (a Linux
  // install linking the host somewhere of its own), the host took itself for an imported
  // module and ended without an answer. A junction on Windows, which
  // needs no rights there; a symlink elsewhere.
  it('answers when started through a link', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-host-link-'));
    const link = path.join(dir, 'host');
    try {
      fs.symlinkSync(path.dirname(hostFile), link, 'junction');
      expect((await askHost({type: 'ping'}, path.join(link, path.basename(hostFile)))).hostVersion).toBe(HostVersion);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }, 30000);
});

describe('an outdated mpv host', () => {
  afterEach(() => {
    delete globalThis.chrome;
    EnvUtils.knownOs = null;
  });

  /**
   * A stand-in for the browser whose native host answers each message.
   * @param {function(Object): *} answer - The host's answer to a message.
   * @param {function(): (Object|undefined)} [lastError] - chrome.runtime.lastError for it.
   * @return {Array<Object>} Every message sent.
   */
  function stubHost(answer, lastError = () => undefined) {
    const sent = [];
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendNativeMessage(name, message, callback) {
          sent.push(message);
          globalThis.chrome.runtime.lastError = lastError();
          callback(answer(message));
          globalThis.chrome.runtime.lastError = undefined;
        },
      },
    };
    return sent;
  }

  const Outdated = 'The mpv helper on this computer is out of date: run "Update mpv" from the Start menu ' +
    '(in a FastStream checkout: update-local.cmd or native-host\\install.ps1).';

  it('is one that answers with a lower version, or with none', () => {
    expect(MpvBackend.isHostOutdated({ok: true, hostVersion: RequiredHostVersion})).toBe(false);
    expect(MpvBackend.isHostOutdated({ok: true, hostVersion: RequiredHostVersion + 1})).toBe(false);
    expect(MpvBackend.isHostOutdated({ok: true, hostVersion: RequiredHostVersion - 1})).toBe(true);
    // A host from before it sent a version, and answers that are not a version.
    expect(MpvBackend.isHostOutdated({ok: true})).toBe(true);
    expect(MpvBackend.isHostOutdated({ok: true, hostVersion: String(RequiredHostVersion)})).toBe(true);
    expect(MpvBackend.isHostOutdated({ok: true, hostVersion: RequiredHostVersion + 0.5})).toBe(true);
    expect(MpvBackend.isHostOutdated({ok: true, hostVersion: NaN})).toBe(true);
    expect(MpvBackend.isHostOutdated(undefined)).toBe(true);
    expect(MpvBackend.isHostOutdated(null)).toBe(true);
    expect(MpvBackend.isHostOutdated('ok')).toBe(true);
  });

  it('gets no stream, only a ping, and the send says what to run', async () => {
    EnvUtils.knownOs = 'win';
    const sent = stubHost(() => ({ok: true, mpv: true, path: 'C:/mpv/mpv.exe', hostVersion: RequiredHostVersion - 1}));
    const tab = {mpvSentUrls: new Set()};
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8', tab, [], 'anime', 'https://site.test/ep-1', 'Episode'))
        .toEqual({ok: false, hostOutdated: true, error: Outdated});
    expect(sent).toEqual([{type: 'ping'}]);
    // Not recorded as sent: once the helper is updated, the same stream goes.
    expect(tab.mpvSentUrls.size).toBe(0);
  });

  it('gets no stream when it answers "unknown message", nor the open message an older extension sent', async () => {
    EnvUtils.knownOs = 'win';
    for (const unknown of [{ok: false, error: 'unknown message'}, {ok: false, error: 'unknown message', hostVersion: 14}]) {
      const sent = stubHost(() => unknown);
      const backend = new MpvBackend();
      expect(await backend.openStream('https://cdn/a.m3u8')).toEqual({ok: false, hostOutdated: true, error: Outdated});
      expect(await backend.openStream('https://cdn/b.m3u8', undefined, [], '', 'https://site.test/watch', 'Episode',
          {private: true})).toEqual({ok: false, hostOutdated: true, error: Outdated});
      expect(sent.map((message) => message.type)).toEqual(['ping', 'ping']);
    }
  });

  it('says what to run in the options page\'s words, in the user\'s language and for the system', async () => {
    const asked = [];
    stubHost(() => ({ok: true, hostVersion: RequiredHostVersion - 1}));
    globalThis.chrome.i18n = {getMessage: (key) => {
      asked.push(key);
      return key === 'options_mpv_test_outdated_unix' ? 'veraltet' : '';
    }};
    EnvUtils.knownOs = 'linux';
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toEqual({ok: false, hostOutdated: true, error: 'veraltet'});
    // A locale without the key: the English words.
    EnvUtils.knownOs = 'win';
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toEqual({ok: false, hostOutdated: true, error: Outdated});
    expect(asked).toEqual(['options_mpv_test_outdated_unix', 'options_mpv_test_outdated']);
  });

  it('is asked again at the next send, and an update meanwhile is noticed', async () => {
    let version = RequiredHostVersion - 1;
    const sent = stubHost(() => ({ok: true, hostVersion: version}));
    const backend = new MpvBackend();
    expect((await backend.openStream('https://cdn/a.m3u8')).hostOutdated).toBe(true);
    version = RequiredHostVersion;
    expect(await backend.openStream('https://cdn/a.m3u8')).toEqual({ok: true});
    expect(sent.map((message) => message.type)).toEqual(['ping', 'ping', 'play']);
  });

  it('is not what a current host is called, which is pinged once and then sent streams straight', async () => {
    const sent = stubHost(() => ({ok: true, hostVersion: RequiredHostVersion}));
    const backend = new MpvBackend();
    expect(await backend.openStream('https://cdn/a.m3u8')).toEqual({ok: true});
    expect(await backend.openStream('https://cdn/b.m3u8')).toEqual({ok: true});
    expect(sent.map((message) => message.type)).toEqual(['ping', 'play', 'play']);
    stubHost(() => ({ok: true, mpv: true, path: 'C:/mpv/mpv.exe', hostVersion: RequiredHostVersion}));
    expect(await new MpvBackend().testConnection()).toEqual({ok: true, mpv: true, path: 'C:/mpv/mpv.exe'});
  });

  it('put back after a current one answered gets the update message for its answer', async () => {
    EnvUtils.knownOs = 'win';
    let answer = {ok: true, hostVersion: RequiredHostVersion};
    const sent = stubHost(() => answer);
    const backend = new MpvBackend();
    expect(await backend.openStream('https://cdn/a.m3u8')).toEqual({ok: true});
    answer = {ok: false, error: 'unknown message'};
    expect(await backend.openStream('https://cdn/b.m3u8')).toEqual({ok: false, hostOutdated: true, error: Outdated});
    expect(sent.map((message) => message.type)).toEqual(['ping', 'play', 'play']);
  });

  it('shows in "Test mpv connection", which asks it nothing about mpv\'s decoder', async () => {
    const sent = stubHost(() => ({ok: true, mpv: true, path: 'C:/mpv/mpv.exe'}));
    const backend = new MpvBackend();
    expect(await backend.testConnection())
        .toEqual({ok: true, mpv: true, path: 'C:/mpv/mpv.exe', hostOutdated: true});
    expect(await backend.decoderStatus(0)).toMatchObject({ok: false, hostOutdated: true});
    expect(sent.map((message) => message.type)).toEqual(['ping']);
  });

  it('is not what a host that could not be reached is called', async () => {
    stubHost(() => undefined, () => ({message: 'no such native application'}));
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toEqual({ok: false, error: 'no such native application', noHost: true});
    expect(await new MpvBackend().testConnection()).toEqual({ok: false, error: 'no such native application'});
  });
});
