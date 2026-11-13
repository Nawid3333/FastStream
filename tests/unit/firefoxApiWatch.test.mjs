// tools/firefox-api-watch.mjs: reading Mozilla's sources, what counts as relevant, how a finding
// is written, and the review issue's life: opened, appended to, never edited, closed = reviewed.
// Every source answers from a fake fetch, GitHub from an in-memory fake: nothing leaves the test.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {
  Bot, Prefix, Urls, bcdChanges, bugzillaItems, codeIndex, feedItems, findUses, getUrl, ghClient, identifiersOfPath,
  mdnInline, md, mergeFindings, parseArgs, parseMdnNotes, productDetails, readTarFile, recordsOf, relevantFindings,
  renderSection, run, safeUrl, underPrefix,
} from '../../tools/firefox-api-watch.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'tools/firefox-api-watch.topics.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------
// Fixtures

/** A release's notes in MDN's source form. @param {number} v */
function notes(v, {wip = false, extra = ''} = {}) {
  return `---
title: Firefox ${v} release notes for developers (${wip ? 'Beta' : 'Stable'})
slug: Mozilla/Firefox/Releases/${v}
---

This article provides information about the changes in Firefox ${v} that affect developers.
${wip ? '\n> [!NOTE]\n> The release notes for this Firefox version are still a work in progress.\n' : ''}
## Changes for web developers

### Developer Tools

- The Network Monitor now shows the byte ranges a {{HTMLElement("video")}} element requested. ([Firefox bug ${v}010](https://bugzil.la/${v}010)).

<!-- ### HTML -->

### APIs

- The {{domxref("MediaSource.canConstructInDedicatedWorker_static", "canConstructInDedicatedWorker")}} property of {{domxref("MediaSource")}} is now supported,
  so a worker can feed video. ([Firefox bug ${v}001](https://bugzil.la/${v}001)).
- The {{domxref("WebTransport.WebTransport", "WebTransport()")}} constructor takes a new option. ([Firefox bug ${v}009](https://bugzil.la/${v}009)).

#### Removals

- The non-standard \`SourceBuffer.mozFlush\` method has been removed. ([Firefox bug ${v}002](https://bugzil.la/${v}002)).

### WebDriver conformance (WebDriver BiDi, Marionette)

- Fixed the \`script.evaluate\` command in BiDi. ([Firefox bug ${v}008](https://bugzil.la/${v}008)).

## Changes for add-on developers

- {{WebExtAPIRef("tabs.sendMessage()")}} now rejects when the frame is gone, instead of never settling. ([Firefox bug ${v}003](https://bugzil.la/${v}003))
- {{WebExtAPIRef("userScripts.execute()")}} accepts a new option. ([Firefox bug ${v}004](https://bugzil.la/${v}004))
${extra}
## Experimental web features

- **Lazy loading for video**: \`media.lazy_loading.enabled\`

  The \`loading\` attribute of the {{HTMLElement("video", "", "#loading")}} element and {{domxref("HTMLMediaElement.loading")}} are supported. ([Firefox bug ${v}005](https://bugzil.la/${v}005)).
`;
}

/** BCD's data.json, cut down. */
const bcdData = {
  __meta: {version: '9.9.9'},
  browsers: {firefox: {}},
  api: {
    MediaSource: {
      __compat: {support: {firefox: {version_added: '42'}}},
      canConstructInDedicatedWorker_static: {
        __compat: {mdn_url: 'https://developer.mozilla.org/docs/Web/API/MediaSource/canConstructInDedicatedWorker_static',
          support: {firefox: {version_added: '161', impl_url: 'https://bugzil.la/161001'}}},
      },
    },
    BlobEvent: {__compat: {support: {firefox: {version_added: '161'}}}},
    SourceBuffer: {
      __compat: {support: {firefox: {version_added: '42'}}},
      mozFlush: {__compat: {support: {firefox: {version_added: '50', version_removed: '161'}}}},
      changeType: {__compat: {support: {firefox: [{version_added: '161'}, {version_added: '70', flags: [{name: 'x'}]}]}}},
    },
  },
  webextensions: {
    api: {
      tabs: {sendMessage: {__compat: {support: {firefox: {version_added: '45'}}},
        options: {documentId: {__compat: {support: {firefox: {version_added: '153'}}}}}}},
      userScripts: {execute: {__compat: {support: {firefox: {version_added: '161'}}}}},
    },
    manifest: {
      theme: {__compat: {support: {firefox: {version_added: '55'}}}},
      permissions: {publicSuffix: {__compat: {support: {firefox: {version_added: '161'}}}}},
    },
  },
};

/**
 * A one-file tar, gzipped, as npm serves a package.
 * @param {string} name
 * @param {string} content
 */
