import {afterEach, describe, expect, it, vi} from 'vitest';
import {bidiMissing, bidiRootHooks, ensureBidi} from '../e2e/bidi.mjs';

// The e2e suites' guard against a session that fell back to WebDriver classic
// (tests/e2e/bidi.mjs). A stand-in browser: isBidi as WebdriverIO reports it, and a
// reloadSession() whose new sessions connect BiDi only from the given attempt on.

/**
 * @param {{isBidi?: boolean, classic?: boolean, connectsOnReload?: number}} options
 * @return {{isBidi: boolean, requestedCapabilities: Object, reloadSession: Function}}
 */
function fakeBrowser({isBidi = false, classic = false, connectsOnReload = Infinity} = {}) {
  const browser = {
    isBidi,
    requestedCapabilities: classic ? {'wdio:enforceWebDriverClassic': true} : {},
    reloadSession: vi.fn(async () => {
      browser.isBidi = browser.reloadSession.mock.calls.length >= connectsOnReload;
    }),
  };
  return browser;
}

describe('bidiMissing', () => {
  it('lets a test run when BiDi is connected', () => {
    expect(bidiMissing(fakeBrowser({isBidi: true}))).toBeNull();
  });

  it('lets a test run in a session that asked for classic', () => {
    expect(bidiMissing(fakeBrowser({classic: true}))).toBeNull();
  });

  it('says why when BiDi is not connected', () => {
    expect(bidiMissing(fakeBrowser())).toMatch(/BiDi is not connected.*tests\/e2e\/bidi\.mjs/);
  });
});

describe('ensureBidi', () => {
  it('leaves a session with BiDi alone', async () => {
    const browser = fakeBrowser({isBidi: true});
    await ensureBidi(browser);
    expect(browser.reloadSession).not.toHaveBeenCalled();
  });

  it('leaves a session that asked for classic alone', async () => {
    const browser = fakeBrowser({classic: true});
    await ensureBidi(browser);
    expect(browser.reloadSession).not.toHaveBeenCalled();
  });

  it('starts the browser again until BiDi connects', async () => {
    const browser = fakeBrowser({connectsOnReload: 1});
    await ensureBidi(browser);
    expect(browser.reloadSession).toHaveBeenCalledTimes(1);
    expect(browser.isBidi).toBe(true);
  });

  it('gives up after two new browsers, and leaves the rest to the root hook', async () => {
    const browser = fakeBrowser();
    await ensureBidi(browser);
    expect(browser.reloadSession).toHaveBeenCalledTimes(2);
    expect(browser.isBidi).toBe(false);
  });
});

describe('bidiRootHooks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails a test in a session without BiDi', () => {
    vi.stubGlobal('browser', fakeBrowser());
    expect(() => bidiRootHooks.beforeEach()).toThrow(/BiDi is not connected/);
  });

  it('lets a test run with BiDi, or in a classic session', () => {
    vi.stubGlobal('browser', fakeBrowser({isBidi: true}));
    expect(() => bidiRootHooks.beforeEach()).not.toThrow();
    vi.stubGlobal('browser', fakeBrowser({classic: true}));
    expect(() => bidiRootHooks.beforeEach()).not.toThrow();
  });
});
