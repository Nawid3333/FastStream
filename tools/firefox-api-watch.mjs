#!/usr/bin/env node
// @ts-check
// Firefox API watch: what each new Firefox Stable release changed that could break or improve
// FastStream, collected in one review issue (.github/workflows/firefox-api-watch.yml).
//
// Sources, all machine-readable and Mozilla's own:
//   - product-details: the current Stable version and each major release's date;
//   - MDN's release notes for developers (the markdown source in mdn/content);
//   - @mdn/browser-compat-data (BCD): features whose Firefox support starts or ends in a release;
//   - Bugzilla: WebExtensions bugs fixed in the release, and a few Core media/network ones;
//   - the add-ons blog's feed: posts that name the release.
// What is relevant: tools/firefox-api-watch.topics.mjs, plus what the extension's own code uses
// (its chrome.*/browser.* namespaces, manifest keys, and any identifier of a change found in a
// tracked file under chrome/).
//
// The review issue, "Firefox API Watch: starting with Firefox N":
//   - no open one and something new: one is opened, the first release in its body, any further
//     release as a comment, in version order;
//   - one open: each new release is a comment on it;
//   - the watcher never edits or deletes what it posted, so the owner's ticks and notes stay;
//   - a closed one is never touched: closing it means "reviewed". What it lists still counts as
//     reported, so the next issue starts with what came after;
//   - nothing new in a release: no issue, no comment; the run's summary says so.
// What was reported is read back from hidden markers in the bot's own posts, open and closed
// issues alike (`<!-- ffw-item ... -->`), never from a file in the repository: a push to main
// releases. A finding counts as reported when any of its keys (bug, BCD feature, note) is.
//
// Run by hand: `node tools/firefox-api-watch.mjs --dry-run --no-github --from 158 --to 160`
// prints what it would post, reading nothing from GitHub.

import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

import Topics from './firefox-api-watch.topics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const Prefix = 'Firefox API Watch: ';
export const Bot = 'github-actions[bot]';
/** The first release the watcher reports by itself; older ones are reviewed by hand with --from. */
export const DefaultStart = 161;
/** Releases looked at in one run: the current Stable and the ones before it. */
export const DefaultLookback = 3;
/** Days after a release its notes may still be missing before the run fails. */
export const GraceDays = 10;
/** A post's largest size; GitHub's limit is 65536 characters. */
export const MaxPost = 60000;

export const Urls = {
  versions: 'https://product-details.mozilla.org/1.0/firefox_versions.json',
  majors: 'https://product-details.mozilla.org/1.0/firefox_history_major_releases.json',
  mdn: (/** @type {number} */ version) =>
    `https://raw.githubusercontent.com/mdn/content/main/files/en-us/mozilla/firefox/releases/${Math.trunc(version)}/index.md`,
  bcd: 'https://registry.npmjs.org/@mdn/browser-compat-data/latest',
  bugzilla: 'https://bugzilla.mozilla.org/rest/bug',
  feed: 'https://blog.mozilla.org/addons/feed/',
};

/** Hosts a link in a post may point to; any other link is left out. */
export const LinkHosts = new Set(['developer.mozilla.org', 'bugzilla.mozilla.org', 'bugzil.la', 'blog.mozilla.org',
  'www.mozilla.org', 'www.firefox.com', 'github.com', 'whattrainisitnow.com', 'firefox-source-docs.mozilla.org']);
/** The most bugs asked of Bugzilla per query; an answer this long fails the run (cut short). */
export const BugzillaLimit = 1000;
/** The only owners a github.com link may point to. */
export const GitHubOwners = new Set(['mdn', 'mozilla', 'mozilla-firefox', 'w3c', 'whatwg', 'tc39', 'webassembly']);

/**
 * @typedef {'Compatibility risk'|'Security change'|'Optimisation opportunity'|'New feature'|'Bug fix'} Kind
 * @typedef {'high'|'medium'|'low'} Level
 * @typedef {{label: string, url: string}} Link
 * @typedef {{
 *   source: 'mdn'|'bcd'|'bugzilla'|'blog',
 *   title: string,
 *   detail: string,
 *   section: string,
 *   bugs: number[],
 *   bcd: string[],
 *   links: Link[],
 *   identifiers: string[],
 *   textKey: string,
 *   experimental: boolean,
 *   removal: boolean,
 *   flagged: boolean,
 * }} RawItem
 *   title/detail are plain text with `code` spans (unsafe until md() renders them).
 * @typedef {{
 *   title: string, detail: string, sources: string[], aliases: string[], mergeKeys: string[], areas: string[],
 *   kind: Kind, priority: Level, confidence: Level, files: string[], used: string[], modules: string[],
 *   links: Link[], experimental: boolean, members: string[][],
 * }} Finding
 *   members: each merged item's own keys (its bugs and BCD change, else its text's): a finding
 *   with an item that has a key not reported before is news, even when it merged with items
 *   that were reported. A note reworded under the same bug is not.
 * @typedef {{id: string, area: string, priority: Level, kind: Kind, keywords: RegExp[], bcd: string[], modules: string[]}} Topic
 * @typedef {{topics: Topic[], bugzilla: {coreComponents: string[], coreKeywords: string[], coreSummary: RegExp,
 *   excludeSummary: RegExp}, excludeText: RegExp, stopIdentifiers: string[]}} Config
 *   The patterns are RegExp literals (firefox-api-watch.topics.mjs), without the g flag: test()
 *   keeps no state between calls.
 * @typedef {{version: number, date: string, complete: boolean, reason: string, wip: boolean, checked: number,
 *   findings: Finding[], noNotes?: boolean}} Review
 * @typedef {{number: number, state: string, title: string, body: string, user: string}} Issue
 * @typedef {{
 *   listIssues: () => Promise<Issue[]>,
 *   listComments: (issue: number) => Promise<{body: string, user: string}[]>,
 *   getIssue: (issue: number) => Promise<Issue>,
 *   createIssue: (title: string, body: string) => Promise<number>,
 *   comment: (issue: number, body: string) => Promise<void>,
 * }} GitHub
 */

// ---------------------------------------------------------------------------------------------
// Fetching

/** A source that could not be read. outage: no answer, a 5xx, 408 or 429 (try again later). */
export class SourceError extends Error {
  /**
   * @param {string} message
   * @param {boolean} outage
   */
  constructor(message, outage) {
    super(message);
    this.outage = outage;
  }
}

/**
 * @typedef {{fetchImpl?: typeof fetch, wait?: (ms: number) => Promise<void>}} FetchOptions
 */

/** The only hosts the watcher asks anything of: the sources above, over https. */
export const SourceHosts = new Set(['product-details.mozilla.org', 'raw.githubusercontent.com', 'registry.npmjs.org',
  'bugzilla.mozilla.org', 'blog.mozilla.org']);

/**
 * A URL's body, asked up to three times when the server does not answer or answers 5xx, 408 or
 * 429. A 404 is returned (the caller decides whether that is a failure); any other 4xx throws at
 * once. Only https URLs on the sources' hosts (SourceHosts) are asked for.
 * @param {string} url
 * @param {FetchOptions & {binary?: boolean}} [options]
 * @return {Promise<{status: number, text: string, bytes: Uint8Array}>}
 */
export async function getUrl(url, {fetchImpl = fetch, wait = defaultWait, binary = false} = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourceError(`not a URL: ${url.slice(0, 80)}`, false);
  }
  if (parsed.protocol !== 'https:' || !SourceHosts.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
    throw new SourceError(`not a source the watcher reads: ${parsed.origin}`, false);
  }
  for (let attempt = 1; ; attempt++) {
    /** @type {string} */
    let problem;
    let outage = true;
    try {
      const response = await fetchImpl(url, {
        headers: {'user-agent': 'faststream-firefox-api-watch'},
        signal: AbortSignal.timeout(60 * 1000),
      });
      if (response.ok || response.status === 404) {
        if (binary) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return {status: response.status, text: '', bytes};
        }
        return {status: response.status, text: await response.text(), bytes: new Uint8Array()};
      }
      problem = `HTTP ${response.status}`;
      outage = response.status >= 500 || response.status === 408 || response.status === 429;
    } catch (caught) {
      problem = /** @type {Error} */ (caught).message || String(caught);
    }
    if (!outage) throw new SourceError(`${url}: ${problem}`, false);
    if (attempt === 3) throw new SourceError(`${url}: ${problem} (3 tries)`, true);
    await wait(attempt * 5000);
  }
}

/** @param {number} ms */
function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} url
 * @param {FetchOptions} [options]
 * @return {Promise<any>}
 */
async function getJson(url, options) {
  const {status, text} = await getUrl(url, options);
  if (status === 404) throw new SourceError(`${url}: HTTP 404`, false);
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError(`${url}: not JSON`, false);
  }
}

/**
 * The current Stable major version and each major release's date.
 * @param {FetchOptions} [options]
 * @return {Promise<{current: number, dates: Map<number, string>}>}
 */
