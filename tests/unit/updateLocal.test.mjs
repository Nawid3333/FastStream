import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {newestNode, newestPackage} from '../../tools/newest-release.mjs';

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

  it('is plain ASCII, as Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page', () => {
    const text = fs.readFileSync(script, 'utf8');
    expect([...text].filter((c) => c.charCodeAt(0) > 127)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('parses in Windows PowerShell', () => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$e); $e.Count`],
    {encoding: 'utf8', windowsHide: true});
    expect(r.stdout.trim()).toBe('0');
  }, 30000);
});
