import {execFile, spawn} from 'node:child_process';
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

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-install-'));
});

afterEach(() => {
  fs.rmSync(dir, {recursive: true, force: true});
});

/**
 * Runs install.ps1 with the given arguments.
 * @param {string[]} args - Script arguments.
 * @return {Promise<string>} Its output.
 */
function install(args) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(root, 'native-host', 'install.ps1'), ...args],
    {windowsHide: true}, (error, stdout, stderr) => {
      if (error) reject(new Error(`install.ps1 failed: ${error.message}\n${stdout}\n${stderr}`));
      else resolve(stdout);
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
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', () => {
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