export async function productDetails(options = {}) {
  const urls = Urls;
  const versions = await getJson(urls.versions, options);
  const latest = String(versions?.LATEST_FIREFOX_VERSION ?? '');
  const match = /^(\d{2,4})\.\d+(\.\d+)*$/.exec(latest);
  if (!match) throw new SourceError(`${urls.versions}: unexpected LATEST_FIREFOX_VERSION "${latest.slice(0, 40)}"`, false);
  const current = Number(match[1]);
  const majors = await getJson(urls.majors, options);
  /** @type {Map<number, string>} */
  const dates = new Map();
  for (const [version, date] of Object.entries(majors ?? {})) {
    const m = /^(\d+)\.0$/.exec(version);
    if (m && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) dates.set(Number(m[1]), date);
  }
  const last = String(versions?.LAST_RELEASE_DATE ?? '');
  if (!dates.has(current) && /^\d{4}-\d{2}-\d{2}$/.test(last)) dates.set(current, last);
  return {current, dates};
}

/**
 * The newest browser-compat-data: its version and data. The tarball's integrity is checked
 * against the registry's sha512 before it is read.
 * @param {FetchOptions & {fixtures?: string}} [options] - fixtures: a folder (from tempFolder)
 *   whose bcd.json stands in for the package's data (the workflow test).
 * @return {Promise<{version: string, data: any}>}
 */
export async function loadBcd({fixtures = '', ...options} = {}) {
  if (fixtures) {
    const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'bcd.json'), 'utf8'));
    return {version: String(data?.__meta?.version ?? 'fixture'), data};
  }
  const meta = await getJson(Urls.bcd, options);
  const integrity = String(meta?.dist?.integrity ?? '');
  // The registry's own address for the package's file and nothing else: the URL is made here
  // from the file's name, not taken as the answer gives it.
  const file = /^https:\/\/registry\.npmjs\.org\/@mdn\/browser-compat-data\/-\/(browser-compat-data-\d+\.\d+\.\d+\.tgz)$/
      .exec(String(meta?.dist?.tarball ?? ''))?.[1];
  if (!file || !integrity.startsWith('sha512-')) {
    throw new SourceError(`${Urls.bcd}: no tarball or integrity`, false);
  }
  const tarball = 'https://registry.npmjs.org/@mdn/browser-compat-data/-/' + file;
  const {bytes} = await getUrl(tarball, {...options, binary: true});
  const digest = 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
  if (digest !== integrity) throw new SourceError(`${tarball}: integrity mismatch`, false);
  const json = readTarFile(zlib.gunzipSync(bytes), 'package/data.json');
  if (json === null) throw new SourceError(`${tarball}: no package/data.json`, false);
  return {version: String(meta.version ?? ''), data: JSON.parse(json)};
}

/**
 * One file of an (uncompressed) tar archive, or null.
 * @param {Uint8Array} tar
 * @param {string} name
 * @return {string|null}
 */
export function readTarFile(tar, name) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) return null;
    const field = (/** @type {number} */ start, /** @type {number} */ length) =>
      Buffer.from(header.subarray(start, start + length)).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const entry = (prefix ? prefix + '/' : '') + field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const start = offset + 512;
    if (entry === name) return Buffer.from(tar.subarray(start, start + size)).toString('utf8');
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Parsing the sources

/**
 * A text as a regular expression matching just it.
 * @param {string} text
 * @return {string}
 */
export function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Text without its HTML comments (`<!-- ... -->`, also ended by `--!>`), as a browser shows it:
 * removed until none is left (one pass left "<!<!-- a -->-- b -->" as a comment of its own), and
 * an unclosed one hides the rest.
 * @param {string} text
 * @return {string}
 */
export function stripComments(text) {
  let out = text;
  for (let before = ''; before !== out;) {
    before = out;
    out = out.replace(/<!--[\s\S]*?--!?>/g, '');
  }
  const open = out.indexOf('<!--');
  return open === -1 ? out : out.slice(0, open);
}

/**
 * MDN's inline markup as plain text with `code` spans: macros become the name they show, links
 * their text (an allowed link is kept apart), bold and HTML comments go.
 * @param {string} text
 * @return {{text: string, identifiers: string[], links: Link[], bugs: number[]}}
 */
