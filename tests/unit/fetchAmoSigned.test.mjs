import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {EXIT, isNetworkError, parseArgs, signingState, waitForSigned} from '../../tools/fetch-amo-signed.mjs';
import {isMutationSandboxCopy} from './helpers/stryker.mjs';

// The AMO signing failsafe acts on what signingState answers: collect the xpi, wait,
// upload again, or tell the owner. A wrong answer either never collects a signed build
// or uploads a version AMO already has, which it refuses.

describe('authentication', () => {
  const source = fs.readFileSync(new URL('../../tools/fetch-amo-signed.mjs', import.meta.url), 'utf8');

  // Stryker's rewrite of the module says nothing about its imports (helpers/stryker.mjs).
  it.skipIf(isMutationSandboxCopy(source))('uses the AMO authentication of web-ext, which every release signs with', () => {
    // A token built by hand could drift from what AMO accepts; web-ext's is proven by
    // every release.yml run.
    expect(source).toMatch(/import \{JwtApiAuth\} from 'web-ext\/util\/submit-addon';/);
    expect(source).not.toMatch(/createHmac|node:crypto/);
  });
});

describe('signingState', () => {
  const version = (status, url = 'https://addons.mozilla.org/firefox/downloads/file/1/x-1.0.xpi') => ({file: {status, url}});

  it('reads the answers AMO gave for real versions', () => {
    // 1.3.82.27 and the late-signed 1.3.82.2: public with a download URL.
    expect(signingState(200, version('public'))).toBe('signed');
    // A version AMO never received (9.9.9): 404.
    expect(signingState(404, null)).toBe('missing');
  });

  it('waits on a version under review, and gives up on a rejected one', () => {
    expect(signingState(200, version('unreviewed'))).toBe('pending');
    expect(signingState(200, version('disabled'))).toBe('rejected');
  });

  it('treats anything unexpected as an error, never as missing', () => {
    // "missing" uploads again; doing that for a version AMO has would only be refused.
    for (const [status, body] of [[401, null], [500, null], [200, null], [200, {}], [200, version('public', null)], [200, version('something-new')]]) {
      expect(signingState(status, body), `${status} ${JSON.stringify(body)}`).toBe('error');
    }
  });

  it('maps every state to its own exit code', () => {
    expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
    expect(EXIT.signed).toBe(0);
  });
});

describe('isNetworkError', () => {
  it('knows the error v1.3.82.37\'s signing died of, and the socket errors under it', () => {
    // Node's fetch: TypeError('fetch failed'), the socket error as its cause.
    expect(isNetworkError(new TypeError('fetch failed'))).toBe(true);
    const reset = Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET'});
    expect(isNetworkError(Object.assign(new Error('wrapped'), {cause: reset}))).toBe(true);
    expect(isNetworkError(Object.assign(new Error('other side closed'), {code: 'UND_ERR_SOCKET'}))).toBe(true);
  });

  it('does not take AMO\'s own answers for the network', () => {
    // Waiting cannot help these: the upload was refused or the review is over.
    expect(isNetworkError(new Error('Version 1.3.82.37 already exists.'))).toBe(false);
    expect(isNetworkError(new Error('Validation failed: 1 error'))).toBe(false);
    expect(isNetworkError(new Error('Approval: timeout exceeded.'))).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});

describe('waitForSigned', () => {
  // A clock that moves only when the loop sleeps, and a check that answers from a list.
  const run = async (answers, budget = 5 * 60 * 1000, interval = 30 * 1000) => {
    let clock = 0;
    const asked = [];
    const state = await waitForSigned(async () => {
      const answer = answers[Math.min(asked.length, answers.length - 1)];
      asked.push(clock);
      if (answer instanceof Error) throw answer;
      return answer;
    }, {
      deadline: budget, interval, now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: () => {},
    });
    return {state, asked};
  };

  it('keeps asking through a network failure and a pending review until the version is signed', async () => {
    const {state, asked} = await run([new TypeError('fetch failed'), 'pending', 'pending', 'signed']);
    expect(state).toBe('signed');
    expect(asked).toEqual([0, 30000, 60000, 90000]);
  });

  it('stops at once on a rejected or missing version', async () => {
    expect((await run(['pending', 'rejected'])).state).toBe('rejected');
    expect((await run(['missing'])).asked).toEqual([0]);
  });

  it('gives up when the time runs out, saying whether AMO was still reviewing', async () => {
    const pending = await run(['pending'], 5 * 60 * 1000);
    expect(pending.state).toBe('pending');
    // 0, 30 s ... 300 s: the last check is the one that still fits in the budget.
    expect(pending.asked.length).toBe(11);
    expect((await run([new TypeError('fetch failed')], 60 * 1000)).state).toBe('error');
  });

  it('does not wait out an error the network did not cause', async () => {
    // No credentials, or a build of another version: 40 minutes of asking cannot mend it.
    const noCredentials = new Error('no AMO credentials: .amo-credentials.json or AMO_API_KEY/AMO_API_SECRET');
    await expect(run([noCredentials, 'signed'])).rejects.toBe(noCredentials);
  });
});

describe('parseArgs', () => {
  it('reads the version, and --wait in minutes', () => {
    expect(parseArgs(['1.3.82.37'])).toEqual({version: '1.3.82.37', waitMinutes: 0});
    expect(parseArgs(['1.3.82.37', '--wait', '40'])).toEqual({version: '1.3.82.37', waitMinutes: 40});
  });

  it('refuses what it does not know, rather than ignoring it', () => {
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['--wait', '40'])).toThrow(/usage/);
    expect(() => parseArgs(['1.3.82.37', '--wait'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['1.3.82.37', '--wait', 'soon'])).toThrow(/unknown argument/);
  });
});
