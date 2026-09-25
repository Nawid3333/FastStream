import crypto from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {EXIT, amoJwt, signingState} from '../../tools/fetch-amo-signed.mjs';

// The AMO signing failsafe acts on what signingState answers: collect the xpi, wait,
// upload again, or tell the owner. A wrong answer either never collects a signed build
// or uploads a version AMO already has, which it refuses.

describe('amoJwt', () => {
  it('is an HS256 token AMO accepts: signed with the secret, issued by the key, short-lived', () => {
    const token = amoJwt('user:123:45', 'secret', 1000);
    const [head, body, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url'))).toEqual({alg: 'HS256', typ: 'JWT'});
    const claims = JSON.parse(Buffer.from(body, 'base64url'));
    expect(claims.iss).toBe('user:123:45');
    expect(claims.iat).toBe(1000);
    // AMO rejects a token that lives longer than five minutes.
    expect(claims.exp - claims.iat).toBeGreaterThan(0);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
    expect(signature).toBe(crypto.createHmac('sha256', 'secret').update(`${head}.${body}`).digest('base64url'));
  });

  it('is never reused: AMO refuses a jti it has seen', () => {
    const jti = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).jti;
    expect(jti(amoJwt('k', 's', 1))).not.toBe(jti(amoJwt('k', 's', 1)));
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