export function mdnInline(text) {
  /** @type {string[]} */
  const identifiers = [];
  /** @type {Link[]} */
  const links = [];
  /** @type {number[]} */
  const bugs = [];
  let out = stripComments(text);
  // Arguments may hold parentheses inside their quotes: {{WebExtAPIRef("publicSuffix.isKnownSuffix()")}}.
  out = out.replace(/\{\{\s*([A-Za-z_]+)\s*(?:\(((?:[^()"']|"[^"]*"|'[^']*')*)\))?\s*\}\}/g, (_, macro, rawArgs = '') => {
    const args = splitArgs(rawArgs);
    const name = String(macro).toLowerCase();
    const first = (args[0] ?? '').replace(/\//g, '.').replace(/\(\)$/, '');
    const shown = args[1] && !/^#/.test(args[1]) && name !== 'htmlelement' ? args[1] : first;
    if (!first) return '';
    if (name === 'htmlelement') return '`<' + first + '>`';
    if (['domxref', 'jsxref', 'webextapiref', 'cssxref', 'httpheader', 'httpmethod', 'httpstatus', 'svgelement', 'svgattr',
      'htmlattrxref', 'glossary'].includes(name)) {
      identifiers.push(first);
      return name === 'glossary' ? shown : '`' + shown + '`';
    }
    return shown;
  });
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const absolute = String(url).startsWith('/') ? 'https://developer.mozilla.org' + url : String(url);
    const bug = /^https:\/\/(?:bugzil\.la\/|bugzilla\.mozilla\.org\/show_bug\.cgi\?id=)(\d{1,8})$/.exec(absolute);
    if (bug) {
      bugs.push(Number(bug[1]));
      return BugMark;
    }
    const safe = safeUrl(absolute);
    if (safe) links.push({label: plainLabel(label), url: safe});
    return label;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  for (const code of out.matchAll(/`([^`]+)`/g)) identifiers.push(code[1].replace(/\(\)$/, ''));
  // "([Firefox bug 1](...), [Firefox bug 2](...))" leaves "(<mark>, <mark>)": that goes, a call's "()" stays.
  out = out.replace(new RegExp(`\\(\\s*${BugMark}[\\s,${BugMark}]*\\)`, 'g'), '').replaceAll(BugMark, '')
      .replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').replace(/(?<!\.)\.\.(?!\.)/g, '.').trim();
  return {text: out, identifiers, links, bugs};
}

/** Stands where a bug link was, until the "(...)" around such links is removed. */
const BugMark = String.fromCharCode(0xe000);

/** @param {string} raw */
function splitArgs(raw) {
  /** @type {string[]} */
  const args = [];
  let current = '';
  let quote = '';
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
    } else if (ch === '"' || ch === '\'') {
      quote = ch;
    } else if (ch === ',') {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  args.push(current.trim());
  return args;
}

/** @param {string} label */
function plainLabel(label) {
  return label.replace(/[`*[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'link';
}

/**
 * A release's notes for developers: its date, whether MDN still calls them a work in progress,
 * and one item per bullet, with the section it is in.
 * @param {string} markdown
 * @param {number} version
 * @return {{wip: boolean, beta: boolean, items: RawItem[]}}
 */
export function parseMdnNotes(markdown, version) {
  const text = stripComments(markdown.replace(/\r\n/g, '\n'));
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const beta = !!front && /\(Beta\)|\(Nightly\)/.test(front[1]);
  const wip = /still a work in progress/i.test(text);
  const body = front ? text.slice(front[0].length) : text;
  /** @type {RawItem[]} */
  const items = [];
  /** @type {string[]} */
  const headings = [];
  /** @type {string[]|null} */
  let bullet = null;
  const flush = () => {
    if (!bullet) return;
    const lines = bullet;
    bullet = null;
    const section = headings.filter(Boolean).join(' › ');
    const inline = mdnInline(lines.join(' '));
    if (!inline.text) return;
    // "- **Lazy loading for video**: `pref`" over a paragraph: the name is the title.
    const named = /^\*\*[^*]+\*\*/.test(lines[0]) && lines.length > 1;
    const title = named ? mdnInline(lines[0]).text : firstSentence(inline.text);
    const detail = named ? mdnInline(lines.slice(1).join(' ')).text : inline.text === title ? '' : inline.text;
    const experimental = /experimental/i.test(section);
    const removal = /removal/i.test(section) || /\b(no longer (supported|available|dispatched)|(has|have) been removed|is removed|are removed|deprecated)\b/i.test(inline.text);
    items.push({
      source: 'mdn', title, detail, section,
      bugs: [...new Set(inline.bugs)], bcd: [], links: inline.links, identifiers: inline.identifiers,
      textKey: 'mdn:' + hash(`${version}|${normalise(inline.text)}`), experimental, removal, flagged: false,
    });
  };
  for (const line of body.split('\n')) {
    const heading = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length - 2;
      headings.length = level;
      headings[level] = heading[2].replace(/[`*]/g, '');
      continue;
    }
    if (/^- /.test(line)) {
      flush();
      bullet = [line.slice(2)];
      continue;
    }
    if (bullet && (/^\s{2,}\S/.test(line) || line.trim() === '')) {
      if (line.trim()) bullet.push(line.trim());
      continue;
    }
    if (line.trim()) flush();
  }
  flush();
  return {wip, beta, items};
}

/** @param {string} text */
function firstSentence(text) {
  const cut = /^(.{20,}?[.!?])(\s|$)/.exec(text);
  const sentence = cut ? cut[1] : text;
  return sentence.length > 160 ? sentence.slice(0, 157).replace(/\s+\S*$/, '') + '…' : sentence;
}

/** @param {string} text */
function normalise(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** @param {string} text */
export function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Features whose Firefox support starts (without a preference) or ends in the release, under
 * the given path prefixes.
 * @param {any} data - BCD's data.json.
 * @param {number} version
 * @param {(path: string) => boolean} wanted - Whether a feature path is worth reporting.
 * @return {RawItem[]}
 */
export function bcdChanges(data, version, wanted) {
  const v = String(version);
  /** @type {RawItem[]} */
  const items = [];
  /**
   * @param {any} node
   * @param {string} at
   */
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === '__compat') {
        if (!wanted(at)) continue;
        const support = /** @type {any} */ (child)?.support?.firefox;
        const statements = (Array.isArray(support) ? support : [support]).filter(
            (s) => s && typeof s === 'object' && !s.prefix && !s.alternative_name);
        const plain = statements.filter((s) => !s.flags);
        const added = plain.find((s) => s.version_added === v);
        const earlier = plain.some((s) => s !== added && typeof s.version_added === 'string' &&
          /^\d+(\.\d+)?$/.test(s.version_added) && Number(s.version_added) < version && !s.version_removed);
        const removed = plain.find((s) => s.version_removed === v);
        if (!added && !removed) continue;
        const bugs = statements.flatMap((s) => [s.impl_url].flat())
            .map((u) => /(?:bugzil\.la\/|show_bug\.cgi\?id=)(\d{1,8})/.exec(String(u ?? '')))
            .filter((m) => m !== null).map((m) => Number(/** @type {RegExpExecArray} */ (m)[1]));
        const name = at.replace(/^(api|webextensions\.api|webextensions\.manifest|javascript\.builtins)\./, '');
        const mdnUrl = safeUrl(String(/** @type {any} */ (child)?.mdn_url ?? ''));
        const partial = added?.partial_implementation ? ' (partly)' : '';
        const title = removed && !added ? `\`${name}\` removed` :
          earlier ? `\`${name}\` support changed${partial}` : `\`${name}\` supported${partial}`;
        items.push({
          source: 'bcd', title, detail: '', section: at.split('.')[0], bugs: [...new Set(bugs)], bcd: [at],
          links: mdnUrl ? [{label: 'MDN', url: mdnUrl}] : [], identifiers: identifiersOfPath(at),
          textKey: `bcd:${hash(`${at}|${version}|${removed && !added ? 'removed' : 'added'}`)}`,
          experimental: false, removal: !!removed && !added, flagged: false,
        });
      } else if (!key.startsWith('__')) {
        walk(child, at ? `${at}.${key}` : key);
      }
    }
  };
  for (const [category, node] of Object.entries(data ?? {})) {
    if (category === 'browsers' || category.startsWith('__')) continue;
    walk(node, category);
  }
  return items;
}

/**
 * The names in a BCD path that code would contain: for WebExtensions `tabs.sendMessage` and the
 * member after it; for web APIs the interface and its member.
 * @param {string} at
 * @return {string[]}
 */
export function identifiersOfPath(at) {
  const parts = at.split('.');
  if (parts[0] === 'webextensions' && parts[1] === 'api') {
    const [ns, member, ...rest] = parts.slice(2);
    return [member ? `${ns}.${member}` : ns, ...rest.filter((p) => !['details', 'options', 'connectInfo', 'InjectionTarget',
      'InjectionResult'].includes(p))];
  }
  if (parts[0] === 'webextensions' && parts[1] === 'manifest') return parts.slice(2);
  if (parts[0] === 'api') {
    // A member's change is about Interface.member, not every use of the interface; an event entry
    // (enterpictureinpicture_event) is about the event's name.
    if (parts.length === 2) return [parts[1]];
    const member = parts[2].endsWith('_event') ? [parts[2].slice(0, -6)] : [];
    return [`${parts[1]}.${parts[2].replace(/_event$/, '')}`, ...member, ...parts.slice(3)];
  }
  return parts.slice(-1);
}

/**
 * Names in outside text that code could contain: dotted ones (`mediaCapabilities.decodingInfo()`)
 * and interface names (MediaSource, VideoDecoder).
 * @param {string} text
 * @return {string[]}
 */
export function namesIn(text) {
  const dotted = [...text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g)].map((m) => m[1].replace(/^(?:browser|chrome)\./, ''));
  const camel = [...text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z0-9]+)+)\b/g)].map((m) => m[1]);
  return [...new Set([...dotted, ...camel])];
}

/**
 * @param {any} json - Bugzilla's /rest/bug answer.
 * @param {Config['bugzilla']} config
 * @param {Set<string>} namespaces - The WebExtensions namespaces the code uses.
 * @return {RawItem[]}
 */
export function bugzillaItems(json, config, namespaces) {
  const exclude = config.excludeSummary;
  const coreSummary = config.coreSummary;
  /** @type {RawItem[]} */
  const items = [];
  for (const bug of Array.isArray(json?.bugs) ? json.bugs : []) {
    const id = Number(bug?.id);
    const summary = String(bug?.summary ?? '').replace(/\s+/g, ' ').trim();
    if (!Number.isInteger(id) || !summary || exclude.test(summary)) continue;
    const product = String(bug?.product ?? '');
    const component = String(bug?.component ?? '');
    /** @type {string[]} */
    const keywords = Array.isArray(bug?.keywords) ? bug.keywords.map(String) : [];
    const flagged = keywords.some((k) => config.coreKeywords.includes(k));
    if (product !== 'WebExtensions' && !flagged && !coreSummary.test(summary)) continue;
    const identifiers = namesIn(summary);
    const ns = identifiers.map((n) => n.split('.')[0]).filter((n) => namespaces.has(n));
    items.push({
      source: 'bugzilla', title: `Bug ${id}: ${summary}`, detail: '', section: `${product}: ${component}`, bugs: [id],
      bcd: [], links: [], identifiers, textKey: '', experimental: false,
      removal: /^(remove|drop|deprecate)\b/i.test(summary), flagged: flagged || ns.length > 0,
    });
  }
  return items;
}

/**
 * The add-ons blog posts that name the release ("Firefox 153 WebExtensions API updates").
 * @param {string} xml
 * @param {number} version
 * @return {RawItem[]}
 */
export function feedItems(xml, version) {
  /** @type {RawItem[]} */
  const items = [];
  const named = new RegExp(`\\bFirefox\\s+${version}\\b`);
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(match[1])?.[1] ?? '');
    const link = decodeXml(/<link>([\s\S]*?)<\/link>/.exec(match[1])?.[1] ?? '').trim();
    if (!named.test(title)) continue;
    const url = safeUrl(link);
    items.push({
      source: 'blog', title: `Add-ons blog: ${title}`, detail: '', section: 'Add-ons blog', bugs: [], bcd: [],
      links: url ? [{label: 'Blog post', url}] : [], identifiers: [], textKey: 'blog:' + hash(link || title),
      experimental: false, removal: false, flagged: true,
    });
  }
  return items;
}

/** @param {string} text */
function decodeXml(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, '\'')
      .replace(/&amp;/g, '&').trim();
}

// ---------------------------------------------------------------------------------------------
// What FastStream uses

/**
 * @typedef {{files: Map<string, string>, namespaces: Set<string>, manifestKeys: Set<string>, permissions: Set<string>,
 *   known: {namespaces: Set<string>, manifestKeys: Set<string>}}} CodeIndex
 *   known: every WebExtensions namespace and manifest key there is (from BCD), to tell a note
 *   about an API the extension does not use from a general one.
 */

/**
 * The tracked files under chrome/ (vendored copies are gitignored, so they are not read), the
 * WebExtensions namespaces their code calls, the manifest's keys and permissions.
 * @param {{files?: Map<string, string>}} [options]
 * @return {CodeIndex}
 */