function tgz(name, content) {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return zlib.gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

const tarball = tgz('package/data.json', JSON.stringify(bcdData));
const tarballUrl = 'https://registry.npmjs.org/@mdn/browser-compat-data/-/browser-compat-data-9.9.9.tgz';

/** @param {number} v */
function bugs(v) {
  return {
    webext: {bugs: [
      {id: v * 1000 + 3, summary: 'tabs.sendMessage hangs for a closed frame', product: 'WebExtensions', component: 'General', keywords: []},
      {id: v * 1000 + 6, summary: 'Use run-if for the shared WebExtensions test submanifests', product: 'WebExtensions', component: 'General', keywords: []},
    ]},
    core: {bugs: [
      {id: v * 1000 + 7, summary: 'mediaCapabilities.decodingInfo() never resolves for video on Windows', product: 'Core', component: 'Audio/Video: Playback', keywords: []},
      {id: v * 1000 + 10, summary: '[wpt-sync] Sync PR 1 - MediaSource tests', product: 'Core', component: 'Audio/Video', keywords: []},
      {id: v * 1000 + 11, summary: 'Video decoder textures leak on Android', product: 'Core', component: 'Audio/Video: Playback', keywords: ['dev-doc-needed']},
    ]},
  };
}

const feedXml = `<?xml version="1.0"?><rss><channel>
<item><title>Firefox 161 WebExtensions API updates</title><link>https://blog.mozilla.org/addons/2026/11/20/firefox-161/</link></item>
<item><title>Something else &amp; more</title><link>https://blog.mozilla.org/addons/other/</link></item>
</channel></rss>`;

/**
 * A fake fetch serving the sources; anything not set answers 404. status: per URL prefix, a status
 * to answer instead. log: every URL asked.
 * @param {{current?: number, mdn?: Record<number, string>, status?: Record<string, number>, log?: string[],
 *   bugzilla?: (v: number) => any, tar?: Buffer, integrity?: string, feed?: string}} [options]
 * @return {typeof fetch}
 */
function sources({current = 161, mdn = {161: notes(161)}, status = {}, log = [], bugzilla = bugs, tar = tarball, integrity, feed = feedXml} = {}) {
  const dates = {'158.0': '2026-10-13', '159.0': '2026-10-27', '160.0': '2026-11-10', '161.0': '2026-11-20', '162.0': '2026-12-04', '163.0': '2026-12-18'};
  return /** @type {typeof fetch} */ (async (input) => {
    const url = String(input);
    log.push(url);
    for (const [prefix, code] of Object.entries(status)) {
      if (url.startsWith(prefix)) return new Response('', {status: code});
    }
    const json = (/** @type {any} */ value) => new Response(JSON.stringify(value), {status: 200});
    if (url === Urls.versions) return json({LATEST_FIREFOX_VERSION: `${current}.0`, LAST_RELEASE_DATE: '2026-11-20'});
    if (url === Urls.majors) return json(dates);
    const m = /releases\/(\d+)\/index\.md$/.exec(url);
    if (m) return mdn[Number(m[1])] ? new Response(mdn[Number(m[1])], {status: 200}) : new Response('404', {status: 404});
    if (url === Urls.bcd) {
      return json({version: '9.9.9', dist: {tarball: tarballUrl, integrity: integrity ?? 'sha512-' + crypto.createHash('sha512').update(tar).digest('base64')}});
    }
    if (url === tarballUrl) return new Response(tar, {status: 200});
    if (url.startsWith(Urls.bugzilla)) {
      const v = Number(/cf_status_firefox(\d+)/.exec(url)?.[1]);
      return json(url.includes('product=WebExtensions') ? bugzilla(v).webext : bugzilla(v).core);
    }
    if (url === Urls.feed) return new Response(feed, {status: 200});
    return new Response('', {status: 404});
  });
}

/** The extension's code, as the watcher sees it. */
function index() {
  return codeIndex({files: new Map([
    ['chrome/manifest.json', JSON.stringify({manifest_version: 3, permissions: ['tabs', 'storage'], background: {}, content_scripts: []})],
    ['chrome/background/background.mjs', 'chrome.tabs.sendMessage(tabId, msg, {frameId});\nchrome.storage.local.get();'],
    ['chrome/player/players/Mse.mjs', 'const ms = new MediaSource();\nconst caps = navigator.mediaCapabilities;\ncaps.decodingInfo(config);'],
    ['chrome/player/ui/Alert.mjs', 'bar.animate([], 300); // the animation of the bar'],
  ])});
}

/**
 * GitHub in memory: issues, comments, and every write it was asked for.
 * @param {{number: number, state?: string, title: string, body: string, user?: string}[]} [issues]
 * @param {Record<number, {body: string, user: string}[]>} [comments]
 */
function fakeGitHub(issues = [], comments = {}) {
  /** @type {any[][]} */
  const writes = [];
  const state = {
    issues: issues.map((i) => ({state: 'open', user: Bot, ...i})),
    comments: /** @type {Record<number, {body: string, user: string}[]>} */ (structuredClone(comments)),
    /** Issues whose state getIssue reports differently from the list (closed meanwhile). */
    closedMeanwhile: /** @type {Set<number>} */ (new Set()),
    failCommentAfter: Infinity,
    /** The list leaves out the issues opened here, as GitHub's can for a moment. */
    listLags: false,
  };
  let next = 100;
  /** @type {import('../../tools/firefox-api-watch.mjs').GitHub} */
  const api = {
    listIssues: async () => state.issues.filter((i) => !(state.listLags && i.number >= 100)).map((i) => ({...i})),
    listComments: async (n) => (state.comments[n] ?? []).map((c) => ({...c})),
    getIssue: async (n) => {
      const issue = state.issues.find((i) => i.number === n);
      if (!issue) throw new Error(`no issue ${n}`);
      return {...issue, state: state.closedMeanwhile.has(n) ? 'closed' : issue.state};
    },
    createIssue: async (title, body) => {
      writes.push(['create', title, body]);
      const number = next++;
      state.issues.push({number, state: 'open', title, body, user: Bot});
      return number;
    },
    comment: async (n, body) => {
      if (writes.filter((w) => w[0] === 'comment').length >= state.failCommentAfter) throw new Error('HTTP 502');
      writes.push(['comment', n, body]);
      (state.comments[n] ??= []).push({body, user: Bot});
    },
  };
  return {api, state, writes};
}

/** @param {Partial<import('../../tools/firefox-api-watch.mjs').RunOptions>} [options] */
function runWith(options = {}) {
  return run({fetchImpl: sources(), wait: async () => {}, today: '2026-11-21', config, index: index(), start: 161, ...options});
}

// ---------------------------------------------------------------------------------------------
// Sources

describe('reading the sources', () => {
  it('asks again when the server does not answer, and gives up after three tries as an outage', async () => {
    let calls = 0;
    const fetchImpl = /** @type {typeof fetch} */ (async () => {
      calls++;
      throw new Error('ECONNRESET');
    });
    await expect(getUrl('https://example.test/a', {fetchImpl, wait: async () => {}})).rejects.toMatchObject({outage: true});
    expect(calls).toBe(3);
  });

  it('fails at once on a 4xx other than 404 and 429, and returns a 404 to the caller', async () => {
    const answer = (/** @type {number} */ status) => /** @type {typeof fetch} */ (async () => new Response('x', {status}));
    await expect(getUrl('https://example.test/a', {fetchImpl: answer(403), wait: async () => {}})).rejects.toMatchObject({outage: false});
    expect((await getUrl('https://example.test/a', {fetchImpl: answer(404), wait: async () => {}})).status).toBe(404);
    await expect(getUrl('https://example.test/a', {fetchImpl: answer(429), wait: async () => {}})).rejects.toMatchObject({outage: true});
  });

  it('reads the current Stable major and the release dates', async () => {
    const pd = await productDetails({fetchImpl: sources({current: 160}), wait: async () => {}});
    expect(pd.current).toBe(160);
    expect(pd.dates.get(159)).toBe('2026-10-27');
  });

  it('refuses a version list it does not understand', async () => {
    const fetchImpl = /** @type {typeof fetch} */ (async () => new Response(JSON.stringify({LATEST_FIREFOX_VERSION: 'soon'}), {status: 200}));
    await expect(productDetails({fetchImpl, wait: async () => {}})).rejects.toMatchObject({outage: false});
  });

  it('finds one file in a tar archive', () => {
    expect(readTarFile(zlib.gunzipSync(tgz('package/data.json', '{"a":1}')), 'package/data.json')).toBe('{"a":1}');
    expect(readTarFile(zlib.gunzipSync(tgz('package/other.json', 'x')), 'package/data.json')).toBeNull();
  });
});

describe('MDN notes', () => {
  it('turns macros, links and code into plain text with code spans', () => {
    const out = mdnInline('{{WebExtAPIRef("publicSuffix.isKnownSuffix()")}} and {{domxref("A.b", "b()")}} use [`headers`](/en-US/docs/X) ' +
      '{{HTMLElement("link",,"blocking")}} ([Firefox bug 12](https://bugzil.la/12), [Firefox bug 13](https://bugzil.la/13)).');
    expect(out.text).toBe('`publicSuffix.isKnownSuffix` and `b()` use `headers` `<link>`.');
    expect(out.bugs).toEqual([12, 13]);
    expect(out.identifiers).toEqual(expect.arrayContaining(['publicSuffix.isKnownSuffix', 'A.b', 'headers']));
    expect(out.links).toEqual([{label: 'headers', url: 'https://developer.mozilla.org/en-US/docs/X'}]);
  });

  it('reads each bullet with its section, joining continued lines and skipping commented-out parts', () => {
    const {items, wip} = parseMdnNotes(notes(161), 161);
    expect(wip).toBe(false);
    const line = (/** @type {number} */ bug) => items.filter((i) => i.bugs.includes(bug)).map((i) => `${i.section} | ${i.title}`);
    expect(line(161001)).toEqual(['Changes for web developers › APIs | The `canConstructInDedicatedWorker` property of `MediaSource` is now supported, so a worker can feed video.']);
    expect(line(161010)).toEqual(['Changes for web developers › Developer Tools | The Network Monitor now shows the byte ranges a `<video>` element requested.']);
    expect(items.find((i) => i.bugs.includes(161002))).toMatchObject({removal: true, section: 'Changes for web developers › APIs › Removals'});
    expect(items.find((i) => i.bugs.includes(161005))).toMatchObject({experimental: true});
    expect(items.find((i) => i.bugs.includes(161005))?.detail).toMatch(/loading/);
  });

  it('tells notes that are still a work in progress', () => {
    expect(parseMdnNotes(notes(162, {wip: true}), 162)).toMatchObject({wip: true, beta: true});
  });
});

describe('browser-compat-data', () => {
  const all = () => true;

  it('reports what starts or ends in the release, without a preference', () => {
    const titles = bcdChanges(bcdData, 161, all).map((i) => i.title).sort();
    expect(titles).toEqual([
      '`BlobEvent` supported',
      '`MediaSource.canConstructInDedicatedWorker_static` supported',
      // Support behind a preference before does not count: this is when it ships.
      '`SourceBuffer.changeType` supported',
      '`SourceBuffer.mozFlush` removed',
      '`permissions.publicSuffix` supported',
      '`userScripts.execute` supported',
    ]);
    expect(bcdChanges(bcdData, 161, all).find((i) => i.title.includes('canConstruct'))?.bugs).toEqual([161001]);
  });

  it('keeps a prefix to its own feature', () => {
    expect(underPrefix('api.Blob.text', 'api.Blob')).toBe(true);
    expect(underPrefix('api.BlobEvent', 'api.Blob')).toBe(false);
    expect(underPrefix('webextensions.api.tabs', 'webextensions.')).toBe(true);
  });

  it('names what code would contain', () => {
    expect(identifiersOfPath('webextensions.api.tabs.sendMessage.options.documentId')).toEqual(['tabs.sendMessage', 'documentId']);
    expect(identifiersOfPath('api.HTMLVideoElement.enterpictureinpicture_event')).toEqual(['HTMLVideoElement.enterpictureinpicture', 'enterpictureinpicture']);
    expect(identifiersOfPath('api.MediaSource')).toEqual(['MediaSource']);
  });
});

describe('Bugzilla and the blog', () => {
  it('keeps WebExtensions bugs and the Core bugs that name a media term, never test-only ones', () => {
    const items = bugzillaItems({bugs: [...bugs(161).webext.bugs, ...bugs(161).core.bugs]}, config.bugzilla, new Set(['tabs']));
    expect(items.map((i) => i.bugs[0])).toEqual([161003, 161007]);
    expect(items[1].identifiers).toContain('mediaCapabilities.decodingInfo');
  });

  it('takes the posts that name the release', () => {
    const items = feedItems(feedXml, 161);
    expect(items).toHaveLength(1);
    expect(items[0].links[0].url).toBe('https://blog.mozilla.org/addons/2026/11/20/firefox-161/');
    expect(feedItems(feedXml, 16)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Relevance

describe('what is relevant', () => {
  const idx = index();

  it('finds a dotted name, a member with its interface, and never a bare common word', () => {
    const stop = new Set(config.stopIdentifiers);
    expect(findUses(['tabs.sendMessage'], idx.files, stop, idx.namespaces)).toMatchObject({used: ['tabs.sendMessage'], strong: true});
    expect(findUses(['mediaCapabilities.decodingInfo'], idx.files, stop, idx.namespaces)).toMatchObject({used: ['decodingInfo'], strong: true});
    // Animation.playbackRate: the interface is not in any file (the word "animation" is not the interface).
    expect(findUses(['Animation.playbackRate', 'playbackRate', 'reverse'], idx.files, stop, idx.namespaces).used).toEqual([]);
    // A WebExtensions member is never taken alone: runtime.getVersion is not EnvUtils.getVersion.
    const own = codeIndex({files: new Map([['chrome/a.mjs', 'chrome.runtime.sendMessage(); EnvUtils.getVersion();']])});
    expect(findUses(['runtime.getVersion'], own.files, stop, own.namespaces).used).toEqual([]);
  });

  it('keeps the changes to what the extension uses, merges the same change from several sources, drops the rest', () => {
    const v = 161;
    const items = [
      ...parseMdnNotes(notes(v), v).items,
      ...bcdChanges(bcdData, v, () => true),
      ...bugzillaItems({bugs: [...bugs(v).webext.bugs, ...bugs(v).core.bugs]}, config.bugzilla, idx.namespaces),
      ...feedItems(feedXml, v),
    ];
    const withKnown = {...idx, known: {namespaces: new Set(['tabs', 'userScripts', 'runtime']), manifestKeys: new Set(['theme', 'permissions'])}};
    const findings = relevantFindings(items, config, withKnown);
    const titles = findings.map((f) => f.title);
    // The worker MSE note, its BCD entry and its bug are one finding.
    const mse = findings.find((f) => f.title.includes('canConstructInDedicatedWorker'));
    expect(mse?.sources.sort()).toEqual(['bcd', 'mdn']);
    expect(mse?.aliases).toContain('bug:161001');
    // The add-on note and the Bugzilla bug about tabs.sendMessage are one finding, a compatibility risk.
    const tabs = findings.find((f) => f.title.includes('tabs.sendMessage'));
    expect(tabs).toMatchObject({kind: 'Compatibility risk', priority: 'high', confidence: 'high'});
    expect(tabs?.files).toEqual(['chrome/background/background.mjs']);
    // The removal is a compatibility risk.
    expect(findings.find((f) => f.title.includes('mozFlush'))?.kind).toBe('Compatibility risk');
    // decodingInfo never resolving: the code calls it.
    expect(findings.find((f) => f.title.includes('decodingInfo'))).toMatchObject({confidence: 'high', priority: 'high'});
    // Dropped: WebTransport (not used), userScripts and publicSuffix (APIs the extension does not use),
    // the WebDriver fix, the developer tools note, the test-only and Android-only bugs, BlobEvent
    // (not under api.Blob).
    for (const gone of ['WebTransport', 'userScripts', 'publicSuffix', 'script.evaluate', 'Network Monitor', 'submanifests', 'Android', 'BlobEvent']) {
      expect(titles.join('\n')).not.toContain(gone);
    }
    // The blog post is kept.
    expect(titles).toContain('Add-ons blog: Firefox 161 WebExtensions API updates');
  });
});

describe('merging and folding findings', () => {
  /** @param {Object} over */
  const finding = (over) => /** @type {any} */ ({title: 'x', detail: '', sources: ['mdn'], aliases: [], mergeKeys: [], areas: ['Media'],
    kind: 'New feature', priority: 'medium', confidence: 'medium', files: [], used: [], modules: [], links: [], experimental: false,
    members: [], ...over});

  it('shows every note merged into one finding: its kind may be another note\'s', () => {
    const [merged, ...rest] = mergeFindings([
      finding({title: 'MediaSource is available in shared workers', aliases: ['mdn:a'], mergeKeys: ['leaf:mediasource'], members: [['mdn:a']]}),
      finding({title: 'isTypeSupported() now rejects strings it previously accepted', kind: 'Compatibility risk', aliases: ['bug:9'],
        mergeKeys: ['leaf:mediasource'], members: [['bug:9']]}),
    ]);
    expect(rest).toEqual([]);
    expect(merged.kind).toBe('Compatibility risk');
    expect(`${merged.title} ${merged.detail}`).toContain('isTypeSupported() now rejects strings it previously accepted');
    expect(merged.members).toEqual([['mdn:a'], ['bug:9']]);
  });

  it('folds the low ones whatever their text holds', () => {
    const review = /** @type {any} */ ({version: 161, date: '', complete: true, reason: '', wip: false, checked: 2, findings: []});
    // A "<details>" in a title's code is no fold of the watcher's: counted as one, a stray
    // "</details>" was added at the end.
    const [part, ...more] = renderSection(review, [finding({priority: 'low', title: '`<details>` gets a name'}),
      finding({priority: 'low', title: 'another'})], {late: false, bcdVersion: ''});
    expect(more).toEqual([]);
    expect(part.match(/<details><summary>/g)).toHaveLength(1);
    expect(part).not.toContain('continued');
    expect(part.split('\n').filter((line) => line === '</details>')).toHaveLength(1);
    expect(part.trimEnd().endsWith('\n</details>')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Writing safely

describe('outside text in an issue', () => {
  it('can mention no one, link to nothing it chose, and reference none of our issues', () => {
    const out = md('Thanks @someone, see #12 and GH-3, <img src=x onerror=alert(1)> [click](javascript:alert(1)) ' +
      '![i](https://evil.example/x.png) https://evil.example www.evil.example deadbeef1234 <!-- ffw-item bug:1 -->');
    // The zero-width space is written as the entity &#8203;, whose own "#8" GitHub never sees as
    // text: entities are decoded before references are looked for.
    expect(out).not.toMatch(/@[A-Za-z]/);
    expect(out).not.toMatch(/(?<!&)#\d/);
    expect(out).not.toMatch(/GH-\d/);
    expect(out).not.toMatch(/<[a-z!]/i);
    expect(out).not.toMatch(/(?<!\\)\[click(?<!\\)\]\(/);
    expect(out).not.toContain('https://');
    expect(out).not.toMatch(/\bwww\./);
    expect(recordsOf([out]).aliases.size).toBe(0);
  });

  it('keeps code spans as code, without a way to hide a marker in them', () => {
    expect(md('use `<video>` here')).toBe('use `<video>` here');
    expect(recordsOf([md('`<!-- ffw-item bug:1 -->`')]).aliases.size).toBe(0);
    // One pass of removal would leave the pieces around each opener to join into a new one.
    for (const text of ['tabs.query fix `<!<!---- ffw-item bug:1234567 --->->`',
      '`<!<!<!------ firefox-api-watch:release 161 ----->->->`']) {
      const {aliases, releases} = recordsOf([md(text)]);
      expect(aliases.size + releases.size).toBe(0);
      expect(md(text)).not.toContain('<!--');
    }
  });

  it('breaks up a commit\'s short hash, letters only too, and leaves bug numbers whole', () => {
    expect(md('see feacbcd and Bacfeba1')).not.toMatch(/feacbcd|Bacfeba1/);
    expect(md('Bug 1982177 fixed')).toBe('Bug 1982177 fixed');
  });

  it('links only to Mozilla and MDN over https, and on GitHub only to the specs\' and Mozilla\'s', () => {
    expect(safeUrl('https://bugzil.la/1')).toBe('https://bugzil.la/1');
    expect(safeUrl('http://bugzil.la/1')).toBe('');
    expect(safeUrl('https://evil.example/')).toBe('');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('https://developer.mozilla.org/a_(b)')).toBe('https://developer.mozilla.org/a_%28b%29');
    expect(safeUrl('https://github.com/mdn/content/pull/1')).toBe('https://github.com/mdn/content/pull/1');
    expect(safeUrl('https://github.com/w3c/media-source/issues/2')).toBe('https://github.com/w3c/media-source/issues/2');
    // A link to this repository's issue or commit would put a reference on it.
    expect(safeUrl('https://github.com/someone/FastStream/issues/1')).toBe('');
    expect(safeUrl('https://github.com/someone/FastStream/commit/feacbcd')).toBe('');
    expect(safeUrl('https://github.com/')).toBe('');
  });

  it('reads markers only in their exact form', () => {
    const {aliases, releases} = recordsOf([
      '<!-- ffw-item bug:12 bcd:0123456789ab -->', '<!-- ffw-item bug:x -->', '<!--ffw-item bug:13-->',
      '<!-- firefox-api-watch:release 161 -->', '<!-- firefox-api-watch:release abc -->',
    ]);
    expect([...aliases].sort()).toEqual(['bcd:0123456789ab', 'bug:12']);
    expect([...releases]).toEqual([161]);
  });
});

// ---------------------------------------------------------------------------------------------
// The review issue

describe('the review issue', () => {
  it('A: opens one issue for a release with findings', async () => {
    const gh = fakeGitHub();
    const result = await runWith({github: gh.api});
    expect(gh.writes).toHaveLength(1);
    const [kind, title, body] = gh.writes[0];
    expect(kind).toBe('create');
    expect(title).toBe(`${Prefix}starting with Firefox 161`);
    expect(body).toContain('### Firefox 161 — release review');
    expect(body).toContain('<!-- firefox-api-watch:release 161 -->');
    expect(body).toMatch(/^- \[ \] \*\*Compatibility risk: /m);
    expect(body).not.toMatch(/@[A-Za-z]/);
    expect(result.memo).toBe('161');
    expect(result.failures).toEqual([]);
  });

  it('B: appends a new release to the open issue as a comment, never editing it', async () => {
    const gh = fakeGitHub();
    await runWith({github: gh.api});
    const fetchImpl = sources({current: 162, mdn: {161: notes(161), 162: notes(162)}});
    await runWith({github: gh.api, fetchImpl, today: '2026-12-05'});
    expect(gh.writes.map((w) => w[0])).toEqual(['create', 'comment']);
    expect(gh.writes[1][1]).toBe(100);
    expect(gh.writes[1][2]).toContain('### Firefox 162 — release review');
    expect(gh.writes[1][2]).not.toContain('Firefox 161 — release review');
  });

  it('C: keeps the owner\'s ticks and notes, because it writes only new comments', async () => {
    const gh = fakeGitHub();
    await runWith({github: gh.api});
    const issue = gh.state.issues[0];
    issue.body = issue.body.replace('- [ ]', '- [x]') + '\n\nMy note: checked on Windows.';
    const ticked = issue.body;
    gh.state.comments[100] = [{body: 'Owner comment with - [x] done', user: 'owner'}];
    await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn: {161: notes(161), 162: notes(162)}}), today: '2026-12-05'});
    expect(gh.state.issues[0].body).toBe(ticked);
    expect(gh.state.comments[100][0].body).toBe('Owner comment with - [x] done');
    expect(gh.writes.every((w) => w[0] === 'create' || w[0] === 'comment')).toBe(true);
  });

  it('D: never touches a closed issue, opens a new one for the next release, and repeats nothing', async () => {
    const gh = fakeGitHub();
    await runWith({github: gh.api});
    gh.state.issues[0].state = 'closed';
    // Firefox 162's notes repeat the same bugs as 161's (same numbers): reported, so not again.
    const same = notes(161).replace(/Firefox 161/g, 'Firefox 162');
    await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn: {161: notes(161), 162: same}, bugzilla: () => bugs(161)}), today: '2026-12-05'});
    expect(gh.writes).toHaveLength(1);
    await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn: {161: notes(161), 162: notes(162)}}), today: '2026-12-05'});
    expect(gh.writes.map((w) => w[0])).toEqual(['create', 'create']);
    expect(gh.writes[1][1]).toBe(`${Prefix}starting with Firefox 162`);
    expect(gh.writes[1][2]).not.toContain('Firefox 161 — release review');
  });

  it('E: posts nothing when no change is relevant, and remembers the release as reviewed', async () => {
    const gh = fakeGitHub();
    const empty = '---\ntitle: Firefox 161 release notes for developers (Stable)\n---\n\n## Changes for web developers\n\n- A new `WebTransport` option.\n';
    const fetchImpl = sources({
      mdn: {161: empty}, bugzilla: () => ({webext: {bugs: []}, core: {bugs: []}}), feed: '<rss></rss>',
      tar: tgz('package/data.json', JSON.stringify({__meta: {version: '1'}, browsers: {}, api: {}})),
    });
    const result = await runWith({github: gh.api, fetchImpl});
    expect(gh.writes).toEqual([]);
    expect(result.memo).toBe('161');
    expect(result.summary).toEqual(['Firefox 161: reviewed, nothing new (1 change(s) checked, none relevant).']);
  });

  it('catches up several missed releases in version order: one issue, then a comment each', async () => {
    const gh = fakeGitHub();
    const mdn = {161: notes(161), 162: notes(162), 163: notes(163)};
    await runWith({github: gh.api, fetchImpl: sources({current: 163, mdn}), today: '2026-12-19'});
    expect(gh.writes.map((w) => `${w[0]} ${String(w[2]).match(/### Firefox (\d+)/)?.[1]}`)).toEqual(['create 161', 'comment 162', 'comment 163']);
  });

  it('repeated runs post nothing twice', async () => {
    const gh = fakeGitHub();
    await runWith({github: gh.api});
    const again = await runWith({github: gh.api});
    expect(gh.writes).toHaveLength(1);
    expect(again.summary.join('\n')).toMatch(/Firefox 161: reviewed, nothing new \(\d+ change\(s\) checked, \d+ relevant, all reported before\)/);
  });

  it('stops after the version check when the current release was reviewed already', async () => {
    const log = /** @type {string[]} */ ([]);
    const result = await runWith({github: fakeGitHub().api, memo: '161', fetchImpl: sources({log})});
    expect(log).toEqual([Urls.versions, Urls.majors]);
    expect(result.summary[0]).toMatch(/reviewed already/);
  });

  it('stale state: an issue closed since it was listed is left alone, and the oldest of two open ones is used', async () => {
    const gh = fakeGitHub([
      {number: 5, title: `${Prefix}starting with Firefox 158`, body: 'old'},
      {number: 9, title: `${Prefix}starting with Firefox 160`, body: 'newer'},
    ]);
    gh.state.closedMeanwhile.add(5);
    await runWith({github: gh.api});
    expect(gh.writes.map((w) => [w[0], w[1]])).toEqual([['comment', 9]]);
  });

  it('ignores issues and comments that are not the watcher\'s own, and markers that are not exact', async () => {
    const posted = fakeGitHub();
    await runWith({github: posted.api});
    const body = posted.writes[0][2];
    const gh = fakeGitHub([
      // Someone else's issue with the same title and the real markers: not a record.
      {number: 3, title: `${Prefix}starting with Firefox 161`, body, user: 'someone', state: 'closed'},
      // The bot's issue with another title: not the watcher's.
      {number: 4, title: 'Firefox stable breaks FastStream', body, state: 'closed'},
      // The watcher's issue, its markers broken, plus an owner comment holding real markers.
      {number: 6, title: `${Prefix}starting with Firefox 158`, body: body.replace(/<!-- ffw-item /g, '<!-- ffw-itm '), state: 'closed'},
    ], {6: [{body, user: 'owner'}]});
    await runWith({github: gh.api});
    expect(gh.writes.map((w) => w[0])).toEqual(['create']);
  });

  it('a release whose notes are not published yet waits, then is reviewed from the other sources', async () => {
    const gh = fakeGitHub();
    const waiting = await runWith({github: gh.api, fetchImpl: sources({mdn: {}}), today: '2026-11-22'});
    expect(gh.writes).toEqual([]);
    expect(waiting.failures).toEqual([]);
    expect(waiting.memo).toBe('');
    expect(waiting.summary[0]).toMatch(/Firefox 161: not reviewed yet \(MDN has no notes/);
    // Past the grace days MDN may never write them: the compatibility data, Bugzilla and the blog
    // are reviewed without them, and no later release waits behind this one.
    const late = await runWith({github: gh.api, fetchImpl: sources({mdn: {}}), today: '2026-12-05'});
    expect(late.failures).toEqual([]);
    expect(late.memo).toBe('161');
    expect(gh.writes[0][2]).toContain('MDN had no notes for developers 10 days after the release');
    expect(gh.writes[0][2]).toContain('decodingInfo');
    expect(gh.writes[0][2]).not.toContain('so a worker can feed video');
  });

  it('fails the run for a source that stays down only while the newest release waits for it', async () => {
    const gh = fakeGitHub();
    const mdn = {161: notes(161), 162: notes(162)};
    // 161's Bugzilla query times out 16 days after 161; 162 (the newest) is 2 days old.
    const for161 = `${Urls.bugzilla}?product=WebExtensions&resolution=FIXED&f1=cf_status_firefox161&`;
    const older = await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn, status: {[for161]: 503}}), today: '2026-12-06'});
    expect(older.failures).toEqual([]);
    // Bugzilla, or the blog feed every release reads, down 11 days after 162.
    for (const down of [Urls.bugzilla, Urls.feed]) {
      const newest = await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn, status: {[down]: 503}}), today: '2026-12-15'});
      expect(newest.failures).toHaveLength(1);
      expect(newest.failures[0]).toMatch(/^Firefox 162 \(released 2026-12-04\) could not be reviewed for more than 10 days/);
    }
  });

  it('keeps the sections in version order: a release not posted yet holds back the ones after it', async () => {
    const gh = fakeGitHub();
    const mdn = {161: notes(161), 162: notes(162)};
    const for161 = `${Urls.bugzilla}?product=WebExtensions&resolution=FIXED&f1=cf_status_firefox161&`;
    const first = await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn, status: {[for161]: 503}}), today: '2026-12-06'});
    expect(gh.writes).toEqual([]);
    expect(first.summary.join('\n')).toContain('Firefox 162: reviewed, waits for Firefox 161');
    await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn}), today: '2026-12-06'});
    expect(gh.writes.map((w) => String(w[2]).match(/### Firefox (\d+)/)?.[1])).toEqual(['161', '162']);
    // Once 161 is posted, an outage of its query no longer holds 162's later additions back.
    const more = {...mdn, 162: notes(162, {extra: '- {{WebExtAPIRef("tabs.query()")}} takes a new option. ([Firefox bug 162050](https://bugzil.la/162050))\n'})};
    await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn: more, status: {[for161]: 503}}), today: '2026-12-07'});
    expect(gh.writes[2][2]).toContain('### Firefox 162 — added after its first review');
  });

  it('opens one issue per run even when GitHub\'s list of issues lags behind', async () => {
    const gh = fakeGitHub();
    gh.state.listLags = true;
    await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn: {161: notes(161), 162: notes(162)}}), today: '2026-12-06'});
    expect(gh.writes.map((w) => w[0])).toEqual(['create', 'comment']);
  });

  it('reports a later change to a feature it reported, though its bug was reported', async () => {
    const gh = fakeGitHub();
    await runWith({github: gh.api});
    expect(gh.writes[0][2]).toContain('canConstructInDedicatedWorker');
    // In 162 the feature is taken out again; 162's notes say nothing about it.
    const data = structuredClone(bcdData);
    data.api.MediaSource.canConstructInDedicatedWorker_static.__compat.support.firefox.version_removed = '162';
    const tar = tgz('package/data.json', JSON.stringify(data));
    const bare = '---\ntitle: Firefox 162 release notes for developers (Stable)\n---\n\n## Changes for web developers\n';
    await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn: {161: notes(161), 162: bare}, tar}), today: '2026-12-06'});
    const section162 = gh.writes.find((w) => String(w[2]).includes('### Firefox 162'));
    expect(section162?.[2]).toContain('`MediaSource.canConstructInDedicatedWorker_static` removed');
  });

  it('notes still marked a work in progress wait, then are reviewed after the grace days', async () => {
    const gh = fakeGitHub();
    await runWith({github: gh.api, fetchImpl: sources({mdn: {161: notes(161, {wip: true})}})});
    expect(gh.writes).toEqual([]);
    await runWith({github: gh.api, fetchImpl: sources({mdn: {161: notes(161, {wip: true})}}), today: '2026-12-05'});
    expect(gh.writes[0][2]).toContain('work in progress');
  });

  it('a source that is down leaves the release for the next run; one that answers wrongly fails the run', async () => {
    const gh = fakeGitHub();
    const down = await runWith({github: gh.api, fetchImpl: sources({status: {[Urls.bugzilla]: 503}})});
    expect(gh.writes).toEqual([]);
    expect(down.failures).toEqual([]);
    expect(down.memo).toBe('');
    const versions = await runWith({github: gh.api, fetchImpl: sources({status: {[Urls.versions]: 503}})});
    expect(versions).toMatchObject({failures: [], posted: []});
    const wrong = await runWith({github: gh.api, fetchImpl: sources({integrity: 'sha512-AAAA'})});
    expect(wrong.failures[0]).toMatch(/integrity mismatch/);
    expect(gh.writes).toEqual([]);
  });

  it('recovers after a partial failure: what was posted stays, the rest follows next run', async () => {
    const gh = fakeGitHub();
    gh.state.failCommentAfter = 0;
    const mdn = {161: notes(161), 162: notes(162)};
    await expect(runWith({github: gh.api, fetchImpl: sources({current: 162, mdn}), today: '2026-12-05'})).rejects.toThrow('HTTP 502');
    expect(gh.writes.map((w) => w[0])).toEqual(['create']);
    gh.state.failCommentAfter = Infinity;
    await runWith({github: gh.api, fetchImpl: sources({current: 162, mdn}), today: '2026-12-05'});
    expect(gh.writes.map((w) => `${w[0]} ${String(w[2]).match(/### Firefox (\d+)/)?.[1]}`)).toEqual(['create 161', 'comment 162']);
  });

  it('a change Mozilla adds to a release later comes as a further section', async () => {
    const gh = fakeGitHub();
    await runWith({github: gh.api});
    const extra = '- {{WebExtAPIRef("tabs.connect()")}} takes a `documentId`, previously ignored. ([Firefox bug 161099](https://bugzil.la/161099))\n';
    await runWith({github: gh.api, fetchImpl: sources({mdn: {161: notes(161, {extra})}})});
    expect(gh.writes.map((w) => w[0])).toEqual(['create', 'comment']);
    expect(gh.writes[1][2]).toContain('### Firefox 161 — added after its first review');
    expect(gh.writes[1][2]).toContain('tabs.connect');
    expect(gh.writes[1][2]).not.toContain('canConstructInDedicatedWorker');
  });

  it('a dry run reads but writes nothing', async () => {
    const gh = fakeGitHub();
    const lines = /** @type {string[]} */ ([]);
    const result = await runWith({github: gh.api, dryRun: true, log: (l) => lines.push(l)});
    expect(gh.writes).toEqual([]);
    expect(result.posted).toHaveLength(1);
    expect(lines[0]).toContain('### Firefox 161');
  });

  it('waits for the first release it watches', async () => {
    const result = await runWith({github: fakeGitHub().api, fetchImpl: sources({current: 160})});
    expect(result.summary[0]).toMatch(/starts with Firefox 161/);
  });
});

