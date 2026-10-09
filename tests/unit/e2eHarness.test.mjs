import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mp4FixtureMismatch, writeFixture} from '../e2e/mp4Fixture.mjs';
import {byteRange, decodePath, resolveInside, sendFile} from '../e2e/serveFile.mjs';
import {guardSetup, rootHooks} from '../e2e/setupGuard.mjs';

// The e2e harness's own gaps (F4-F6): a setup failure that let the specs run without the
// extension, fixtures a killed run left half written, and test servers that misread a
// suffix range or went down on one bad request.

describe('guardSetup and rootHooks', () => {
  beforeEach(() => {
    globalThis.browser = {isBidi: true};
  });
  afterEach(() => {
    delete globalThis.browser;
  });

  it('fail every test after the setup failed, with its reason', async () => {
    await expect(guardSetup(async () => {
      throw new Error('installAddOn: no such file');
    })).rejects.toThrow('installAddOn: no such file');
    expect(() => rootHooks.beforeEach()).toThrow(/setup failed.*installAddOn: no such file/);
  });

  it('let the tests run after a setup that worked, even one that failed before it', async () => {
    await guardSetup(async () => {
      throw new Error('first');
    }).catch(() => {});
    await guardSetup(async () => {});
    expect(() => rootHooks.beforeEach()).not.toThrow();
  });

  it('still fail a test in a session without BiDi', async () => {
    await guardSetup(async () => {});
    globalThis.browser = {isBidi: false, requestedCapabilities: {}};
    expect(() => rootHooks.beforeEach()).toThrow(/BiDi is not connected/);
  });
});

describe('writeFixture', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-'));
  });
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('writes under another name with the same extension, then moves it into place', async () => {
    const file = path.join(dir, 'long-av.mp4');
    let written;
    await writeFixture(file, (partial) => {
      written = partial;
      expect(fs.existsSync(file)).toBe(false);
      fs.writeFileSync(partial, 'data');
    });
    expect(path.basename(written)).toBe('long-av.partial.mp4');
    expect(fs.readFileSync(file, 'utf8')).toBe('data');
    expect(fs.readdirSync(dir)).toEqual(['long-av.mp4']);
  });

  it('leaves nothing a later run would trust when the write fails half way', async () => {
    const file = path.join(dir, 'sample.webm');
    await expect(writeFixture(file, (partial) => {
      fs.writeFileSync(partial, 'half');
      throw new Error('ffmpeg was killed');
    })).rejects.toThrow('ffmpeg was killed');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('mp4FixtureMismatch', () => {
  // The MP4 fixture is fetched from a host that may re-encode it; the specs count its
  // frames. Another file is refused by name instead of tested against (#256).
  const data = Buffer.from('not really an mp4, but pinned');
  const pin = {size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex')};

  it('passes the pinned bytes', () => {
    expect(mp4FixtureMismatch(data, pin)).toBeNull();
  });

  it('names another size, or other bytes of the same size', () => {
    expect(mp4FixtureMismatch(Buffer.concat([data, Buffer.from('!')]), pin))
        .toBe(`${data.length + 1} bytes, expected ${data.length}`);
    const other = Buffer.from(data);
    other[0] ^= 1;
    expect(mp4FixtureMismatch(other, pin)).toMatch(/^SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}$/);
  });

  it('is pinned to one file by default', () => {
    expect(mp4FixtureMismatch(data)).toMatch(/bytes, expected 991017$/);
  });
});

describe('byteRange', () => {
  it.each([
    [undefined, null],
    ['bytes=0-99', {start: 0, end: 99}],
    ['bytes=500-', {start: 500, end: 999}],
    // An end past the file's end is clamped: FastStream asks for such ranges.
    ['bytes=900-2000', {start: 900, end: 999}],
    // A suffix range is the LAST bytes.
    ['bytes=-100', {start: 900, end: 999}],
    ['bytes=-5000', {start: 0, end: 999}],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=1000-', 'unsatisfiable'],
    ['bytes=5-3', 'unsatisfiable'],
    // Not one range of bytes: the whole file, as a server that ignores Range sends.
    ['bytes=-', null],
    ['bytes=0-1,5-6', null],
    ['items=0-5', null],
  ])('reads %s of a 1000-byte file as %o', (header, expected) => {
    expect(byteRange(header, 1000)).toEqual(expected);
  });
});

describe('decodePath', () => {
  it('decodes escapes, and turns a malformed one into null instead of a throw', () => {
    expect(decodePath('/fixtures/a%20b.mp4')).toBe('/fixtures/a b.mp4');
    expect(decodePath('/fixtures/%zz')).toBe(null);
  });
});

describe('resolveInside', () => {
  const base = path.resolve(os.tmpdir(), 'fixtures');

  it('finds a file below the directory served', () => {
    expect(resolveInside(base, '/a.mp4')).toBe(path.join(base, 'a.mp4'));
    expect(resolveInside(base, '/hls-ts/seg-000.ts')).toBe(path.join(base, 'hls-ts', 'seg-000.ts'));
    expect(resolveInside(base, '/hls-ts/../a.mp4')).toBe(path.join(base, 'a.mp4'));
  });

  it('refuses a path out of it, also into a sibling whose name starts the same', () => {
    expect(resolveInside(base, '/../secret.txt')).toBeNull();
    expect(resolveInside(base, '/../fixtures-other/x.mp4')).toBeNull();
    expect(resolveInside(base, '/../../etc/passwd')).toBeNull();
  });
});

describe('sendFile', () => {
  // Also after a failed test: a spy or a folder left behind.
  let dir;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, {recursive: true, force: true});
    dir = null;
  });

  it('ends the response, not the process, when the file cannot be read', async () => {
    const res = new PassThrough();
    const destroyed = new Promise((resolve) => res.on('close', resolve));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendFile(res, path.join(os.tmpdir(), `missing-${Date.now()}.mp4`));
    await destroyed;
    expect(res.destroyed).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not read'));
  });

  it('sends the range asked for', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-'));
    const file = path.join(dir, 'f.bin');
    fs.writeFileSync(file, '0123456789');
    const res = new PassThrough();
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    const ended = new Promise((resolve) => res.on('end', resolve));
    sendFile(res, file, {start: 7, end: 9});
    await ended;
    expect(Buffer.concat(chunks).toString()).toBe('789');
  });
});

// The suites CI runs, and the release waits for, stream nothing from a public host: a
// demo host being slow or down failed both CI jobs (#255). Real streams are the live
// suite's (live-specs/), which is never part of CI.
describe('the e2e suites CI runs', () => {
  // Hosts the specs name without fetching: reserved test names, a subtitle search result's
  // link, which the stubbed search returns and nothing opens, and the search's API, whose
  // requests the stub answers from recorded answers (subtitle-search.e2e.mjs).
  const named = (host) => host === '127.0.0.1' || host === 'localhost' || host === 'example.com' ||
    /\.(test|example)$/.test(host) || !host.includes('.') || host === 'www.opensubtitles.com' ||
    host === 'api.opensubtitles.com';

  it('stream nothing from a public host', () => {
    const root = path.resolve(import.meta.dirname, '../e2e');
    const found = [];
    for (const dir of ['specs', 'ext-specs', 'classic-specs', 'pbm-specs']) {
      for (const name of fs.readdirSync(path.join(root, dir))) {
        const source = fs.readFileSync(path.join(root, dir, name), 'utf8');
        for (const [, host] of source.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
          if (!named(host)) found.push(`${dir}/${name}: ${host}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
