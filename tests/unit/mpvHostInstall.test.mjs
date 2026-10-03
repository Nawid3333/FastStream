import {execFile, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

// install.ps1 wrote its files with -Encoding ASCII, which Windows PowerShell 5.1 turns into
// '?' for every other character: under a user folder like C:\Users\José, the config's mpv
// path, the manifest's path to the .bat and the .bat's path to the host all broke, and
// "Test mpv connection" failed with no hint why. Installed here into a scratch folder with
// such a name (-InstallDir, -NoRegister: the real installation and the registry are left
// alone), then the host is pinged through the .bat, the way Firefox starts it.

const root = path.resolve(import.meta.dirname, '../..');
// "José 中文", from code points: the file tools used to write this suite mangle escapes.
const FOLDER = 'Jos' + String.fromCodePoint(0xE9) + ' ' + String.fromCodePoint(0x4E2D, 0x6587);
// A host that never answers (a mutation test's endless read loop, a real hang) used to outlive
// the run: Stryker gives up on a mutant about a minute in, before this test's own timeout, and
// nothing stopped the host, which spun a core for good. A ping answers well within this.
const REPLY_TIMEOUT_MS = 15000;

let dir;
/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-install-'));
});

afterEach(() => {
  for (const child of children.splice(0)) stopTree(child);
  fs.rmSync(dir, {recursive: true, force: true});
});

/**
 * Stops a process ask() started, with everything it started, if it still runs.
 * @param {import('node:child_process').ChildProcess} child - The process.
 */
function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // cmd.exe runs node as its own child: kill() would stop cmd and leave the host running.
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
}

/**
 * Runs install.ps1 with the given arguments.
 * @param {string[]} args - Script arguments.
 * @param {string} [script] - The script; the repository's by default.
 * @return {Promise<string>} Its output, warnings included.
 */
function install(args, script = path.join(root, 'native-host', 'install.ps1')) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, ...args],
    {windowsHide: true}, (error, stdout, stderr) => {
      if (error) reject(new Error(`install.ps1 failed: ${error.message}\n${stdout}\n${stderr}`));
      else resolve(stdout + stderr);
    });
  });
}

/**
 * Sends one native message to the host through its .bat and reads the reply.
 * @param {string} bat - The wrapper install.ps1 wrote.
 * @param {Object} message - The message.
 * @return {Promise<Object>} The reply.
 */
function ask(bat, message) {
  return new Promise((resolve, reject) => {
    // As Firefox starts a .bat host: cmd /s /c strips the outer pair of quotes.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${bat}""`], {windowsVerbatimArguments: true, windowsHide: true});
    children.push(child);
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      stopTree(child);
      reject(new Error(`no reply from the host in ${REPLY_TIMEOUT_MS / 1000} s; stderr: ${stderr}`));
    }, REPLY_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (out.length < 4) {
        reject(new Error('no reply from the host; stderr: ' + stderr));
        return;
      }
      resolve(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8')));
    });
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    child.stdin.end(Buffer.concat([header, payload]));
  });
}

describe.runIf(process.platform === 'win32')('install.ps1 under a folder name that is not ASCII', () => {
  it('writes paths the host and Firefox can read, and the host answers through its .bat', async () => {
    const installDir = path.join(dir, FOLDER, 'FastStreamMpvHost');
    const mpvDir = path.join(dir, FOLDER, 'mpv');
    fs.mkdirSync(mpvDir, {recursive: true});
    const mpv = path.join(mpvDir, 'mpv.exe');
    fs.writeFileSync(mpv, '');

    await install(['-InstallDir', installDir, '-NoRegister', '-MpvPath', mpv, '-NodePath', process.execPath]);

    const config = JSON.parse(fs.readFileSync(path.join(installDir, 'config.json'), 'utf8'));
    expect(config.mpvPath).toBe(mpv);
    const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'com.faststream.mpv.json'), 'utf8'));
    expect(manifest.path).toBe(path.join(installDir, 'com.faststream.mpv.bat'));
    expect(manifest.allowed_extensions).toEqual(['thanatus@Nawid']);

    // The config's mpv path, read back by the host itself.
    const reply = await ask(manifest.path, {type: 'ping'});
    expect(reply).toEqual({ok: true, mpv: true, path: mpv});
  }, 60000);
});

