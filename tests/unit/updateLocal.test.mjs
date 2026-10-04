import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {isPinnedUrl, newestNode, newestPackage, newestWsl} from '../../tools/newest-release.mjs';

// tools/update-local.ps1 brings this PC to the versions CI's rule allows: the newest release
// at least 5 days old (tools/check-toolchain.mjs). tools/newest-release.mjs picks them.
const now = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = (n) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

describe('newestNode', () => {
  // nodejs.org/dist/index.json: newest first, the date without a time.
  const index = [
    {version: 'v27.0.0', date: daysAgo(10).slice(0, 10)},
    {version: 'v26.10.0', date: daysAgo(2).slice(0, 10)},
    {version: 'v26.9.0', date: daysAgo(9).slice(0, 10)},
    {version: 'v24.21.0', date: daysAgo(20).slice(0, 10)},
  ];

  it('takes the newest release of the major that is 5 days old', () => {
    expect(newestNode(index, 26, now)).toBe('26.9.0');
  });

  it('stays on the major asked for', () => {
    expect(newestNode(index, 24, now)).toBe('24.21.0');
  });

  it('gives nothing when no release of that major is old enough', () => {
    expect(newestNode([{version: 'v28.0.0', date: daysAgo(1).slice(0, 10)}], 28, now)).toBe(null);
  });

  // update-local.ps1 builds a URL and a file name from it (#243): an index that names
  // anything else is skipped, as if that release did not exist.
  it('skips a version of any other shape', () => {
    const odd = [
      {version: 'v26.11.0&calc', date: daysAgo(9).slice(0, 10)},
      {version: 'v26.11.0/../../x', date: daysAgo(9).slice(0, 10)},
      {version: 'v26.10.1-rc.1', date: daysAgo(9).slice(0, 10)},
      ...index,
    ];
    expect(newestNode(odd, 26, now)).toBe('26.9.0');
  });
});

describe('isPinnedUrl', () => {
  // getJson's guard (#167: a precedence slip made it pass every URL).
  it.each([
    ['https://nodejs.org/dist/index.json', true],
    ['https://registry.npmjs.org/pnpm', true],
    ['https://registry.npmjs.org/%40types%2Fnode', true],
    ['https://evil.example/', false],
    ['https://evil.example/https://registry.npmjs.org/', false],
    ['https://registry.npmjs.org.evil.example/pnpm', false],
    ['http://registry.npmjs.org/pnpm', false],
    ['https://nodejs.org/dist/index.json.evil', false],
    ['https://nodejs.org/dist/v26.10.0/', false],
    ['https://api.github.com/repos/microsoft/WSL/releases/latest', true],
    ['https://api.github.com/repos/microsoft/WSL/releases', false],
    ['https://api.github.com/repos/evil/WSL/releases/latest', false],
    ['https://api.github.com/repos/microsoft/WSL/releases/latest?per_page=1', false],
  ])('%s -> %s', (url, allowed) => {
    expect(isPinnedUrl(new URL(url))).toBe(allowed);
  });
});

describe('newestPackage', () => {
  const doc = {
    'dist-tags': {latest: '12.0.0'},
    'versions': {'11.9.0': {}, '11.9.1': {deprecated: 'broken'}, '11.10.0-beta.1': {}, '12.0.0': {}},
    'time': {'11.9.0': daysAgo(30), '11.9.1': daysAgo(20), '11.10.0-beta.1': daysAgo(10), '12.0.0': daysAgo(1)},
  };

  it('falls back to the major before while the latest has nothing old enough', () => {
    expect(newestPackage(doc, now)).toBe('11.9.0');
  });

  it('takes the latest major once its release is old enough', () => {
    expect(newestPackage(doc, now + 5 * 24 * 60 * 60 * 1000)).toBe('12.0.0');
  });
});