export function codeIndex({files} = {}) {
  if (!files) {
    files = new Map();
    for (const file of trackedChromeFiles()) {
      if (!/\.(m?js|html|css|json)$/.test(file) || file.startsWith('chrome/_locales/')) continue;
      files.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
    }
  }
  /** @type {Set<string>} */
  const namespaces = new Set();
  for (const text of files.values()) {
    for (const m of text.matchAll(/\b(?:chrome|browser)\.([a-zA-Z]+)\./g)) namespaces.add(m[1]);
  }
  /** @type {Set<string>} */
  let manifestKeys = new Set();
  /** @type {Set<string>} */
  let permissions = new Set();
  const manifest = files.get('chrome/manifest.json');
  if (manifest) {
    try {
      const json = JSON.parse(manifest);
      manifestKeys = new Set(Object.keys(json));
      permissions = new Set([...(json.permissions ?? []), ...(json.optional_permissions ?? [])].map(String));
    } catch {
      // build.mjs rewrites it; a broken one only means no manifest matches.
    }
  }
  return {files, namespaces, manifestKeys, permissions, known: {namespaces: new Set(), manifestKeys: new Set()}};
}

/**
 * The files under chrome/ that are the project's own: git's list, or where git cannot tell (the
 * copy tools/linux/verify.sh makes has an empty repository; WSL cannot follow a Windows
 * worktree's .git), the folder without what .gitignore names (the vendored copies the build
 * makes).
 * @return {string[]}
 */
function trackedChromeFiles() {
  try {
    const listed = execFileSync('git', ['ls-files', '-z', 'chrome'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})
        .split('\0').filter(Boolean);
    if (listed.length > 0) return listed;
  } catch {
    // Not a repository git can read: walk the folder.
  }
  const rules = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const keep = new Set(rules.filter((l) => l.startsWith('!')).map((l) => l.slice(1)));
  const ignored = (/** @type {string} */ file) => !keep.has(file) && rules.some((rule) =>
    rule === file || (rule.endsWith('/*') && file.startsWith(rule.slice(0, -1))) || (rule.endsWith('/') && file.startsWith(rule)));
  return fs.readdirSync(path.join(root, 'chrome'), {recursive: true, withFileTypes: true})
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .filter((file) => !ignored(file));
}

/**
 * Every WebExtensions namespace and manifest key BCD knows.
 * @param {any} data
 * @return {{namespaces: Set<string>, manifestKeys: Set<string>}}
 */
export function knownWebExtensions(data) {
  return {
    namespaces: new Set(Object.keys(data?.webextensions?.api ?? {})),
    manifestKeys: new Set(Object.keys(data?.webextensions?.manifest ?? {})),
  };
}

/**
 * Where the code uses the names a change gives: a dotted name as written; for a web API also its
 * member alone when that is distinctive and its interface is named in the same file
 * (`navigator.mediaCapabilities` ... `capabilities.decodingInfo(` uses
 * `mediaCapabilities.decodingInfo`, while `Animation.playbackRate` is not the video's
 * `playbackRate`). A WebExtensions name counts only whole (`runtime.getVersion` is not the
 * player's own `EnvUtils.getVersion`).
 * A bare name (`currentTime`) is weak evidence: it counts only when distinctive, and is dropped
 * when the same change names it with its interface (`Animation.playbackRate` is about animations,
 * and its bare `playbackRate` is not the video's). strong: a dotted name, or a member found with
 * its interface.
 * @param {string[]} identifiers
 * @param {Map<string, string>} files
 * @param {Set<string>} stop
 * @param {Set<string>} [namespaces] - The WebExtensions namespaces the code uses.
 * @return {{files: string[], used: string[], strong: boolean}}
 */
export function findUses(identifiers, files, stop, namespaces = new Set()) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @type {Set<string>} */
  const used = new Set();
  let strong = false;
  const cleaned = [...new Set(identifiers.map((raw) => raw.replace(/\(\)$/, '').replace(/^[:@]+/, '').trim()))];
  const qualified = new Set(cleaned.filter((id) => id.includes('.')).map((id) => id.split('.').pop()));
  /** @type {Map<string, {iface: string, strong: boolean}>} name -> the interface that must be in the same file */
  const names = new Map();
  for (const id of cleaned) {
    const parts = id.split('.');
    if (parts.length === 1) {
      if (!qualified.has(id) && (distinctive(id) || (id.length >= 8 && id.includes('_')))) names.set(id, {iface: '', strong: false});
      continue;
    }
    names.set(id, {iface: '', strong: true});
    const member = parts[parts.length - 1];
    if (parts.length === 2 && !namespaces.has(parts[0]) && distinctive(member) && !names.has(member)) {
      names.set(member, {iface: parts[0], strong: true});
    }
  }
  const word = (/** @type {string} */ id, /** @type {string} */ flags = '') =>
    new RegExp(`(?<![\\w$])${escapeRegExp(id)}(?![\\w$])`, flags);
  for (const [id, how] of names) {
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(id) || stop.has(id)) continue;
    const pattern = word(id);
    const ifacePattern = how.iface ? word(how.iface) : null;
    for (const [file, text] of files) {
      if (pattern.test(text) && (!ifacePattern || ifacePattern.test(text))) {
        found.add(file);
        used.add(id);
        strong ||= how.strong;
      }
    }
  }
  return {files: [...found].sort(), used: [...used].sort(), strong};
}

// ---------------------------------------------------------------------------------------------
// Relevance

const Levels = /** @type {Level[]} */ (['low', 'medium', 'high']);
const KindOrder = /** @type {Kind[]} */ (['Bug fix', 'New feature', 'Optimisation opportunity', 'Security change',
  'Compatibility risk']);

/** @param {Level} level @param {number} by */
function shift(level, by) {
  return Levels[Math.max(0, Math.min(2, Levels.indexOf(level) + by))];
}

/** @param {string} name */
function distinctive(name) {
  return name.length >= 8 && /[a-z][A-Z]/.test(name);
}

/**
 * The relevant findings among a release's items, items about the same bug, BCD feature or API
 * merged.
 * @param {RawItem[]} items
 * @param {Config} config
 * @param {CodeIndex} index
 * @return {Finding[]}
 */
export function relevantFindings(items, config, index) {
  const stop = new Set(config.stopIdentifiers);
  const topics = config.topics.map((t) => ({...t, patterns: t.keywords}));
  const excluded = config.excludeText;
  const webextTopic = topics.find((t) => t.id === 'webextensions');
  /** @type {Finding[]} */
  const findings = [];
  for (const item of items) {
    const text = `${item.title} ${item.detail}`;
    // MDN's "Developer Tools" notes are about the browser's devtools, not what a page or an
    // extension can run.
    if (item.source === 'mdn' && /(^|› )developer tools\b/i.test(item.section)) continue;
    if (excluded.test(text) || item.bcd.some((b) => excluded.test(b.replace(/[._]/g, ' ')))) continue;
    const breaking = item.removal ||
      /\b(previously|instead of|now (returns|throws|rejects|requires|fails)|is now required|will need to be updated)\b/i.test(text);
    let matched = topics.filter((t) => t.patterns.some((p) => p.test(text)) || item.bcd.some((b) => t.bcd.some((pre) => underPrefix(b, pre))));
    const webext = webExtensionUse(item, index);
    if (webext === 'unused') continue;
    if (webext !== 'none' && webextTopic && !matched.includes(webextTopic)) matched.push(webextTopic);
    // A Core bug or a web API's BCD entry that merely says "extension" is not a WebExtensions change.
    if (webext === 'none') matched = matched.filter((t) => t !== webextTopic || item.source === 'mdn' || item.source === 'blog');
    if (matched.length === 0) continue;
    // WebDriver notes matter only to the e2e harness (Marionette/geckodriver), and only a change
    // that can break it.
    if (item.source === 'mdn' && /webdriver/i.test(item.section)) {
      matched = breaking && /\bMarionette\b|\bWebDriver classic\b|geckodriver/i.test(text) ? topics.filter((t) => t.id === 'e2e-harness') : [];
      if (matched.length === 0) continue;
    }
    matched.sort((a, b) => Levels.indexOf(b.priority) - Levels.indexOf(a.priority));
    const uses = findUses(item.identifiers, index.files, stop, index.namespaces);
    const priority = matched[0].priority;
    const bare = item.title.replace(/^Bug \d+: /, '');
    /** @type {Kind} */
    let kind = matched[0].kind;
    if (breaking) kind = 'Compatibility risk';
    else if (/\b(CSP|Content Security Policy|security|sandbox(ed)?|hijack\w*|exploit\w*|overflow|use-after-free|spoof\w*)\b/i.test(text)) kind = 'Security change';
    else if (item.source === 'bugzilla') kind = /^(add|implement|support|expose|enable|ship)\b/i.test(bare) ? 'New feature' : 'Bug fix';
    const confidence = /** @type {Level} */ (uses.strong ? 'high' : uses.used.length > 0 || webext === 'used' || item.flagged ? 'medium' : 'low');
    let finalPriority = priority;
    if (uses.strong && kind === 'Compatibility risk') finalPriority = 'high';
    else if (item.experimental && /\bNightly only\b|\benabled in Nightly\b/i.test(text)) finalPriority = 'low';
    // A WebExtensions bug that names no API (policies, browser UI, internals) is rarely about this
    // extension; MDN's curated notes keep their weight.
    else if (webext === 'general' && item.source === 'bugzilla') finalPriority = 'low';
    else if (confidence === 'low' || item.experimental) finalPriority = shift(priority, -1);
    // A BCD entry's key is its change (textKey: path, release, added or removed), so a later
    // change to a reported feature is reported again.
    const aliases = [...item.bugs.map((b) => `bug:${b}`), ...(item.textKey ? [item.textKey] : [])];
    const own = aliases.filter((a) => a.startsWith('bug:') || a.startsWith('bcd:'));
    // Only for merging items of this release, never recorded (a later change to the same API is
    // reported again): the API a note and a BCD entry both name, a BCD entry's parent
    // (runtime.PlatformArch.arm64 and .aarch64), and a distinctive member name shared by many
    // entries (documentId in runtime, tabs, webRequest...).
    const leaves = item.source === 'bcd' ? item.bcd.map((b) => b.split('.').pop() ?? '') :
      item.source === 'mdn' ? item.identifiers.filter((id) => !id.includes('.')) : [];
    const mergeKeys = [
      ...(item.source === 'mdn' || item.source === 'bcd' ? item.identifiers.filter((id) => id.includes('.')).map((id) => `name:${id.toLowerCase()}`) : []),
      ...item.bcd.map((b) => `parent:${b.split('.').slice(0, -1).join('.')}`).filter((k) => k.split('.').length >= 2),
      ...leaves.filter((l) => distinctive(l) && !stop.has(l)).map((l) => `leaf:${l.toLowerCase()}`),
    ];
    findings.push({
      title: item.title, detail: item.detail, sources: [item.source], aliases, mergeKeys, areas: matched.map((t) => t.area),
      kind, priority: finalPriority, confidence, files: uses.files, used: uses.used,
      modules: [...new Set(matched.flatMap((t) => t.modules))], links: [...item.links, ...item.bugs.map((b) => ({label: `Bug ${b}`, url: `https://bugzil.la/${b}`}))],
      experimental: item.experimental, members: [own.length > 0 ? own : aliases],
    });
  }
  return mergeFindings(findings);
}

