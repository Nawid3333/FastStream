import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';
import {spawn} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {MpvBackend, RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {HostVersion, withHostVersion} from '../../native-host/faststream-mpv-host.mjs';

// The mpv host is not part of the extension: a PC runs the copy install.ps1 made in
// %LOCALAPPDATA%\FastStreamMpvHost, and neither an extension update nor a `git pull`
// changes that copy. Until 2026-10-04 a workflow (mpv-host-changed.yml) emailed the owner
// to run install.ps1 again after a push that changed the host. Now the host says which
// version it is with every answer, and the extension says so where MPV mode is used when
// that is older than the host it was released with.
//
// That only works while the version moves with the host, so this file is the ratchet: a
// change to the host fails it until HostVersion, RequiredHostVersion and RECORDED agree.

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const hostFile = path.join(root, 'native-host/faststream-mpv-host.mjs');

// The host as it was when its version was last raised: the SHA-256 of the file, line ends
// as LF. After a change to the host: raise HostVersion there and RequiredHostVersion in
// chrome/background/MpvBackend.mjs by one, then put both new values here (a failure
// prints the hash).
const RECORDED = {
  version: 1,
  sha256: '7bf5f2db4bc8063948926b88210b8c752928c0923919ea4ba8bf1a2f26a9b18d',
};

// Stryker runs this suite on a copy of the host with every mutant written into it
// (.stryker-tmp/sandbox-*), which is never the recorded file.
const inMutationSandbox = root.split(path.sep).includes('.stryker-tmp');

describe('the mpv host\'s version', () => {
  it.skipIf(inMutationSandbox)('is raised with every change to the host', () => {
    const text = fs.readFileSync(hostFile, 'utf8').replace(/\r\n/g, '\n');
    const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const next = HostVersion === RECORDED.version ? HostVersion + 1 : HostVersion;
    expect({version: HostVersion, sha256},
        'native-host/faststream-mpv-host.mjs changed. A PC keeps running its installed copy, ' +
        'so the version has to move: set HostVersion there and RequiredHostVersion in ' +
        `chrome/background/MpvBackend.mjs to ${next}, then run this test again and record ` +
        'the version and the hash it prints in RECORDED').toEqual(RECORDED);
  });

  it('is the one the extension asks for', () => {
    // Lower, and an extension release would call the host it ships beside outdated;
    // higher, and a changed host would never be asked for.
    expect(RequiredHostVersion).toBe(HostVersion);
    expect(Number.isInteger(HostVersion) && HostVersion >= 1).toBe(true);
  });

  it('goes out with every answer', () => {
    expect(withHostVersion({ok: true, mpv: false})).toEqual({ok: true, mpv: false, hostVersion: HostVersion});
    expect(withHostVersion({ok: false, error: 'unknown message'}))
        .toEqual({ok: false, error: 'unknown message', hostVersion: HostVersion});
  });

  /**
   * Runs the host as Firefox does: one framed message in, one framed answer out.
   * @param {Object} message - The message.
   * @return {Promise<Object>} The host's answer.
   */
  function askHost(message) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hostFile], {stdio: ['pipe', 'pipe', 'inherit']});
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
    expect(await askHost({type: 'nonsense'})).toEqual({ok: false, error: 'unknown message', hostVersion: HostVersion});
  }, 30000);
});

describe('an outdated mpv host', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  /**
   * A stand-in for the browser whose native host gives one answer.
   * @param {function(): *} answer - The host's answer to the next message.
   * @param {function(): (Object|undefined)} [lastError] - chrome.runtime.lastError for it.
   */
  function stubHost(answer, lastError = () => undefined) {
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendNativeMessage(name, message, callback) {
          globalThis.chrome.runtime.lastError = lastError();
          callback(answer());
          globalThis.chrome.runtime.lastError = undefined;
        },
      },
    };
  }

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

  it('still gets the stream, and the result says the host is outdated', async () => {
    stubHost(() => ({ok: true}));
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toEqual({ok: true, hostOutdated: true});
  });

  it('is named beside its own reason for a failure', async () => {
    stubHost(() => ({ok: false, error: 'mpv executable not found', hostVersion: RequiredHostVersion - 1}));
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toEqual({ok: false, error: 'mpv executable not found', hostOutdated: true});
  });

  it('is not what a current host is called', async () => {
    stubHost(() => ({ok: true, hostVersion: RequiredHostVersion}));
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toEqual({ok: true});
    stubHost(() => ({ok: true, mpv: true, path: 'C:/mpv/mpv.exe', hostVersion: RequiredHostVersion}));
    expect(await new MpvBackend().testConnection()).toEqual({ok: true, mpv: true, path: 'C:/mpv/mpv.exe'});
  });

  it('shows in "Test mpv connection"', async () => {
    stubHost(() => ({ok: true, mpv: true, path: 'C:/mpv/mpv.exe'}));
    expect(await new MpvBackend().testConnection())
        .toEqual({ok: true, mpv: true, path: 'C:/mpv/mpv.exe', hostOutdated: true});
  });

  it('is remembered for a stream already sent, which asks the host nothing', async () => {
    let answers = 0;
    stubHost(() => {
      answers++;
      return {ok: true};
    });
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};
    await backend.openStream('https://cdn/a.m3u8', tab);
    expect(await backend.openStream('https://cdn/a.m3u8', tab)).toEqual({ok: true, hostOutdated: true});
    expect(answers).toBe(1);
  });

  it('is forgotten once the host answers as a current one', async () => {
    let answer = {ok: true};
    stubHost(() => answer);
    const backend = new MpvBackend();
    expect((await backend.openStream('https://cdn/a.m3u8')).hostOutdated).toBe(true);
    answer = {ok: true, hostVersion: RequiredHostVersion};
    expect(await backend.openStream('https://cdn/b.m3u8')).toEqual({ok: true});
  });

  it('is not what a host that could not be reached is called', async () => {
    stubHost(() => undefined, () => ({message: 'no such native application'}));
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toEqual({ok: false, error: 'no such native application', noHost: true});
    expect(await new MpvBackend().testConnection()).toEqual({ok: false, error: 'no such native application'});
  });
});