describe.runIf(process.platform === 'win32')('install.ps1 run again', () => {
  // update-local.ps1 reinstalls the host on every update: it used to write config.json
  // anew with mpvPath alone, which dropped "debug": true and with it the host's log.
  it('keeps what else config.json holds and sets mpvPath', async () => {
    const installDir = path.join(dir, 'FastStreamMpvHost');
    fs.mkdirSync(installDir, {recursive: true});
    fs.writeFileSync(path.join(installDir, 'config.json'),
        JSON.stringify({mpvPath: 'C:\\old\\mpv.exe', debug: true}));
    const mpv = path.join(dir, 'mpv.exe');
    fs.writeFileSync(mpv, '');

    await install(['-InstallDir', installDir, '-NoRegister', '-MpvPath', mpv, '-NodePath', process.execPath]);

    const config = JSON.parse(fs.readFileSync(path.join(installDir, 'config.json'), 'utf8'));
    expect(config).toEqual({mpvPath: mpv, debug: true, ipcToken: expect.stringMatching(/^[0-9a-f]{32}$/)});
  }, 60000);

  // mpv-host-changed.yml's reminder says to run it without -MpvPath: the default came back
  // over an mpv elsewhere, and "Send to mpv" failed (#241).
  it('keeps the configured mpv path when run without -MpvPath', async () => {
    const installDir = path.join(dir, 'FastStreamMpvHost');
    fs.mkdirSync(installDir, {recursive: true});
    const mpv = path.join(dir, 'portable', 'mpv.exe');
    fs.mkdirSync(path.dirname(mpv));
    fs.writeFileSync(mpv, '');
    fs.writeFileSync(path.join(installDir, 'config.json'), JSON.stringify({mpvPath: mpv, debug: true}));

    await install(['-InstallDir', installDir, '-NoRegister', '-NodePath', process.execPath]);

    const config = JSON.parse(fs.readFileSync(path.join(installDir, 'config.json'), 'utf8'));
    expect(config).toMatchObject({mpvPath: mpv, debug: true});
  }, 60000);

  // The host names its pipe to mpv with it; pipe names are machine-wide (#156).
  it('gives the host a random pipe token once, and keeps it', async () => {
    const installDir = path.join(dir, 'FastStreamMpvHost');
    const mpv = path.join(dir, 'mpv.exe');
    fs.writeFileSync(mpv, '');
    const args = ['-InstallDir', installDir, '-NoRegister', '-MpvPath', mpv, '-NodePath', process.execPath];

    await install(args);
    const first = JSON.parse(fs.readFileSync(path.join(installDir, 'config.json'), 'utf8')).ipcToken;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    await install(args);
    expect(JSON.parse(fs.readFileSync(path.join(installDir, 'config.json'), 'utf8')).ipcToken).toBe(first);

    // Another install gets its own; one the host would not take (upper case) is replaced.
    const other = path.join(dir, 'Other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'config.json'), JSON.stringify({ipcToken: 'ABCDEF0123456789ABCDEF0123456789'}));
    await install(['-InstallDir', other, '-NoRegister', '-MpvPath', mpv, '-NodePath', process.execPath]);
    const otherToken = JSON.parse(fs.readFileSync(path.join(other, 'config.json'), 'utf8')).ipcToken;
    expect(otherToken).toMatch(/^[0-9a-f]{32}$/);
    expect(otherToken).not.toBe(first);
  }, 90000);

  it('writes a new config.json over one it cannot read', async () => {
    const installDir = path.join(dir, 'FastStreamMpvHost');
    fs.mkdirSync(installDir, {recursive: true});
    fs.writeFileSync(path.join(installDir, 'config.json'), '{not json');
    const mpv = path.join(dir, 'mpv.exe');
    fs.writeFileSync(mpv, '');

    await install(['-InstallDir', installDir, '-NoRegister', '-MpvPath', mpv, '-NodePath', process.execPath]);

    const config = JSON.parse(fs.readFileSync(path.join(installDir, 'config.json'), 'utf8'));
    expect(config).toEqual({mpvPath: mpv, ipcToken: expect.stringMatching(/^[0-9a-f]{32}$/)});
  }, 60000);
});

describe.runIf(process.platform === 'win32')('install.ps1 under unusual folder names (#242)', () => {
  // cmd reads %...% in a batch file as a variable, even inside quotes, and drops a lone %:
  // under a user name with a % in it, the wrapper ran node on a path that does not exist.
  it('writes a wrapper that works under a folder with a % in its name', async () => {
    const installDir = path.join(dir, 'Rabatt 100%', 'FastStreamMpvHost');
    const mpv = path.join(dir, 'mpv.exe');
    fs.writeFileSync(mpv, '');

    await install(['-InstallDir', installDir, '-NoRegister', '-MpvPath', mpv, '-NodePath', process.execPath]);

    const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'com.faststream.mpv.json'), 'utf8'));
    expect(await ask(manifest.path, {type: 'ping'})).toEqual({ok: true, mpv: true, path: mpv});
  }, 60000);

  // With -Path, PowerShell reads [ ] as a wildcard: the host script was "not found" in a
  // checkout under such a folder, and an mpv there was reported missing.
  it('finds its files and mpv under folders with [ ] in their names', async () => {
    const source = path.join(dir, 'repo [copy]', 'native-host');
    fs.mkdirSync(source, {recursive: true});
    for (const file of ['install.ps1', 'faststream-mpv-host.mjs']) {
      fs.copyFileSync(path.join(root, 'native-host', file), path.join(source, file));
    }
    const installDir = path.join(dir, 'host [1]', 'FastStreamMpvHost');
    const mpv = path.join(dir, 'mpv [portable]', 'mpv.exe');
    fs.mkdirSync(path.dirname(mpv));
    fs.writeFileSync(mpv, '');

    const output = await install(['-InstallDir', installDir, '-NoRegister', '-MpvPath', mpv, '-NodePath', process.execPath],
        path.join(source, 'install.ps1'));

    expect(output).not.toContain('mpv not found');
    expect(fs.existsSync(path.join(installDir, 'faststream-mpv-host.mjs'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'com.faststream.mpv.json'), 'utf8'));
    expect(await ask(manifest.path, {type: 'ping'})).toEqual({ok: true, mpv: true, path: mpv});
  }, 60000);
});
