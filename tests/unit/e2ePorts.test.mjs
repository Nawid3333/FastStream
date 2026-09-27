import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// The e2e servers listen on fixed ports. Linux hands ports 32768-60999 out to outgoing
// connections, and one that gets a test's port makes that server's listen() fail with
// EADDRINUSE - mpv-suspend's 41996 failed that way on CI (PR #40). The Linux CI jobs
// reserve 41800-41999 so none is ever handed out; this keeps every port in that range,
// and the reservation in every place that runs the e2e suites on Linux.

const RESERVED = '41800-41999';
const [LOW, HIGH] = RESERVED.split('-').map(Number);
const root = path.resolve(import.meta.dirname, '../..');

/**
 * Every .mjs file under a directory.
 * @param {string} dir - The directory.
 * @return {string[]} Their paths.
 */
function moduleFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'fixtures' ? [] : moduleFiles(file);
    }
    return entry.name.endsWith('.mjs') ? [file] : [];
  });
}

describe('e2e ports', () => {
  it('are all in the range the Linux CI jobs reserve', () => {
    const ports = moduleFiles(path.join(root, 'tests/e2e')).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return Array.from(source.matchAll(/\b[A-Z_]*PORT\s*=\s*(\d+)\b/g),
          (match) => ({file: path.relative(root, file), port: Number(match[1])}));
    });
    // The harness servers and the specs' own: a pattern that stopped matching would make
    // this pass on nothing.
    expect(ports.length).toBeGreaterThanOrEqual(10);
    expect(ports.filter(({port}) => port < LOW || port > HIGH)).toEqual([]);
  });

  it('are reserved wherever the e2e suites run on Linux', () => {
    for (const file of [
      '.github/workflows/ci.yml',
      '.github/workflows/firefox-beta.yml',
      '.github/workflows/firefox-stable.yml',
      'tools/linux/setup.sh',
    ]) {
      expect(fs.readFileSync(path.join(root, file), 'utf8'), file)
          .toContain(`net.ipv4.ip_local_reserved_ports=${RESERVED}`);
    }
  });
});