// WSL on the owner's PC runs verify:linux, and nothing on GitHub can update it. Until
// 2026-10-04 wsl-releases.yml opened an issue for each release; update-local.ps1 now
// compares the PC's WSL with the latest release itself.
describe('newestWsl', () => {
  const release = (tag, days, more = {}) => ({tag_name: tag, published_at: daysAgo(days), ...more});

  it('is the latest release once it is 5 days old', () => {
    expect(newestWsl(release('2.6.1', 9), now)).toBe('2.6.1');
    expect(newestWsl(release('2.6.1.0', 5), now)).toBe('2.6.1.0');
  });

  it('is nothing while the latest release is younger', () => {
    expect(newestWsl(release('2.6.2', 4), now)).toBe(null);
  });

  it('is nothing for a pre-release, a draft or a release without a date', () => {
    expect(newestWsl(release('2.7.0', 9, {prerelease: true}), now)).toBe(null);
    expect(newestWsl(release('2.7.0', 9, {draft: true}), now)).toBe(null);
    expect(newestWsl({tag_name: '2.7.0'}, now)).toBe(null);
  });

  // update-local.ps1 compares it and prints it: another project's text goes no further.
  it.each(['v2.6.1', '2.6.1-rc1', '2', '2.6.1 && calc', '', undefined])('refuses the tag %s', (tag) => {
    expect(() => newestWsl({tag_name: tag, published_at: daysAgo(9)}, now)).toThrow(/not a version number/);
  });

  it('refuses an answer that is no release', () => {
    expect(() => newestWsl(null, now)).toThrow(/not a version number/);
    expect(() => newestWsl({message: 'API rate limit exceeded'}, now)).toThrow(/not a version number/);
  });
});

