import {describe, expect, it} from 'vitest';
import {signOrCollect} from '../../tools/sign-amo.mjs';

// release.yml attaches the xpi and updates.json only when sign:amo succeeds. v1.3.82.37
// went out without them: AMO had the upload and signed it within minutes, but one
// "fetch failed" while web-ext polled for the signature ended the step, and the release
// waited for amo-signing-failsafe.yml. signOrCollect keeps waiting instead.

const MINUTE = 60 * 1000;

/**
 * Runs signOrCollect against scripted web-ext and AMO answers on a clock that moves only
 * when the wait sleeps.
 * @param {Array<Object|Error>} uploads - What each call of web-ext's sign resolves with
 *   or throws.
 * @param {Array<string|Error>} answers - What each check of AMO answers; the last repeats.
 * @param {number} [budget] - Time from the start to the deadline.
 * @return {Promise<Object>} The result, with the timeouts sign was given and the checks.
 */
async function run(uploads, answers, budget = 30 * MINUTE) {
  let clock = 0;
  const timeouts = [];
  let checks = 0;
  const result = await signOrCollect({
    sign: async (approvalTimeout) => {
      timeouts.push(approvalTimeout);
      const upload = uploads[timeouts.length - 1];
      if (upload instanceof Error) throw upload;
      clock += MINUTE;
      return upload;
    },
    check: async () => {
      const answer = answers[Math.min(checks++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    deadline: budget,
    now: () => clock,
    wait: {
      interval: 30 * 1000,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    log: () => {},
  });
  return {...result, timeouts, checks};
}

const signedByWebExt = {downloadedFiles: ['web-ext-artifacts/abc-1.3.82.38.xpi']};

describe('signOrCollect', () => {
  it('leaves a signing web-ext completes as it was: its xpi, no question to AMO', async () => {
    const result = await run([signedByWebExt], ['pending']);
    expect(result).toMatchObject({signed: true, state: 'signed', files: signedByWebExt.downloadedFiles, checks: 0});
    expect(result.timeouts).toEqual([30 * MINUTE]);
  });

  it('collects the xpi from AMO when the network fails under web-ext (v1.3.82.37)', async () => {
    const result = await run([new TypeError('fetch failed')], ['pending', new TypeError('fetch failed'), 'signed']);
    expect(result).toMatchObject({signed: true, state: 'signed', checks: 3});
    expect(result.timeouts.length).toBe(1);
  });

  it('uploads once more when AMO never received the version, with the time that is left', async () => {
    const result = await run([new TypeError('fetch failed'), signedByWebExt], ['missing']);
    expect(result).toMatchObject({signed: true, state: 'signed', files: signedByWebExt.downloadedFiles});
    expect(result.timeouts).toEqual([30 * MINUTE, 30 * MINUTE]);
  });

  it('uploads again only once', async () => {
    const result = await run([new TypeError('fetch failed'), new TypeError('fetch failed')], ['missing']);
    expect(result).toMatchObject({signed: false, state: 'missing'});
    expect(result.timeouts.length).toBe(2);
  });

  it('fails as before when AMO is still reviewing at the deadline, or rejects the version', async () => {
    expect(await run([new TypeError('fetch failed')], ['pending'])).toMatchObject({signed: false, state: 'pending'});
    expect(await run([new TypeError('fetch failed')], ['rejected'])).toMatchObject({signed: false, state: 'rejected'});
  });

  it('does not wait on an error that is AMO\'s answer, not the network\'s', async () => {
    const refused = new Error('Version 1.3.82.38 already exists.');
    await expect(run([refused], ['signed'])).rejects.toBe(refused);
  });
});
