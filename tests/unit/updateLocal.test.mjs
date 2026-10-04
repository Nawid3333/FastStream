import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {isPinnedUrl, newestNode, newestPackage} from '../../tools/newest-release.mjs';

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
