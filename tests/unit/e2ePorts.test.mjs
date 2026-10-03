import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// The e2e servers listen on fixed ports. Linux hands ports 32768-60999 out to outgoing
// connections, and one that gets a test's port makes that server's listen() fail with
// EADDRINUSE - mpv-suspend's 41996 failed that way on CI (PR #40). The Linux CI jobs
// reserve 41800-41999 so none is ever handed out; this keeps every port in that range,
// and the reservation in every place that runs the e2e suites on Linux: the shared e2e
// setup action, which every e2e job uses, and tools/linux/setup.sh.

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

/**
 * Every job of every workflow, as the text of its block.
 * @return {Array<{name: string, job: string}>} "<file> <job id>", and the job's lines.
 */
function workflowJobs() {
  const dir = path.join(root, '.github/workflows');
  return fs.readdirSync(dir).filter((name) => name.endsWith('.yml')).flatMap((name) => {
    const source = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    const body = source.slice(source.indexOf('\njobs:\n') + 1);
    // A job starts at a two-space-indented key under jobs:.
    return body.split(/\n(?= {2}[\w-]+:\s*\n)/).slice(1)
        .map((job) => ({name: `${name} ${job.split(':')[0].trim()}`, job}));
  });
}

/**
 * Every port an e2e server is given (a constant named *PORT).
 * @return {Array<{file: string, port: number}>}
 */
function e2ePorts() {
  return moduleFiles(path.join(root, 'tests/e2e')).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return Array.from(source.matchAll(/\b[A-Z_]*PORT\s*=\s*(\d+)\b/g),
        (match) => ({file: path.relative(root, file).replaceAll(path.sep, '/'), port: Number(match[1])}));
  });
}

describe('e2e ports', () => {
  it('are all in the range the Linux CI jobs reserve', () => {
    const ports = e2ePorts();
    // The harness servers and the specs' own: a pattern that stopped matching would make
    // this pass on nothing.
    expect(ports.length).toBeGreaterThanOrEqual(10);
    expect(ports.filter(({port}) => port < LOW || port > HIGH)).toEqual([]);
  });

  it('are each given to one server only', () => {
    // Two specs on one port pass only while they never run at once (maxInstances: 1) and
    // each closes its server: a worker killed at the mocha cap leaves it open (#261).
    const users = new Map();
    for (const {file, port} of e2ePorts()) {
      users.set(port, [...(users.get(port) || []), file]);
    }
    expect([...users].filter(([, files]) => files.length > 1)).toEqual([]);
  });

  it('are reserved by the shared e2e setup and by verify:linux', () => {
    for (const file of ['.github/actions/e2e-setup/action.yml', 'tools/linux/setup.sh']) {
      expect(fs.readFileSync(path.join(root, file), 'utf8'), file)
          .toContain(`net.ipv4.ip_local_reserved_ports=${RESERVED}`);
    }
  });

  it('are reserved in every workflow job that runs an e2e suite', () => {
    // A step that runs a suite, not a mention of one (live-streams.yml's issue text has one).
    const e2eJobs = workflowJobs().filter(({job}) => /^ +run: pnpm run test:(e2e|ext|live|pbm)\b/m.test(job));
    // ci.yml's two, firefox-beta, firefox-stable, live-streams: a pattern that stopped
    // matching would make this pass on nothing.
    expect(e2eJobs.length).toBeGreaterThanOrEqual(5);
    const withoutSetup = e2eJobs.filter(({job}) => !job.includes('uses: ./.github/actions/e2e-setup'));
    expect(withoutSetup.map(({name}) => name)).toEqual([]);
  });
});