describe('update-local.ps1', () => {
  const script = path.resolve(import.meta.dirname, '../../tools/update-local.ps1');
  const helper = path.resolve(import.meta.dirname, '../../tools/update-local-lib.ps1');

  it.each([script, helper])('%s is plain ASCII, as Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page', (file) => {
    const text = fs.readFileSync(file, 'utf8');
    expect([...text].filter((c) => c.charCodeAt(0) > 127)).toEqual([]);
  });

  it.runIf(process.platform === 'win32').each([script, helper])('%s parses in Windows PowerShell', (file) => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); $e.Count`],
    {encoding: 'utf8', windowsHide: true});
    expect(r.stdout.trim()).toBe('0');
  }, 30000);

  // The Node.js installer's staging folder. Run for real in Windows PowerShell 5.1, the one
  // update-local.cmd starts: until 2026-10-03 this code had only been parsed, and it failed
  // there twice over (a [void] cast piped on, and 'Administrators' by its English name).
  it.runIf(process.platform === 'win32')('New-PrivateDirectory admits only this user, Administrators and SYSTEM', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-private-dir-'));
    const dir = path.join(parent, 'staging');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; . '${helper}'; New-PrivateDirectory '${dir}'; $a = Get-Acl -LiteralPath '${dir}'; ` +
      `[pscustomobject]@{me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
      `protected = $a.AreAccessRulesProtected; rules = @($a.Access | ForEach-Object { '{0} {1} {2} {3}' -f ` +
      `$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value, $_.FileSystemRights, ` +
      `$_.AccessControlType, $_.IsInherited })} | ConvertTo-Json -Compress`],
    {encoding: 'utf8', windowsHide: true});
    fs.rmSync(parent, {recursive: true, force: true});
    expect(r.stderr).toBe('');
    const acl = JSON.parse(r.stdout);
    expect(acl.protected).toBe(true);
    expect(acl.rules.sort()).toEqual([
      `${acl.me} FullControl Allow False`,
      'S-1-5-18 FullControl Allow False', // SYSTEM
      'S-1-5-32-544 FullControl Allow False', // Administrators
    ].sort());
  }, 30000);

  // Windows PowerShell started under PowerShell 7 by anything but PowerShell 7 itself
  // (update-local.cmd from a PowerShell 7 terminal, as VS Code's is; vitest started there)
  // inherits 7's module folders first, and Get-Acl's module then failed to load (2026-10-04).
  it.runIf(process.platform === 'win32')('New-PrivateDirectory works with PowerShell 7\'s module folders first', (ctx) => {
    const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSHOME'],
        {encoding: 'utf8', windowsHide: true});
    if (pwsh.status !== 0) {
      ctx.skip();
    }
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-private-pwsh7-'));
    const dir = path.join(parent, 'staging');
    // Every spelling of the name goes: a test worker's environment can hold it twice
    // (PSMODULEPATH and PSModulePath), and Windows then reads the one left unchanged.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PSModulePath$/i.test(name)));
    env.PSModulePath = [path.join(pwsh.stdout.trim(), 'Modules'), process.env.PSModulePath].filter(Boolean).join(';');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; . '${helper}'; ` +
      `try { New-PrivateDirectory '${dir}'; 'made' } catch { 'threw: ' + $_.Exception.Message }`],
    {encoding: 'utf8', windowsHide: true, env});
    fs.rmSync(parent, {recursive: true, force: true});
    expect(r.stdout.trim()).toBe('made');
  }, 30000);

  // What wsl.exe --version prints, as Windows PowerShell 5.1 gets it: the label is in
  // Windows' language, and without WSL_UTF8 every character is followed by a NUL.
  it.runIf(process.platform === 'win32')('ConvertFrom-WslVersionText reads the version off the first line', () => {
    const lines = (...text) => '(' + text.map((line) => `'${line}'`).join(' + [char]13 + [char]10 + ') + ')';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; . '${helper}'; ` +
      `$utf16 = -join ('WSL version: 2.6.1.0'.ToCharArray() | ForEach-Object { [string]$_ + [char]0 }); ` +
      '@(' + [
        `[string](ConvertFrom-WslVersionText ${lines('WSL version: 2.6.1.0', 'Kernel version: 6.6.87.2-1')})`,
        `[string](ConvertFrom-WslVersionText ${lines('WSL-Version: 2.5.9.0', 'Kernelversion: 6.6.87.1-1')})`,
        `[string](ConvertFrom-WslVersionText ${lines('', 'WSL version: 2.4.13.0')})`,
        '[string](ConvertFrom-WslVersionText $utf16)',
        `[string](ConvertFrom-WslVersionText ${lines('Copyright (c) Microsoft Corporation.', 'Usage: wsl.exe 2.0')})`,
        `[string](ConvertFrom-WslVersionText '')`,
      ].join(', ') + ') | ConvertTo-Json -Compress'],
    {encoding: 'utf8', windowsHide: true});
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual(['2.6.1.0', '2.5.9.0', '2.4.13.0', '2.6.1.0', '', '']);
  }, 30000);

  // The double-click: a check, then "Update these now?" only when the check exits with 2, and
  // -Apply only on Y. A stand-in update-local.ps1 logs each call; choice reads stdin.
  it.runIf(process.platform === 'win32').each([
    ['nothing to do', 0, 'Y', false, ['check']],
    ['a failed step', 1, 'Y', false, ['check']],
    ['something to update, N', 2, 'N', true, ['check']],
    ['something to update, Y', 2, 'Y', true, ['check', 'check -Apply']],
  ])('update-local.cmd: %s', (name, checkExit, answer, asks, calls) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-update-cmd-'));
    const log = path.join(dir, 'calls.txt');
    try {
      fs.mkdirSync(path.join(dir, 'tools'));
      fs.copyFileSync(path.resolve(import.meta.dirname, '../../update-local.cmd'), path.join(dir, 'update-local.cmd'));
      fs.writeFileSync(path.join(dir, 'tools', 'update-local.ps1'),
          `Add-Content -LiteralPath '${log}' -Value (@('check') + $args -join ' ')\r\n` +
          `if ($args -contains '-Apply') { exit 0 }\r\nexit ${checkExit}\r\n`);
      const r = spawnSync('cmd.exe', ['/d', '/c', path.join(dir, 'update-local.cmd')],
          {input: `${answer}\r\n\r\n`, encoding: 'utf8', windowsHide: true});
      expect(/\[Y,N\]/.test(r.stdout)).toBe(asks);
      expect(fs.readFileSync(log, 'utf8').trim().split(/\r?\n/)).toEqual(calls);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }, 30000);

  // The real check, in Windows PowerShell 5.1 as update-local.cmd starts it, against a fake
  // repository, with nothing on PATH but stand-ins for node, npm, pnpm and git (no wsl.exe, so
  // the WSL step only notes it is missing) and LOCALAPPDATA in a temporary folder (no mpv
  // helper installed): nothing real is asked or changed. Its exit code is what the .cmd reads.
  // Until 2026-10-04 a Node.js, npm or pnpm update exited 0, so the double-click never asked.
  describe.runIf(process.platform === 'win32')('the check\'s exit code', () => {
    const upToDate = {
      STUB_NODE: '22.23.3', STUB_NODE_NEWEST: '22.23.3',
      STUB_NPM: '11.9.0', STUB_NPM_NEWEST: '11.9.0',
      STUB_PNPM: '11.28.0', STUB_BEHIND: '0',
    };
    // A stand-in: answers what update-local.ps1 asks (a tool's --version; node running
    // newest-release.mjs, %2 being what it looks up; git's four questions), from the
    // environment, and fails loudly on anything else, which fails the step and the exit code.
    const stub = (lines) => `@echo off\r\n${lines.join('\r\n')}\r\necho stand-in: unexpected %* 1>&2\r\nexit /b 9\r\n`;
    const stubs = {
      'node.cmd': stub([
        'if "%~1"=="--version" (echo v%STUB_NODE%& exit /b 0)',
        'if "%~2"=="node" (echo %STUB_NODE_NEWEST%& exit /b 0)',
        'if "%~2"=="npm" (echo %STUB_NPM_NEWEST%& exit /b 0)',
      ]),
      'npm.cmd': stub(['if "%~1"=="--version" (echo %STUB_NPM%& exit /b 0)']),
      'pnpm.cmd': stub(['if "%~1"=="--version" (echo %STUB_PNPM%& exit /b 0)']),
      'git.cmd': stub([
        'if "%~1"=="remote" (echo origin& exit /b 0)',
        'if "%~1"=="status" exit /b 0',
        'if "%~1"=="rev-parse" (echo main& exit /b 0)',
        'if "%~1"=="rev-list" (echo %STUB_BEHIND%& exit /b 0)',
      ]),
    };

    it.each([
      ['nothing is due', 0, {}],
      ['a newer Node.js', 2, {STUB_NODE: '22.23.2'}],
      ['a newer npm', 2, {STUB_NPM: '11.8.0'}],
      ['pnpm older than the pin', 2, {STUB_PNPM: '11.27.0'}],
      ['main behind origin', 2, {STUB_BEHIND: '3'}],
    ])('%s: exits %i', (name, code, change) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-update-check-'));
      const bin = path.join(dir, 'bin');
      const repo = path.join(dir, 'repo');
      const temp = path.join(dir, 'temp');
      try {
        for (const folder of [bin, path.join(repo, 'node_modules'), temp]) {
          fs.mkdirSync(folder, {recursive: true});
        }
        for (const [name, text] of Object.entries(stubs)) {
          fs.writeFileSync(path.join(bin, name), text);
        }
        fs.writeFileSync(path.join(repo, '.nvmrc'), '22\n');
        fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({packageManager: 'pnpm@11.28.0'}));
        // Installed after the lockfile's last change: no install is due.
        const lock = path.join(repo, 'pnpm-lock.yaml');
        const marker = path.join(repo, 'node_modules', '.modules.yaml');
        fs.writeFileSync(lock, 'lockfileVersion: 9.0\n');
        fs.writeFileSync(marker, '{}\n');
        fs.utimesSync(lock, new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'));
        fs.utimesSync(marker, new Date('2026-10-02T10:00:00Z'), new Date('2026-10-02T10:00:00Z'));
        // PowerShell's own modules only: with LOCALAPPDATA in a fresh folder its module
        // analysis cache is gone, and every lookup of a command that is not there
        // (Get-Command wsl.exe) scanned every installed module - hundreds on GitHub's runner,
        // 25-45 s per run (2026-10-04), against about 1 s here.
        const powershellDir = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
        // On PATH too, after the stand-ins (it holds no node, npm, pnpm, git or wsl), so the
        // command below is the literal powershell.exe: built from SystemRoot, it was a command
        // line from an environment variable to CodeQL (js/command-line-injection, #163).
        const env = {
          SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: '.COM;.EXE;.BAT;.CMD',
          PATH: [bin, powershellDir].join(';'), TEMP: temp, TMP: temp, LOCALAPPDATA: temp, APPDATA: temp,
          USERPROFILE: dir, PSModulePath: path.join(powershellDir, 'Modules'),
          ...upToDate, ...change,
        };
        // A margin, not the expected time (about 1 s with the module path above): the run
        // gets 100 s and the test 120 s, and a hung PowerShell is ended with the run.
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', script, '-Repo', repo], {encoding: 'utf8', windowsHide: true, env, timeout: 100000});
        expect(r.error).toBeUndefined();
        expect(r.stdout).not.toMatch(/failed|stand-in/);
        expect(r.stdout).toMatch(/WSL: not on this PC/);
        expect(r.stdout.includes('Run tools\\update-local.ps1 -Apply')).toBe(code === 2);
        expect(r.status).toBe(code);
      } finally {
        fs.rmSync(dir, {recursive: true, force: true});
      }
    }, 120000);
  });

  // The Node.js step's download folder goes however the step ends (#244): a declined admin
  // prompt makes Start-Process throw, like the throw here.
  it.runIf(process.platform === 'win32').each([
    ['succeeds', '', 'done'],
    ['throws', 'throw \'declined\'', 'threw: declined'],
  ])('Invoke-InPrivateDirectory removes the folder when the body %s', (name, tail, outcome) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-private-run-'));
    const dir = path.join(parent, 'staging');
    try {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference = 'Stop'; . '${helper}'; ` +
        `try { Invoke-InPrivateDirectory '${dir}' { Set-Content -LiteralPath (Join-Path '${dir}' 'node.msi') 'x'; ${tail} }; 'done' } ` +
        `catch { 'threw: ' + $_.Exception.Message }`],
      {encoding: 'utf8', windowsHide: true});
      expect(r.stdout.trim()).toBe(outcome);
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      fs.rmSync(parent, {recursive: true, force: true});
    }
  }, 30000);

  // Whether a lockfile changed after the last install: the check offers an install only then.
  it.runIf(process.platform === 'win32')('Test-ChangedSince: a lockfile newer than the install marker, or no marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-changed-since-'));
    const lock = path.join(dir, 'lock.yaml');
    const marker = path.join(dir, '.modules.yaml');
    fs.writeFileSync(lock, 'a');
    const ask = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; . '${helper}'; Test-ChangedSince '${lock}' '${marker}'`],
    {encoding: 'utf8', windowsHide: true}).stdout.trim();
    try {
      expect(ask()).toBe('True'); // nothing installed yet
      fs.writeFileSync(marker, 'b');
      fs.utimesSync(lock, new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'));
      fs.utimesSync(marker, new Date('2026-10-02T10:00:00Z'), new Date('2026-10-02T10:00:00Z'));
      expect(ask()).toBe('False'); // installed after the lockfile's last change
      fs.utimesSync(lock, new Date('2026-10-03T10:00:00Z'), new Date('2026-10-03T10:00:00Z'));
      expect(ask()).toBe('True'); // the lockfile changed since (a pull)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }, 30000);
});
