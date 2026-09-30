import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {findMpvOnPath, resolveMpvPath} from '../../native-host/faststream-mpv-host.mjs';

// The native host used to hand a bare `mpv` on without looking: "Test mpv connection"
// reported mpv on a machine that had none, and on Windows the WMI launch searches its own
// PATH, not the user's, so a per-user mpv was not found there either. The host now looks
// mpv up on the user's PATH and passes on an absolute path, or reports it missing.

let root;

/**
 * Makes a directory under the test's temp root holding the named files.
 * @param {string} name - Directory name.
 * @param {string[]} files - Files to create in it.
 * @param {number} [mode] - File mode.
 * @return {string} The directory.
 */
function dirWith(name, files, mode = 0o755) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, {recursive: true});
  for (const file of files) {
    fs.writeFileSync(path.join(dir, file), '');
    fs.chmodSync(path.join(dir, file), mode);
  }
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-mpv-path-'));
});

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
});

describe('findMpvOnPath on Windows', () => {
  it('finds mpv.exe in the first PATH directory that has it', () => {
    const empty = dirWith('empty', []);
    const first = dirWith('first', ['mpv.exe']);
    const second = dirWith('second', ['mpv.exe']);
    expect(findMpvOnPath({Path: [empty, first, second].join(';')}, 'win32')).toBe(path.join(first, 'mpv.exe'));
  });

  it('reads a quoted PATH entry, and PATH in any spelling', () => {
    const dir = dirWith('quoted', ['mpv.exe']);
    expect(findMpvOnPath({PATH: `"${dir}"`}, 'win32')).toBe(path.join(dir, 'mpv.exe'));
  });

  it('passes over mpv.com, the console wrapper', () => {
    const wrapperOnly = dirWith('wrapper', ['mpv.com']);
    const real = dirWith('real', ['mpv.exe']);
    expect(findMpvOnPath({Path: wrapperOnly}, 'win32')).toBeNull();
    expect(findMpvOnPath({Path: `${wrapperOnly};${real}`}, 'win32')).toBe(path.join(real, 'mpv.exe'));
  });

  it('reports mpv missing when no PATH directory has it', () => {
    expect(findMpvOnPath({Path: dirWith('none', ['notmpv.exe'])}, 'win32')).toBeNull();
    expect(findMpvOnPath({}, 'win32')).toBeNull();
  });
});

// A ':'-separated PATH of real directories only exists off Windows, where a drive letter
// holds a ':' of its own; CI's Linux job runs these.
describe.skipIf(process.platform === 'win32')('findMpvOnPath elsewhere', () => {
  it('finds an executable mpv', () => {
    const dir = dirWith('bin', ['mpv']);
    expect(findMpvOnPath({PATH: `/nonexistent:${dir}`}, 'linux')).toBe(path.join(dir, 'mpv'));
  });

  it('passes over an mpv that is not executable', () => {
    expect(findMpvOnPath({PATH: dirWith('noexec', ['mpv'], 0o644)}, 'linux')).toBeNull();
  });
});

describe('resolveMpvPath with a bare name', () => {
  let savedPath;
  let key;

  beforeEach(() => {
    key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') || 'PATH';
    savedPath = process.env[key];
  });

  afterEach(() => {
    process.env[key] = savedPath;
  });

  it('hands on the absolute path it found on the PATH', () => {
    const dir = dirWith('user-bin', [process.platform === 'win32' ? 'mpv.exe' : 'mpv']);
    process.env[key] = dir;
    expect(resolveMpvPath('mpv')).toBe(path.join(dir, process.platform === 'win32' ? 'mpv.exe' : 'mpv'));
  });
});

// The mpv path comes from the options page, and the host starts whatever it names. A page
// could frame the options page (it was web-accessible) and get a click on a changed
// path; an imported settings file can carry one too. So the host starts only a file
// named like mpv, or mpv.exe in a named folder, and never looks at a UNC or device path:
// Windows signs in to a UNC host with the user's credentials on a mere stat.
describe('resolveMpvPath with a path from the options page', () => {
  it('starts a file named like mpv', () => {
    const name = process.platform === 'win32' ? 'mpv-x86_64.exe' : 'mpv-git';
    const file = path.join(dirWith('builds', [name]), name);
    expect(resolveMpvPath(file)).toBe(file);
  });

  it('never starts a program with another name', () => {
    const name = process.platform === 'win32' ? 'cmd.exe' : 'sh';
    const file = path.join(dirWith('other', [name]), name);
    expect(resolveMpvPath(file)).not.toBe(file);
  });

  it.each([
    ['a UNC path', String.raw`\\attacker.test\share\mpv.exe`],
    ['a forward-slash UNC path', '//attacker.test/share/mpv.exe'],
    ['a device path', String.raw`\\?\C:\mpv\mpv.exe`],
  ])('does not even look at %s', (what, candidate) => {
    const stat = vi.spyOn(fs, 'statSync');
    try {
      expect(resolveMpvPath(candidate)).not.toBe(candidate);
      expect(stat.mock.calls.map((call) => call[0])).not.toContain(candidate);
    } finally {
      stat.mockRestore();
    }
  });
});