/**
 * How an item concerns the WebExtensions APIs the extension uses:
 *   'none'   not a WebExtensions item;
 *   'unused' about namespaces, manifest keys or permissions the extension does not use (dropped);
 *   'used'   names one it uses;
 *   'general' a WebExtensions change that names none in particular.
 * @param {RawItem} item
 * @param {CodeIndex} index
 * @return {'none'|'unused'|'used'|'general'}
 */
export function webExtensionUse(item, index) {
  for (const at of item.bcd) {
    const parts = at.split('.');
    if (parts[0] !== 'webextensions') continue;
    if (parts[1] === 'api') return index.namespaces.has(parts[2]) ? 'used' : 'unused';
    if (parts[1] === 'manifest') {
      if (['permissions', 'optional_permissions'].includes(parts[2]) && parts[3]) return index.permissions.has(parts[3]) ? 'used' : 'unused';
      return index.manifestKeys.has(parts[2]) ? 'used' : 'unused';
    }
    return 'unused';
  }
  const addOnSection = item.source === 'mdn' && /add-on/i.test(item.section);
  const product = item.source === 'bugzilla' && item.section.startsWith('WebExtensions');
  if (!addOnSection && !product) return 'none';
  const text = `${item.title} ${item.detail}`;
  const firsts = [...item.identifiers.map((id) => id.split('.')[0]), ...[...text.matchAll(/\b([a-z][A-Za-z]+)\.[a-zA-Z]+/g)].map((m) => m[1])];
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\(\)$/, ''));
  // An API named in plain words ("the userScripts API", "content scripts") counts too; only names
  // that are not ordinary words ("extension", "background", "icons" are everywhere).
  const words = [...index.known.namespaces, ...index.known.manifestKeys].filter((n) => /[A-Z_]/.test(n) &&
    new RegExp(`(?<![\\w.])${escapeRegExp(n).replace(/_/g, '[_ ]')}s?(?![\\w])`, 'i').test(text));
  const specific = [...firsts.filter((n) => index.known.namespaces.has(n)), ...spans.filter((s) => index.known.manifestKeys.has(s)), ...words];
  const usedOnes = [...firsts.filter((n) => index.namespaces.has(n)), ...spans.filter((s) => index.manifestKeys.has(s)),
    ...words.filter((w) => index.namespaces.has(w) || index.manifestKeys.has(w))];
  if (usedOnes.length > 0) return 'used';
  return specific.length > 0 ? 'unused' : 'general';
}

/**
 * Findings that share a bug, a BCD feature or an API become one: the most telling title (MDN's),
 * the strongest kind and priority, every link.
 * @param {Finding[]} findings
 * @return {Finding[]}
 */
