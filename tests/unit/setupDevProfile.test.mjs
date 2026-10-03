import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {ADDONS, download} from '../../tools/setup-dev-profile.mjs';

// tools/setup-dev-profile.mjs (pnpm run profile:setup) puts uBlock Origin into the dev
// Firefox profile. It took AMO's `latest` file, whatever that was, with no check (#177). Imported,
// the script does nothing; these tests never touch a profile and never reach AMO.

const payload = Buffer.from('a signed xpi would be here');
const payloadSha256 = createHash('sha256').update(payload).digest('hex');
let server;
let base;
let tmp;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, {'content-type': 'application/x-xpinstall'});
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-profile-'));
  return () => fs.rmSync(tmp, {recursive: true, force: true});
});

describe('download', () => {
  it('keeps a file with the expected SHA-256', async () => {
    const dest = path.join(tmp, 'addon.xpi');
    expect(await download(`${base}/addon.xpi`, dest, payloadSha256)).toBe(payload.length);
    expect(fs.readFileSync(dest).equals(payload)).toBe(true);
    expect(fs.readdirSync(tmp)).toEqual(['addon.xpi']);
  });

  it('refuses any other file, and leaves nothing that a later run would take as installed', async () => {
    const dest = path.join(tmp, 'addon.xpi');
    await expect(download(`${base}/addon.xpi`, dest, '0'.repeat(64))).rejects.toThrow(/SHA-256/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});

describe('ADDONS', () => {
  it('pins each add-on to one release and its SHA-256', () => {
    expect(ADDONS.length).toBeGreaterThan(0);
    for (const addon of ADDONS) {
      expect(addon.version, addon.name).toMatch(/^\d+(\.\d+)+$/);
      expect(addon.sha256, addon.name).toMatch(/^[0-9a-f]{64}$/);
      expect(addon.url, addon.name).toMatch(/^https:\/\/addons\.mozilla\.org\/firefox\/downloads\/file\/\d+\/[\w.-]+\.xpi$/);
      expect(addon.url, addon.name).toContain(addon.version);
      expect(addon.url, addon.name).not.toContain('latest');
    }
  });
});