// ---------------------------------------------------------------------------------------------
// GitHub and the command line

describe('the gh client', () => {
  it('pages through issues, leaves pull requests out and posts through stdin', async () => {
    /** @type {{args: string[], input?: string}[]} */
    const calls = [];
    const page = (/** @type {number} */ n, /** @type {number} */ count) => Array.from({length: count}, (_, i) => ({
      number: n * 100 + i, state: 'open', title: 't', body: null, user: {login: Bot}, ...(i === 0 ? {pull_request: {}} : {}),
    }));
    const gh = ghClient('owner/repo', (args, input) => {
      calls.push({args, input});
      if (args[1] === '--method') return JSON.stringify({number: 7});
      return JSON.stringify(args[1].endsWith('&page=1') ? page(1, 100) : args[1].endsWith('&page=2') ? page(2, 3) : []);
    });
    const issues = await gh.listIssues();
    expect(issues).toHaveLength(101);
    expect(calls[0].args[1]).toBe('repos/owner/repo/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100&page=1');
    expect(await gh.createIssue('T', 'B')).toBe(7);
    expect(calls.at(-1)).toEqual({args: ['api', '--method', 'POST', 'repos/owner/repo/issues', '--input', '-'], input: '{"title":"T","body":"B"}'});
    expect(() => ghClient('not a repo')).toThrow();
  });
});

describe('the command line', () => {
  it('takes only known arguments and versions that are numbers', () => {
    expect(parseArgs(['--dry-run', '--from', '158', '--to', '160'])).toEqual({dryRun: true, noGithub: false, from: 158, to: 160, memoDir: ''});
    expect(parseArgs(['--no-github'])).toMatchObject({dryRun: true, noGithub: true});
    expect(() => parseArgs(['--from', '15; rm -rf /'])).toThrow();
    expect(() => parseArgs(['--to', '160'])).toThrow();
    expect(() => parseArgs(['--force'])).toThrow();
  });
});
