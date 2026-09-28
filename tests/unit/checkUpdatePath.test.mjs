import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {checkUpdatesJson, checkXpi, geckoIdFromBuild, readZip} from '../../tools/check-update-path.mjs';

// Firefox's update check finds nothing, silently, when any link of the self-update path
// breaks: updates.json, its entry, the xpi's hash, Mozilla's signature, the add-on id.
// amo-signing-failsafe.yml runs tools/check-update-path.mjs after every release; these
// pin what it calls broken. The real v1.3.82.37 passed it (checked 2026-09-28).

const ID = 'thanatus@Nawid';
const REPO = 'Nawid3333/FastStream';

/**
 * A zip archive, deflated or stored, with sizes and offsets a reader can rely on (the CRC
 * is left 0; readZip does not check it).
 * @param {Object<string, string|Buffer>} entries - File name to contents.
 * @param {boolean} [deflate] - Compress the entries.
 * @return {Buffer}
 */
function zip(entries, deflate = true) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(entries)) {
    const raw = Buffer.from(contents);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const manifest = (overrides = {}) => JSON.stringify({
  manifest_version: 3,
  version: '1.3.82.38',
  browser_specific_settings: {gecko: {id: ID, strict_min_version: '142.0'}},
  ...overrides,
});

const signed = (manifestJson = manifest()) => zip({
  'manifest.json': manifestJson,
  'META-INF/mozilla.rsa': 'pkcs7',
  'META-INF/cose.sig': 'cose',
});

const hashOf = (buffer) => 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');

const entry = (xpi, overrides = {}) => ({
  version: '1.3.82.38',
  update_link: `https://github.com/${REPO}/releases/download/v1.3.82.38/abc-1.3.82.38.xpi`,
  update_hash: hashOf(xpi),
  applications: {gecko: {strict_min_version: '142.0'}},
  ...overrides,
});

const release = {id: ID, version: '1.3.82.38', repo: REPO, tag: 'v1.3.82.38'};

describe('readZip', () => {
  it('lists the files and reads them back, deflated or stored', () => {
    for (const deflate of [true, false]) {
      const files = readZip(zip({'a.txt': 'hello', 'dir/b.json': '{"x":1}'}, deflate));
      expect([...files.keys()]).toEqual(['a.txt', 'dir/b.json']);
      expect(files.get('dir/b.json')().toString()).toBe('{"x":1}');
    }
  });

  it('says so when the file is not a zip', () => {
    expect(() => readZip(Buffer.from('<html>Not Found</html>'))).toThrow(/not a zip/);
  });
});

describe('checkUpdatesJson', () => {
  it('passes the updates.json release.yml writes', () => {
    const xpi = signed();
    const {problems, entry: found} = checkUpdatesJson({addons: {[ID]: {updates: [entry(xpi)]}}}, release);
    expect(problems).toEqual([]);
    expect(found.version).toBe('1.3.82.38');
  });

  it('reports an updates.json that offers another version or another add-on', () => {
    const xpi = signed();
    expect(checkUpdatesJson({addons: {[ID]: {updates: [entry(xpi, {version: '1.3.82.37'})]}}}, release).problems)
        .toEqual(['updates.json offers 1.3.82.37, not 1.3.82.38']);
    expect(checkUpdatesJson({addons: {'other@id': {updates: [entry(xpi)]}}}, release).problems[0])
        .toMatch(/no updates for thanatus@Nawid \(it lists: other@id\)/);
  });

  it('reports a link to another release and a hash that is not one', () => {
    const xpi = signed();
    const bad = entry(xpi, {
      update_link: `https://github.com/${REPO}/releases/download/v1.3.82.37/abc.xpi`,
      update_hash: 'md5:1234',
    });
    const {problems} = checkUpdatesJson({addons: {[ID]: {updates: [bad]}}}, release);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/is not a file of v1\.3\.82\.38/);
    expect(problems[1]).toMatch(/not a sha256 hash/);
  });
});

describe('checkXpi', () => {
  const expected = (xpi) => ({id: ID, version: '1.3.82.38', hash: hashOf(xpi), minVersion: '142.0'});

  it('passes a signed xpi of the release, with the add-on id and the hash updates.json names', () => {
    const xpi = signed();
    expect(checkXpi(xpi, expected(xpi))).toEqual([]);
  });

  it('reports a hash of another file, which Firefox refuses to install', () => {
    const xpi = signed();
    const problems = checkXpi(xpi, {...expected(xpi), hash: 'sha256:' + '0'.repeat(64)});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Firefox refuses it/);
  });

  it('reports an xpi Mozilla did not sign', () => {
    const xpi = zip({'manifest.json': manifest()});
    const problems = checkXpi(xpi, expected(xpi));
    expect(problems).toEqual([
      expect.stringMatching(/no META-INF\/mozilla\.rsa/),
      expect.stringMatching(/no META-INF\/cose\.sig/),
    ]);
  });

  it('reports another version, another add-on id, and a different minimum Firefox', () => {
    const xpi = signed(manifest({
      version: '1.3.82.37',
      browser_specific_settings: {gecko: {id: 'other@id', strict_min_version: '150.0'}},
    }));
    const problems = checkXpi(xpi, expected(xpi));
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/version 1\.3\.82\.37, not 1\.3\.82\.38/);
    expect(problems[1]).toMatch(/add-on id is other@id/);
    expect(problems[2]).toMatch(/Firefox 142\.0 or newer, the xpi 150\.0/);
  });

  it('reports a download that is not an xpi at all', () => {
    const page = Buffer.from('<html>Not Found</html>');
    expect(checkXpi(page, expected(page))).toEqual([expect.stringMatching(/not a readable zip/)]);
  });
});

describe('geckoIdFromBuild', () => {
  it('reads the id build.mjs gives both Firefox builds', () => {
    const source = fs.readFileSync(new URL('../../build.mjs', import.meta.url), 'utf8');
    expect(geckoIdFromBuild(source)).toBe(ID);
  });

  it('refuses builds that disagree on the id', () => {
    expect(() => geckoIdFromBuild('gecko: {id: \'a@b\'} gecko: {id: \'c@d\'}')).toThrow(/one gecko id/);
  });
});
