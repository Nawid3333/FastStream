import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {findMpvOnPath, isMpvExecutableName, preferGuiBuild, resolveMpvPath} from '../../native-host/faststream-mpv-host.mjs';

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

  // Windows runs a .bat or .cmd through cmd.exe, which reads mpv's arguments again: a
  // header value or a title with & or %VAR% in it would be a command (#160).
  it('takes only a .exe or .com on Windows, any mpv name elsewhere', () => {
    for (const name of ['mpv.exe', 'MPV.EXE', 'mpv.com', 'mpv-x86_64.exe']) {
      expect(isMpvExecutableName(name, 'win32')).toBe(true);
    }
    for (const name of ['mpv.bat', 'mpv.cmd', 'mpv.ps1', 'mpv.vbs', 'mpv', 'mpv.exe.bat', 'cmd.exe']) {
      expect(isMpvExecutableName(name, 'win32')).toBe(false);
    }
    expect(isMpvExecutableName('mpv', 'linux')).toBe(true);
    expect(isMpvExecutableName('mpv-git', 'linux')).toBe(true);
    expect(isMpvExecutableName('sh', 'linux')).toBe(false);
  });

  // mpv.com is the console wrapper: it starts the mpv.exe beside it as its child, so WMI
  // reported the wrapper's process, which has no window, the focus helper found none, and
  // mpv's window stayed behind the browser (2026-10-04).
  it('starts the GUI build beside a console wrapper on Windows', () => {
    const both = dirWith('both', ['mpv.com', 'mpv.exe', 'mpv-x86_64.com', 'mpv-x86_64.exe']);
    expect(resolveMpvPath(path.join(both, 'mpv.com'), 'win32')).toBe(path.join(both, 'mpv.exe'));
    expect(resolveMpvPath(path.join(both, 'mpv-x86_64.com'), 'win32')).toBe(path.join(both, 'mpv-x86_64.exe'));
    expect(preferGuiBuild(path.join(both, 'mpv.exe'))).toBe(path.join(both, 'mpv.exe'));
  });

  it('starts the wrapper when it is all there is, and leaves names alone elsewhere', () => {
    const wrapper = dirWith('wrapper-only', ['mpv.com']);
    expect(resolveMpvPath(path.join(wrapper, 'mpv.com'), 'win32')).toBe(path.join(wrapper, 'mpv.com'));
    const both = dirWith('both-linux', ['mpv.com', 'mpv.exe']);
    expect(resolveMpvPath(path.join(both, 'mpv.com'), 'linux')).toBe(path.join(both, 'mpv.com'));
  });

  it.runIf(process.platform === 'win32')('never starts an mpv.bat or mpv.cmd', () => {
    const dir = dirWith('scripts', ['mpv.bat', 'mpv.cmd']);
    expect(resolveMpvPath(path.join(dir, 'mpv.bat'))).not.toBe(path.join(dir, 'mpv.bat'));
    expect(resolveMpvPath(path.join(dir, 'mpv.cmd'))).not.toBe(path.join(dir, 'mpv.cmd'));
  });

  // WMI starts the command line in its own working directory, where a relative path
  // names nothing (#160).
  it('hands on an absolute path for a relative one', () => {
    const name = process.platform === 'win32' ? 'mpv-rel.exe' : 'mpv-rel';
    // Under the working directory, so the relative path exists (the temp folder can be
    // on another drive).
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.fs-mpv-rel-'));
    try {
      fs.writeFileSync(path.join(dir, name), '');
      fs.chmodSync(path.join(dir, name), 0o755);
      const relative = path.relative(process.cwd(), path.join(dir, name));
      expect(path.isAbsolute(relative)).toBe(false);
      expect(resolveMpvPath(relative)).toBe(path.join(dir, name));
      // mpv on a relative PATH entry, and (Windows) a relative folder holding mpv.exe.
      const onPath = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
      fs.writeFileSync(path.join(dir, onPath), '');
      fs.chmodSync(path.join(dir, onPath), 0o755);
      const relativeDir = path.relative(process.cwd(), dir);
      expect(findMpvOnPath({PATH: relativeDir}, process.platform)).toBe(path.join(dir, onPath));
      if (process.platform === 'win32') {
        expect(resolveMpvPath(relativeDir)).toBe(path.join(dir, 'mpv.exe'));
      }
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
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