export function mergeFindings(findings) {
  /** @type {number[]} */
  const parent = findings.map((_, i) => i);
  const find = (/** @type {number} */ i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  /** @type {Map<string, number>} */
  const seen = new Map();
  findings.forEach((f, i) => {
    for (const alias of [...f.aliases, ...f.mergeKeys]) {
      if (alias.startsWith('mdn:') || alias.startsWith('blog:')) continue;
      const other = seen.get(alias);
      if (other === undefined) seen.set(alias, i);
      else parent[find(i)] = find(other);
    }
  });
  /** @type {Map<number, Finding[]>} */
  const groups = new Map();
  findings.forEach((f, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), f]);
  });
  const sourceRank = ['mdn', 'blog', 'bcd', 'bugzilla'];
  return [...groups.values()].map((group) => {
    const lead = [...group].sort((a, b) => sourceRank.indexOf(a.sources[0]) - sourceRank.indexOf(b.sources[0]))[0];
    /** @type {Map<string, Link>} */
    const links = new Map();
    for (const f of group) for (const l of f.links) links.set(l.url, l);
    const bcdTitles = group.filter((f) => f.sources.includes('bcd')).map((f) => f.title).sort();
    const onlyBcd = bcdTitles.length === group.length;
    let title = lead.title;
    let detail = lead.detail;
    if (onlyBcd && group.length > 1) {
      title = group.length <= 3 ? bcdTitles.join('; ') : `${group.length} compatibility-data changes: ${bcdTitles.slice(0, 2).join('; ')} and ${group.length - 2} more`;
      detail = group.length <= 3 ? '' : bcdTitles.join('; ');
    } else {
      // Other notes merged in (they name the same API) are shown too: the kind may be theirs.
      const notes = group.filter((f) => f !== lead && (f.sources[0] === 'mdn' || f.sources[0] === 'blog')).map((f) => f.title);
      if (notes.length > 0) detail = [detail, `Also in the notes: ${notes.join('; ')}`].filter(Boolean).join(' ');
      if (bcdTitles.length > 0 && lead !== group.find((f) => f.sources.includes('bcd'))) {
        detail = [detail, `Compatibility data: ${bcdTitles.slice(0, 8).join('; ')}${bcdTitles.length > 8 ? ` and ${bcdTitles.length - 8} more` : ''}.`].filter(Boolean).join(' ');
      }
    }
    return {
      ...lead,
      title,
      detail,
      sources: [...new Set(group.flatMap((f) => f.sources))],
      mergeKeys: [...new Set(group.flatMap((f) => f.mergeKeys))],
      aliases: [...new Set(group.flatMap((f) => f.aliases))].sort(),
      areas: [...new Set(group.flatMap((f) => f.areas))],
      kind: group.map((f) => f.kind).sort((a, b) => KindOrder.indexOf(b) - KindOrder.indexOf(a))[0],
      priority: group.map((f) => f.priority).sort((a, b) => Levels.indexOf(b) - Levels.indexOf(a))[0],
      confidence: group.map((f) => f.confidence).sort((a, b) => Levels.indexOf(b) - Levels.indexOf(a))[0],
      files: [...new Set(group.flatMap((f) => f.files))].sort(),
      used: [...new Set(group.flatMap((f) => f.used))].sort(),
      modules: [...new Set(group.flatMap((f) => f.modules))],
      links: [...links.values()],
      experimental: group.every((f) => f.experimental),
      members: group.flatMap((f) => f.members),
    };
  }).sort((a, b) => Levels.indexOf(b.priority) - Levels.indexOf(a.priority) ||
    KindOrder.indexOf(b.kind) - KindOrder.indexOf(a.kind) || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------------------------
// Rendering (all outside text goes through md())

/**
 * A link only to an allowed Mozilla/MDN host over https, else ''.
 * @param {string} url
 * @return {string}
 */
export function safeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' || !LinkHosts.has(parsed.hostname) || parsed.username || parsed.password) return '';
  // On GitHub only the specs' and Mozilla's own: a link to this repository's issue or commit
  // would put a reference on it.
  if (parsed.hostname === 'github.com' && !GitHubOwners.has(parsed.pathname.split('/')[1]?.toLowerCase() ?? '')) return '';
  return parsed.href.replace(/[()\s<>"'`\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** Control and invisible characters: zero-width, bidirectional controls, line separators. */
const Invisible = new RegExp('[' + [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0xfeff, 0xfeff]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');

/**
 * Outside text made safe for an issue: no HTML, no mention, no reference to this repository's
 * issues or commits, no link or image it chose, no autolink, no hidden marker. `code` spans stay
 * code (GitHub renders nothing inside them) when they hold no backtick or line break.
 * @param {string} text
 * @param {number} [limit]
 * @return {string}
 */
export function md(text, limit = 600) {
  const flat = String(text).replace(Invisible, '')
      .replace(/\s+/g, ' ').trim();
  const clipped = flat.length > limit ? flat.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…' : flat;
  return clipped.split(/(`[^`]{1,120}`)/).map((part, i) => {
    if (i % 2 === 1) {
      // Until none is left: one pass leaves pieces that join ("<!<!---- x --->->" is "<!-- x -->").
      let code = part.slice(1, -1);
      for (let before = ''; before !== code;) {
        before = code;
        code = code.replace(/<!--|--!?>/g, '');
      }
      return '`' + code + '`';
    }
    // The zero-width spaces added below are entities holding "#8203": "#<digit>" is defused
    // first, before any of them exists.
    return part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/#(\d)/g, '#&#8203;$1')
        .replace(/GH-(\d)/gi, (m) => m.slice(0, 3) + '&#8203;' + m.slice(3))
        // A commit's short hash, letters only too ("feacbcd"); digits only stay (bug numbers).
        .replace(/\b([0-9a-f]{7,40})\b/gi, (m) => /[a-f]/i.test(m) ? m.slice(0, 4) + '&#8203;' + m.slice(4) : m)
        .replace(/:\/\//g, ':&#8203;//')
        .replace(/\bwww\./gi, (m) => m.slice(0, 3) + '&#8203;.')
        .replace(/([\\[\]!*_|~])/g, '\\$1')
        .replace(/`/g, '\\`')
        .replace(/@/g, '@&#8203;');
  }).join('');
}

const Actions = /** @type {Record<Kind, string>} */ ({
  'Compatibility risk': 'Check the code named here and run the e2e specs that cover it on this Firefox.',
  'Security change': 'Check whether permissions, the content scripts or the page transport are affected.',
  'Optimisation opportunity': 'Measure whether it makes the named modules faster or simpler (A/B), then adopt or reject it in docs/notes.',
  'New feature': 'Decide whether FastStream should use it; write the verdict in docs/notes.',
  'Bug fix': 'Check whether FastStream works around this bug; if it does, test without the workaround.',
});

/**
 * One finding as a checklist item, its key in a hidden marker after the title.
 * @param {Finding} f
 * @return {string}
 */
export function renderFinding(f) {
  const where = f.files.length > 0 ?
    `${f.files.slice(0, 6).map((file) => '`' + file + '`').join(', ')}${f.files.length > 6 ? ` and ${f.files.length - 6} more` : ''} (uses ${f.used.slice(0, 4).map((u) => '`' + u + '`').join(', ')})` :
    `no direct use found; the area's code: ${f.modules.slice(0, 4).map((m) => '`' + m + '`').join(', ')}`;
  const evidence = f.links.length > 0 ?
    f.links.slice(0, 6).map((l) => `[${md(l.label, 60)}](${l.url})`).join(', ') : 'Mozilla release data (no link)';
  const lines = [
    `- [ ] **${f.kind}: ${md(f.title, 200)}** <!-- ffw-item ${f.aliases.join(' ')} -->`,
    `  - Area: ${f.areas.map((a) => md(a, 80)).join(', ')}${f.experimental ? ' (experimental, behind a preference)' : ''}`,
  ];
  if (f.detail) lines.push(`  - Change: ${md(f.detail, 1000)}`);
  lines.push(
      `  - FastStream: ${where}`,
      `  - Priority: ${f.priority} · Confidence: ${f.confidence} · Sources: ${f.sources.join(', ')}`,
      `  - Evidence: ${evidence}`,
      `  - Action: ${Actions[f.kind]}`,
  );
  return lines.join('\n');
}

/**
 * A release's section, in parts no larger than MaxPost: high and medium items first, low ones
 * folded away.
 * @param {Review} review
 * @param {Finding[]} findings
 * @param {{late: boolean, bcdVersion: string}} options
 * @return {string[]}
 */
export function renderSection(review, findings, {late, bcdVersion}) {
  const v = review.version;
  const heading = late ? `### Firefox ${v} — added after its first review` : `### Firefox ${v} — release review`;
  const meta = [
    review.date ? `Released ${review.date}` : '',
    `[Notes for developers](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/${v})`,
    `[Release notes](https://www.firefox.com/en-US/firefox/${v}.0/releasenotes/)`,
    `[Bugzilla](https://bugzilla.mozilla.org/buglist.cgi?f1=cf_status_firefox${v}&o1=anyexact&v1=fixed%2Cverified&product=WebExtensions)`,
    bcdVersion ? `BCD ${md(bcdVersion, 20)}` : '',
  ].filter(Boolean).join(' · ');
  const counts = Levels.slice().reverse().map((l) => `${findings.filter((f) => f.priority === l).length} ${l}`).join(', ');
  const intro = [`<!-- firefox-api-watch:release ${v} -->`, heading, '', meta, '',
    `${findings.length} finding(s): ${counts}.${review.wip ? ' MDN still marked these notes as a work in progress; what it adds later comes as a further section.' : ''}` +
    `${review.noNotes ? ` MDN had no notes for developers ${GraceDays} days after the release: reviewed from the compatibility data, Bugzilla and the add-ons blog; notes MDN writes later come as a further section.` : ''}`, ''];
  const main = findings.filter((f) => f.priority !== 'low').map(renderFinding);
  const low = findings.filter((f) => f.priority === 'low').map(renderFinding);
  // Each part's blocks, and where the folded list of low ones starts and ends in them (the
  // findings' own text can hold "<details>" in code).
  /** @type {{blocks: string[], opens: boolean, closes: boolean}[]} */
  const parts = [{blocks: [], opens: false, closes: false}];
  let size = 0;
  /** @param {string} block @param {'opens'|'closes'} [fold] */
  const add = (block, fold) => {
    let part = parts[parts.length - 1];
    if (size + block.length > MaxPost - 2000 && part.blocks.length > 0) {
      parts.push(part = {blocks: [], opens: false, closes: false});
      size = 0;
    }
    part.blocks.push(block);
    if (fold) part[fold] = true;
    size += block.length + 1;
  };
  for (const block of main) add(block);
  if (low.length > 0) {
    add(`\n<details><summary>${low.length} lower-priority finding(s)</summary>\n`, 'opens');
    for (const block of low) add(block);
    add('\n</details>', 'closes');
  }
  let folded = false;
  return parts.map((part, i) => {
    const head = parts.length > 1 ? intro.map((line) => line === heading ? `${heading} (part ${i + 1} of ${parts.length})` : line) : intro;
    let text = part.blocks.join('\n');
    // A part that starts inside the folded list opens it again; one that ends inside closes it.
    if (folded) text = `<details><summary>Lower-priority findings, continued</summary>\n\n${text}`;
    if (part.opens) folded = true;
    if (part.closes) folded = false;
    if (folded) text += '\n\n</details>';
    return [...head, text].join('\n');
  });
}

export const IssueIntro = [
  'Changes in new Firefox releases that may break or improve FastStream, one section per release,',
  'from MDN\'s notes for developers, browser-compat-data, Bugzilla and the add-ons blog.',
  '',
  'Tick an item when it is dealt with. The watcher never edits this issue or its comments, so ticks',
  'and notes stay. Close the issue when the review is done: the next release with findings opens a new',
  'one, and nothing listed here is listed again. (`.github/workflows/firefox-api-watch.yml`)',
  '',
].join('\n');

// ---------------------------------------------------------------------------------------------
// What was reported

/**
 * The keys and releases the bot's posts record. Markers are read only from the bot's posts and
 * only in their exact form: anything else in a post is text.
 * @param {string[]} posts
 * @return {{aliases: Set<string>, releases: Set<number>}}
 */
export function recordsOf(posts) {
  /** @type {Set<string>} */
  const aliases = new Set();
  /** @type {Set<number>} */
  const releases = new Set();
  for (const post of posts) {
    for (const m of String(post ?? '').matchAll(/<!-- ffw-item ((?:(?:bug:\d{1,8}|bcd:[0-9a-f]{12}|mdn:[0-9a-f]{12}|blog:[0-9a-f]{12}) ?)+)-->/g)) {
      for (const alias of m[1].trim().split(' ')) aliases.add(alias);
    }
    for (const m of String(post ?? '').matchAll(/<!-- firefox-api-watch:release (\d{2,4}) -->/g)) releases.add(Number(m[1]));
  }
  return {aliases, releases};
}

/**
 * @param {Issue} issue
 */
function isWatcherIssue(issue) {
  return issue.user === Bot && issue.title.startsWith(Prefix);
}

/**
 * The GitHub client used in Actions: the gh CLI (GH_TOKEN, GH_REPO), each list paged by hand.
 * @param {string} repo
 * @param {(args: string[], input?: string) => string} [gh]
 * @return {GitHub}
 */
export function ghClient(repo, gh = (args, input) => execFileSync('gh', args, {encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024})) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GH_REPO "${repo}" is not owner/name`);
  /** @param {string} endpoint */
  const pages = (endpoint) => {
    /** @type {any[]} */
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const list = JSON.parse(gh(['api', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`]) || '[]');
      if (!Array.isArray(list)) throw new Error(`${endpoint}: not a list`);
      all.push(...list);
      if (list.length < 100) break;
    }
    return all;
  };
  /** @param {any} raw @return {Issue} */
  const issueOf = (raw) => ({number: Number(raw.number), state: String(raw.state), title: String(raw.title ?? ''),
    body: String(raw.body ?? ''), user: String(raw.user?.login ?? '')});
  return {
    listIssues: async () => pages(`repos/${repo}/issues?state=all&creator=${encodeURIComponent(Bot)}`)
        .filter((raw) => !raw.pull_request).map(issueOf),
    listComments: async (issue) => pages(`repos/${repo}/issues/${issue}/comments`)
        .map((raw) => ({body: String(raw.body ?? ''), user: String(raw.user?.login ?? '')})),
    getIssue: async (issue) => issueOf(JSON.parse(gh(['api', `repos/${repo}/issues/${issue}`]))),
    createIssue: async (title, body) => Number(JSON.parse(gh(['api', '--method', 'POST', `repos/${repo}/issues`, '--input', '-'],
        JSON.stringify({title, body}))).number),
    comment: async (issue, body) => {
      gh(['api', '--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '--input', '-'], JSON.stringify({body}));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// One run

/**
 * @typedef {{
 *   dryRun?: boolean, github?: GitHub|null, from?: number, to?: number, start?: number, lookback?: number,
 *   memo?: string, today?: string, fixtures?: string, fetchImpl?: typeof fetch,
 *   wait?: (ms: number) => Promise<void>, config?: Config, index?: CodeIndex,
 *   log?: (line: string) => void,
 * }} RunOptions
 * @typedef {{summary: string[], posted: {version: number, issue: number|null, body: string}[], memo: string,
 *   failures: string[]}} RunResult
 */

/**
 * Reviews the releases due and posts what is new. Never throws for a source that is down: that
 * release waits for the next run. failures: what should fail the run (a source that answers
 * wrongly, notes still missing GraceDays after a release).
 * @param {RunOptions} [options]
 * @return {Promise<RunResult>}
 */
export async function run(options = {}) {
  const {dryRun = false, github = null, start = DefaultStart, lookback = DefaultLookback,
    fetchImpl = fetch, wait = defaultWait, log = () => {}} = options;
  const fetchOptions = {fetchImpl, wait};
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  /** @type {string[]} */
  const summary = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {RunResult['posted']} */
  const posted = [];

  /** @type {{current: number, dates: Map<number, string>}} */
  let pd;
  try {
    pd = await productDetails(fetchOptions);
  } catch (error) {
    const e = /** @type {SourceError} */ (error);
    if (!e.outage) failures.push(e.message);
    summary.push(`The Firefox version list could not be read: ${e.message}. Nothing was reviewed.`);
    return {summary, posted, memo: options.memo ?? '', failures};
  }
  const explicit = options.from !== undefined;
  const last = Math.min(options.to ?? pd.current, pd.current);
  const first = explicit ? /** @type {number} */ (options.from) : Math.max(start, pd.current - lookback + 1);
  if (first > last) {
    summary.push(`Firefox ${pd.current} is the current release; the watch starts with Firefox ${start}.`);
    return {summary, posted, memo: options.memo ?? '', failures};
  }
  if (!explicit && options.memo === String(pd.current)) {
    summary.push(`Firefox ${pd.current} is the current release and was reviewed already.`);
    return {summary, posted, memo: options.memo, failures};
  }

  const config = options.config ?? Topics;
  const index = options.index ?? codeIndex();

  // What was reported before, from every watcher issue, open or closed.
  let records = {aliases: new Set(), releases: new Set()};
  if (github) {
    const issues = (await github.listIssues()).filter(isWatcherIssue);
    /** @type {string[]} */
    const posts = [];
    for (const issue of issues) {
      posts.push(issue.body);
      for (const c of await github.listComments(issue.number)) if (c.user === Bot) posts.push(c.body);
    }
    records = recordsOf(posts);
  }

  // Sources shared by every release; one that is down leaves every release for the next run.
  /** @type {{version: string, data: any}|null} */
  let bcd = null;
  /** @type {string|null} */
  let feed = null;
  /** @type {string} */
  let sharedProblem = '';
  try {
    bcd = await loadBcd({fixtures: options.fixtures, ...fetchOptions});
    index.known = knownWebExtensions(bcd.data);
    const answer = await getUrl(Urls.feed, fetchOptions);
    if (answer.status === 404) throw new SourceError(`${Urls.feed}: HTTP 404`, false);
    feed = answer.text;
  } catch (error) {
    const e = /** @type {SourceError} */ (error);
    if (!(e instanceof SourceError)) throw e;
    if (!e.outage) failures.push(e.message);
    sharedProblem = e.message;
  }

  /** @type {Review[]} */
  const reviews = [];
  for (let version = first; version <= last; version++) {
    const date = pd.dates.get(version) ?? '';
    const review = /** @type {Review} */ ({version, date, complete: false, reason: '', wip: false, checked: 0, findings: []});
    reviews.push(review);
    if (sharedProblem || !bcd || feed === null) {
      review.reason = sharedProblem;
      continue;
    }
    try {
      const overdue = !!date && daysBetween(date, today) > GraceDays;
      const notes = await getUrl(Urls.mdn(version), fetchOptions);
      /** @type {RawItem[]|null} */
      let mdnItems = null;
      if (notes.status === 404) {
        // Past the grace days, the release is reviewed from the other sources: MDN may never
        // write notes for it, and waiting would hold every later release back.
        if (overdue) {
          review.noNotes = true;
          mdnItems = [];
        } else {
          review.reason = 'MDN has no notes for developers for it yet';
        }
      } else {
        const mdn = parseMdnNotes(notes.text, version);
        review.wip = mdn.wip || mdn.beta;
        if (review.wip && !overdue) {
          review.reason = 'MDN still marks its notes as a work in progress';
        } else {
          mdnItems = mdn.items;
        }
      }
      if (mdnItems) {
        const bugs = await bugzillaFor(version, config, index.namespaces, fetchOptions);
        const raw = [...mdnItems, ...bcdChanges(bcd.data, version, (at) => wantedPath(at, config, index)), ...bugs,
          ...feedItems(feed, version)];
        review.checked = raw.length;
        review.findings = relevantFindings(raw, config, index);
        review.complete = true;
      }
    } catch (error) {
      const e = /** @type {SourceError} */ (error);
      if (!(e instanceof SourceError)) throw e;
      if (!e.outage) failures.push(e.message);
      review.reason = e.message;
    }
  }
  // A source that stays down: the newest release unreviewed past the grace days fails the run.
  // An older release was the newest before and had its days then; a short outage while it is
  // looked at again (for notes added later) is no failure.
  const newest = reviews[reviews.length - 1];
  if (newest && !newest.complete && newest.date && daysBetween(newest.date, today) > GraceDays) {
    failures.push(`Firefox ${newest.version} (released ${newest.date}) could not be reviewed for more than ${GraceDays} days: ${newest.reason}`);
  }

  // What is new, oldest release first; a key reported for one release is not repeated for the next.
  /** @type {{review: Review, findings: Finding[], late: boolean}[]} */
  const due = [];
  // A release that was never posted holds back the ones after it: the sections stay in version order.
  let waitsFor = 0;
  for (const review of reviews) {
    if (!review.complete) {
      summary.push(`Firefox ${review.version}: not reviewed yet (${review.reason || 'a source is unavailable'}); the next run tries again.`);
      if (!waitsFor && !records.releases.has(review.version)) waitsFor = review.version;
      continue;
    }
    if (waitsFor) {
      summary.push(`Firefox ${review.version}: reviewed, waits for Firefox ${waitsFor} (the sections go in version order).`);
      continue;
    }
    const fresh = review.findings.filter((f) => f.members.some((m) => m.some((a) => !records.aliases.has(a))));
    for (const f of fresh) for (const a of f.aliases) records.aliases.add(a);
    if (fresh.length === 0) {
      const why = review.findings.length === 0 ? 'none relevant' : `${review.findings.length} relevant, all reported before`;
      summary.push(`Firefox ${review.version}: reviewed, nothing new (${review.checked} change(s) checked, ${why}).`);
      continue;
    }
    due.push({review, findings: fresh, late: records.releases.has(review.version)});
    records.releases.add(review.version);
  }

  let lastIssue = 0;
  for (const {review, findings, late} of due) {
    for (const body of renderSection(review, findings, {late, bcdVersion: bcd?.version ?? ''})) {
      if (dryRun || !github) {
        posted.push({version: review.version, issue: null, body});
        log(body);
        continue;
      }
      const issue = lastIssue = await postSection(github, review.version, body, lastIssue);
      posted.push({version: review.version, issue, body});
    }
    summary.push(`Firefox ${review.version}: ${findings.length} finding(s) ${dryRun || !github ? 'would be posted (dry run)' : `posted to #${posted[posted.length - 1].issue}`}.`);
  }

  const complete = reviews.every((r) => r.complete);
  const memo = complete && !explicit && failures.length === 0 ? String(pd.current) : options.memo ?? '';
  return {summary, posted, memo, failures};
}

/**
 * Posts one section: a comment on the oldest open watcher issue, read again just before, or a
 * new issue when there is none (the one there was may have been closed meanwhile).
 * @param {GitHub} github
 * @param {number} version
 * @param {string} body
 * @param {number} [last] - The issue this run posted to before: GitHub's list of issues can
 *   lag behind an issue just opened, and a second one would be opened.
 * @return {Promise<number>}
 */
export async function postSection(github, version, body, last = 0) {
  const listed = (await github.listIssues()).filter((i) => isWatcherIssue(i) && i.state === 'open');
  const numbers = [...new Set([...listed.map((i) => i.number), ...(last ? [last] : [])])].sort((a, b) => a - b);
  for (const number of numbers) {
    const now = await github.getIssue(number);
    if (now.state !== 'open') continue;
    await github.comment(number, body);
    return number;
  }
  return github.createIssue(`${Prefix}starting with Firefox ${version}`, `${IssueIntro}\n${body}`);
}

/**
 * @param {number} version
 * @param {Config} config
 * @param {Set<string>} namespaces
 * @param {FetchOptions} fetchOptions
 * @return {Promise<RawItem[]>}
 */
async function bugzillaFor(version, config, namespaces, fetchOptions) {
  const common = `resolution=FIXED&f1=cf_status_firefox${version}&o1=anyexact&v1=fixed%2Cverified` +
    `&include_fields=id,summary,product,component,keywords&limit=${BugzillaLimit}`;
  const webext = `${Urls.bugzilla}?product=WebExtensions&${common}`;
  const core = `${Urls.bugzilla}?product=Core&${config.bugzilla.coreComponents.map((c) => `component=${encodeURIComponent(c)}`).join('&')}&${common}`;
  /** @type {RawItem[]} */
  const items = [];
  for (const url of [webext, core]) {
    const json = await getJson(url, fetchOptions);
    if (json?.error) throw new SourceError(`${url.split('?')[0]}: ${String(json.message ?? 'error').slice(0, 120)}`, false);
    // As many as asked for: the list may have been cut, and what is missing would go unseen.
    if (Array.isArray(json?.bugs) && json.bugs.length >= BugzillaLimit) {
      throw new SourceError(`${url.split('?')[0]}: ${BugzillaLimit} bugs or more for one release; narrow the filter in firefox-api-watch.topics.mjs`, false);
    }
    items.push(...bugzillaItems(json, config.bugzilla, namespaces));
  }
  return items;
}

/**
 * @param {string} at
 * @param {Config} config
 * @param {CodeIndex} index
 */
function wantedPath(at, config, index) {
  const parts = at.split('.');
  if (parts[0] === 'webextensions') {
    if (parts[1] === 'api') return index.namespaces.has(parts[2]);
    if (parts[1] === 'manifest') return index.manifestKeys.has(parts[2]);
    return false;
  }
  return config.topics.some((t) => t.bcd.some((pre) => underPrefix(at, pre)));
}

/**
 * Whether a BCD path is the prefix's feature or under it (`api.Blob` holds `api.Blob.text`, not
 * `api.BlobEvent`).
 * @param {string} at
 * @param {string} pre
 */
export function underPrefix(at, pre) {
  return at === pre || at.startsWith(pre.endsWith('.') ? pre : pre + '.');
}

/**
 * @param {string} from
 * @param {string} to
 */
function daysBetween(from, to) {
  if (!from) return 0;
  return Math.floor((Date.parse(to) - Date.parse(from)) / 86400000);
}

// ---------------------------------------------------------------------------------------------
// Command line

/**
 * @param {string[]} argv
 * @return {{dryRun: boolean, noGithub: boolean, from?: number, to?: number, memoDir: string}}
 */
export function parseArgs(argv) {
  /** @type {{dryRun: boolean, noGithub: boolean, from?: number, to?: number, memoDir: string}} */
  const args = {dryRun: false, noGithub: false, memoDir: ''};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const number = () => {
      const value = argv[++i] ?? '';
      if (!/^\d{2,4}$/.test(value)) throw new Error(`${arg} needs a Firefox major version, not "${value.slice(0, 20)}"`);
      return Number(value);
    };
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-github') args.noGithub = args.dryRun = true;
    else if (arg === '--from') args.from = number();
    else if (arg === '--to') args.to = number();
    else if (arg === '--memo') args.memoDir = argv[++i] ?? '';
    else throw new Error(`unknown argument "${arg.slice(0, 40)}"`);
  }
  if (args.to !== undefined && args.from === undefined) throw new Error('--to needs --from');
  return args;
}

/**
 * A folder named on the command line or in the environment, which has to lie in a temporary
 * folder - the runner's (RUNNER_TEMP) or the system's: the memo is kept there, and the workflow
 * test's fixtures. Anything else is refused, so neither can read or write elsewhere.
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} [env]
 * @return {string} The folder, resolved.
 */
export function tempFolder(dir, env = process.env) {
  const resolved = path.resolve(dir);
  for (const temp of [env.RUNNER_TEMP, os.tmpdir()]) {
    if (!temp) continue;
    const base = path.resolve(temp) + path.sep;
    if (resolved.startsWith(base)) return resolved;
  }
  throw new Error(`${dir.slice(0, 200)} is not in a temporary folder (RUNNER_TEMP or ${os.tmpdir()})`);
}

/**
 * Mozilla's sources from files, for the workflow test (FFW_FIXTURES): versions.json,
 * majors.json, <version>.md, webextensions-<version>.json, core-<version>.json, feed.xml (and
 * bcd.json, read by loadBcd). Anything else answers 404.
 * @param {string} dir - From tempFolder.
 * @return {typeof fetch}
 */
export function fixtureFetch(dir) {
  /** @param {string} name */
  const file = (name) => {
    const at = path.join(dir, name);
    return fs.existsSync(at) ? new Response(fs.readFileSync(at), {status: 200}) : new Response('', {status: 404});
  };
  return /** @type {typeof fetch} */ (async (input) => {
    const url = String(input);
    if (url === Urls.versions) return file('versions.json');
    if (url === Urls.majors) return file('majors.json');
    if (url === Urls.feed) return file('feed.xml');
    const notes = /\/releases\/(\d{2,4})\/index\.md$/.exec(url);
    if (notes) return file(`${notes[1]}.md`);
    const bugs = /^https:\/\/bugzilla\.mozilla\.org\/rest\/bug\?product=(WebExtensions|Core)&.*cf_status_firefox(\d{2,4})&/.exec(url);
    if (bugs) return file(`${bugs[1] === 'Core' ? 'core' : 'webextensions'}-${bugs[2]}.json`);
    return new Response('', {status: 404});
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const memoDir = args.memoDir ? tempFolder(args.memoDir, env) : '';
  const memoFile = memoDir ? path.join(memoDir, 'reviewed') : '';
  const memo = memoFile && fs.existsSync(memoFile) ? fs.readFileSync(memoFile, 'utf8').trim() : '';
  const fixtures = env.FFW_FIXTURES ? tempFolder(env.FFW_FIXTURES, env) : '';
  const github = args.noGithub ? null : ghClient(String(env.GH_REPO ?? ''));
  const result = await run({
    dryRun: args.dryRun, github, from: args.from, to: args.to, memo,
    start: env.FFW_START ? Number(env.FFW_START) : DefaultStart, today: env.FFW_TODAY || undefined,
    ...(fixtures ? {fixtures, fetchImpl: fixtureFetch(fixtures)} : {}),
    log: (body) => process.stdout.write(`${body}\n\n---\n\n`),
  });
  const lines = ['## Firefox API watch', '', ...result.summary.map((s) => `- ${s}`), ...result.failures.map((f) => `- **Failed:** ${f}`), ''];
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  process.stderr.write(lines.join('\n') + '\n');
  if (memoFile && result.memo && result.memo !== memo && !args.dryRun) {
    fs.mkdirSync(memoDir, {recursive: true});
    fs.writeFileSync(memoFile, result.memo + '\n');
  }
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `memo=${result.memo}\nmemo_changed=${!args.dryRun && result.memo !== '' && result.memo !== memo}\n`);
  }
  if (result.failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`firefox-api-watch: ${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
