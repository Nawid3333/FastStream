import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {EXIT, signingState} from '../../tools/fetch-amo-signed.mjs';

// The AMO signing failsafe acts on what signingState answers: collect the xpi, wait,
// upload again, or tell the owner. A wrong answer either never collects a signed build
// or uploads a version AMO already has, which it refuses.

describe('authentication', () => {
  it('uses the AMO authentication of web-ext, which every release signs with', () => {
    // A token built by hand could drift from what AMO accepts; web-ext's is proven by
    // every release.yml run.
    const source = fs.readFileSync(new URL('../../tools/fetch-amo-signed.mjs', import.meta.url), 'utf8');
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
