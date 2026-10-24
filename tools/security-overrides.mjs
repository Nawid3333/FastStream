// @ts-check

// PLAN and VERIFY halves of the security-overrides branch kind: turn due Dependabot
// alerts into override floors, edit pnpm-workspace.yaml with line surgery, and check
// the resulting lockfiles. The GitHub Actions jobs, the gh/git calls and the install
// live in the workflow; this module is pure string/data logic, so it imports nothing
// and the tests can pin behavior byte for byte.

/** name -> set of distinct registry versions of one package in a lockfile.
 * @typedef {Map<string, Set<string>>} VersionMap */

/** A predicate over released x.y.z versions (the only operand form GitHub ranges use).
 * @typedef {(version: string) => boolean} RangePredicate */

/** One Dependabot alert, exactly as the repository alerts API returns it.
 * @typedef {{
 *   number: number,
 *   created_at?: string,
 *   state?: string,
 *   dependency: { manifest_path: string, package: { ecosystem?: string, name: string }, scope?: string },
 *   security_advisory: { ghsa_id: string, severity: string, summary: string },
 *   security_vulnerability: {
 *     package?: { ecosystem?: string, name: string },
 *     vulnerable_version_range: string,
 *     first_patched_version?: { identifier?: string } | null,
 *   },
 * }} Alert */

/** One override floor to add, raise or keep.
 * @typedef {{
 *   name: string,
 *   selector: string,
 *   floor: string,
 *   alerts: number[],
 *   action: 'add' | 'raise' | 'none',
 *   from?: string,
 * }} Floor */

/** A declined alert and why: it moves to the issue route and automation never retries it.
 * @typedef {{ alert: number, reason: string }} Decline */

/** @typedef {{ floors: Floor[], declined: Decline[] }} Plan */

/** @typedef {{ key: string, value: string, line: number, raw: string, valueStart: number }} WorkspaceEntry */

/** @typedef {{ start: number, end: number }} WorkspaceSection */

// ---- version math -----------------------------------------------------------

const XYZ_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const CARET_RE = /^\^\d+\.\d+\.\d+$/;
const NUMERIC_RE = /^\d+$/;
// An npm name, scoped or not, with an optional @major: all a generated key may be.
const SELECTOR_RE = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*(?:@\d+)?$/;
const NAMED_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, pre: string[] | null } | null}
 */
function splitVersion(version) {
  const m = SEMVER_RE.exec(version);
  if (!m) return null;
  // Pre kept as identifiers: prerelease precedence decides caret satisfaction.
  return {major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : null};
}

/** Bare x.y.z or throw: ranges and floors only speak releases.
 * @param {string} version
 * @returns {[number, number, number]} */
function parseXyz(version) {
  const m = XYZ_RE.exec(version);
  if (!m) throw new Error(`not an x.y.z version: '${version}'`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** @param {[number, number, number]} a @param {[number, number, number]} b @returns {number} */
function cmpTriples(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Semver precedence: numeric triple first, then prerelease identifiers (numeric lower
 * than alphanumeric, shorter list lower); a release outranks its own prerelease.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function cmpVersions(a, b) {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  if (!pa || !pb) throw new Error(`cannot compare versions '${a}' and '${b}'`);
  const c = cmpTriples([pa.major, pa.minor, pa.patch], [pb.major, pb.minor, pb.patch]);
  if (c !== 0) return c;
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = NUMERIC_RE.test(x);
    const ny = NUMERIC_RE.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * npm caret semantics for a concrete `^floorBase` (leftmost non-zero digit pinned);
 * an unparseable version never satisfies ÔÇö verification must fail closed, not silently pass.
 * @param {string} version
 * @param {string} floorBase bare 'x.y.z', the '^' already stripped
 * @returns {boolean}
 */
function satisfiesCaret(version, floorBase) {
  const v = splitVersion(version);
  const f = splitVersion(floorBase);
  if (!v || !f) return false;
  if (cmpVersions(version, floorBase) < 0) return false;
  if (f.major > 0) return v.major === f.major;
  if (f.minor > 0) return v.major === 0 && v.minor === f.minor;
  return v.major === 0 && v.minor === 0 && v.patch === f.patch;
}

// ---- pnpm-workspace.yaml text -----------------------------------------------

/**
 * Strip one matching pair of single or double quotes (YAML allows both).
 * @param {string} s
 * @returns {string}
 */
function unquote(s) {
  if (s.length >= 2 && (s[0] === `'` || s[0] === '"') && s.endsWith(s[0])) return s.slice(1, -1);
  return s;
}

/**
 * The block from a column-0 `name:` line up to the next line starting with a
 * non-space, non-# character (a column-0 comment stays inside the block).
 * @param {string[]} lines
 * @param {string} name
 * @returns {WorkspaceSection | null}
 */
function findSection(lines, name) {
  const headerRe = new RegExp(`^${name}:\\s*$`);
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++;
  return {start, end};
}

/**
 * Entries of a flat block: exactly-2-space `key: value` lines, blank/comment lines
 * between them skipped. Any other shape is refused with its line number ÔÇö silently
 * skipping an entry could hide an override that governs the next run's decision.
 * @param {string[]} lines
 * @param {WorkspaceSection} section
 * @returns {WorkspaceEntry[]}
 */
function parseEntries(lines, section) {
  /** @type {WorkspaceEntry[]} */
  const out = [];
  for (let i = section.start + 1; i < section.end; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent !== 2) throw new Error(`pnpm-workspace.yaml line ${i + 1}: entry is not indented exactly 2 spaces`);
    const idx = line.search(/:\s|:$/);
    if (idx === -1) throw new Error(`pnpm-workspace.yaml line ${i + 1}: cannot read entry '${line.trim()}'`);
    const valueStart = idx + (line[idx + 1] === ' ' ? 2 : 1);
    const key = unquote(line.slice(2, idx));
    if (out.some((entry) => entry.key === key)) {
      throw new Error(`pnpm-workspace.yaml line ${i + 1}: '${key}' is there twice; which one pnpm takes is not ours to guess`);
    }
    out.push({
      key,
      value: unquote(line.slice(valueStart).replace(/\s+$/, '')),
      line: i,
      raw: line,
      valueStart,
    });
  }
  return out;
}

/**
 * Generated keys/values are plain-safe (`name`, `name@m`, `^x.y.z`) except that a
 * leading `@` is a YAML reserved indicator ÔÇö scoped floors get the single quotes
 * pnpm itself writes.
 * @param {string} selector
 * @returns {string}
 */
function keyToText(selector) {
  return selector.startsWith('@') ? `'${selector}'` : selector;
}

// ---- lockfiles ---------------------------------------------------------------

const NODE_MODULES = 'node_modules/';

/** @param {VersionMap} map @param {string} name @param {string} version */
function addVersion(map, name, version) {
  let set = map.get(name);
  if (!set) map.set(name, (set = new Set()));
  set.add(version);
}

/**
 * pnpm 12 writes a first YAML document (`---`, packageManagerDependencies) ahead of
 * the main one; only the main document has `packages:`. The last document with one
 * wins, so the bookkeeping document can never shadow the real one.
 * @param {string} lockText
 * @returns {string[]}
 */
function selectLockDocument(lockText) {
  /** @type {string[][]} */
  const docs = [[]];
  for (const line of lockText.split('\n')) {
    if (/^---\s*$/.test(line)) docs.push([]);
    else docs[docs.length - 1].push(line);
  }
  const main = docs.filter((d) => d.some((l) => /^packages:\s*$/.test(l))).pop();
  if (!main) throw new Error('pnpm-lock.yaml: no document carries a `packages:` section');
  return main;
}

/**
 * Raw keys of one lockfile section: 2-space `key:` lines until the next column-0 key;
 * deeper lines are an entry's body. Unreadable entry lines throw ÔÇö a dropped key would
 * hide a vulnerable version from every later check.
 * @param {string[]} docLines
 * @param {string} header
 * @returns {string[]}
 */
function lockSectionKeys(docLines, header) {
  const headerRe = new RegExp(`^${header}:\\s*$`);
  const start = docLines.findIndex((l) => headerRe.test(l));
  if (start === -1) return [];
  /** @type {string[]} */
  const keys = [];
  for (let i = start + 1; i < docLines.length; i++) {
    const line = docLines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (/^[^\s#]/.test(line)) break;
    if (!/^ {2}\S/.test(line)) continue;
    const idx = line.search(/:\s|:$/);
    if (idx === -1) throw new Error(`pnpm-lock.yaml line ${i + 1}: cannot read ${header} entry '${line.trim()}'`);
    keys.push(line.slice(2, idx));
  }
  return keys;
}

/**
 * 'undici@7.30.1' / ''@babel/code-frame@7.29.7'' / 'pkg@1.0.0(peer@2)' -> {name, version}.
 * Alias-spec keys ('name@npm:...') and tarball/git keys return null: alerts never
 * range-match those and a caret floor cannot force them, so they stay out of the map.
 * @param {string} rawKey
 * @returns {{ name: string, version: string } | null}
 */
function packageKeyToNameVersion(rawKey) {
  const key = unquote(rawKey);
  const paren = key.indexOf('('); // snapshot peer suffix: name@version(peers...)
  const bare = paren === -1 ? key : key.slice(0, paren);
  const at = bare.lastIndexOf('@');
  if (at <= 0) return null;
  const name = bare.slice(0, at);
  const version = bare.slice(at + 1);
  if (!name || !version) return null;
  if (name.includes(':') || NAMED_PROTOCOL_RE.test(version)) return null;
  return {name, version};
}

/**
 * Every key under `packages:` and `snapshots:` of the main document, name -> versions;
 * quoting and `(peer...)` suffixes stripped, the two sections collapse into one set.
 * @param {string} lockText
 * @returns {VersionMap}
 */
export function lockVersions(lockText) {
  const doc = selectLockDocument(lockText);
  /** @type {VersionMap} */
  const map = new Map();
  for (const header of ['packages', 'snapshots']) {
    for (const rawKey of lockSectionKeys(doc, header)) {
      const nv = packageKeyToNameVersion(rawKey);
      if (nv) addVersion(map, nv.name, nv.version);
    }
  }
  return map;
}

/**
 * The same map from an npm package-lock.json v3; nested copies count (the name is the
 * segment after the last `node_modules/`), links and the root entry carry no version.
 * A lockfile without a packages map yields an empty map ÔÇö planFloors plans the pnpm
 * route only, so this map feeds verification rather than planning.
 * @param {{ packages?: Record<string, { link?: boolean, version?: string } | undefined> } | null | undefined} lockJson
 * @returns {VersionMap}
 */
export function npmLockVersions(lockJson) {
  /** @type {VersionMap} */
  const map = new Map();
  const packages = lockJson?.packages;
  if (!packages) return map;
  for (const [path, pkg] of Object.entries(packages)) {
    if (!path || !pkg || pkg.link === true) continue;
    // An alias ('npm:other@1.0.0') or a git/URL spec is not a registry version of this name.
    if (typeof pkg.version !== 'string' || !SEMVER_RE.test(pkg.version)) continue;
    const at = path.lastIndexOf(NODE_MODULES);
    if (at === -1) continue;
    addVersion(map, path.slice(at + NODE_MODULES.length), pkg.version);
  }
  return map;
}

// ---- ranges ------------------------------------------------------------------

/**
 * Parse a GitHub advisory `vulnerable_version_range` ("< 1.2.3", ">= 7.18.0, < 7.30.1",
 * "<= 0.6.0", "= 1.0.0", ">= 2.0.0") into an AND of comparators over released x.y.z
 * versions; the compare is numeric, never lexical ("0.10.0" > "0.9.0"). Anything else
 * throws: exotic ranges are declined at routing time, so a throw here is a bug.
 * @param {string} range
 * @returns {RangePredicate}
 */
export function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') {
    throw new Error(`unsupported vulnerable_version_range: ${JSON.stringify(range)}`);
  }
  /** @type {{ op: string, version: [number, number, number] }[]} */
  const comparators = range.split(',').map((part) => {
    const m = /^\s*(<=|>=|<|>|=)\s*(\d+\.\d+\.\d+)\s*$/.exec(part);
    if (!m) throw new Error(`unsupported vulnerable_version_range: ${JSON.stringify(range)} (part '${part.trim()}')`);
    return {op: m[1], version: parseXyz(m[2])};
  });
  return (version) => {
    const t = parseXyz(version); // throws for prereleases etc; scanners filter to releases first
    return comparators.every(({op, version: v}) => {
      const c = cmpTriples(t, v);
      if (op === '<') return c < 0;
      if (op === '<=') return c <= 0;
      if (op === '>') return c > 0;
      if (op === '>=') return c >= 0;
      return c === 0;
    });
  };
}

// ---- planning ----------------------------------------------------------------

/**
 * Turn due, already-routed alerts into override floors for the pnpm route
 * (manifest_path 'pnpm-lock.yaml'; anything else declines with a reason). The caller
 * supplies the current lockfile as name -> versions and the workspace file text.
 * @param {Alert[]} alerts
 * @param {VersionMap} versions
 * @param {string} workspaceText
 * @param {string} today 'YYYY-MM-DD'; unused here ÔÇö applyFloors stamps it into the comments
 * @returns {Plan}
 */
export function planFloors(alerts, versions, workspaceText, today) {
  const lines = workspaceText.split('\n');
  const overrides = findSection(lines, 'overrides');
  if (!overrides) throw new Error('pnpm-workspace.yaml: no column-0 `overrides:` block');
  const entries = parseEntries(lines, overrides);
  /** @type {Set<string>} */
  const patchedNames = new Set();
  const patchedSection = findSection(lines, 'patchedDependencies'); // keys like 'hls.js@1.7.3'
  if (patchedSection) {
    for (const entry of parseEntries(lines, patchedSection)) {
      const nv = packageKeyToNameVersion(entry.key);
      if (nv) patchedNames.add(nv.name);
    }
  }

  /** @type {Decline[]} */
  const declined = [];
  /** @type {Map<string, { name: string, major: number, items: { alert: number, patched: string }[] }>} */
  const groups = new Map();

  for (const alert of alerts) {
    const number = alert.number;
    if (alert.dependency.manifest_path !== 'pnpm-lock.yaml') {
      declined.push({alert: number, reason: `unsupported manifest_path: ${alert.dependency.manifest_path}`});
      continue;
    }
    const patchedId = alert.security_vulnerability.first_patched_version?.identifier;
    if (!patchedId) {
      declined.push({alert: number, reason: 'no first patched version'});
      continue;
    }
    if (!XYZ_RE.test(patchedId)) {
      declined.push({alert: number, reason: 'patched version is not x.y.z'});
      continue;
    }
    const rangeText = alert.security_vulnerability.vulnerable_version_range;
    /** @type {RangePredicate} */
    let inRange;
    try {
      inRange = parseRange(rangeText);
    } catch {
      declined.push({alert: number, reason: `unsupported vulnerable_version_range: ${rangeText}`});
      continue;
    }
    const name = alert.dependency.package.name;
    // Released x.y.z only: GitHub ranges cannot match prereleases either.
    const vulnerable = [...(versions.get(name) ?? [])].filter((v) => XYZ_RE.test(v) && inRange(v));
    if (vulnerable.length === 0) {
      // Covers both "no vulnerable version" and "a floor already applied (GitHub lag)".
      declined.push({alert: number, reason: 'stale: no vulnerable version in the lockfile'});
      continue;
    }
    for (const v of vulnerable) {
      const major = parseXyz(v)[0];
      const key = `${name}@${major}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = {name, major, items: []}));
      // One alert once per major, however many vulnerable copies of that major the tree holds.
      if (!group.items.some((item) => item.alert === number)) group.items.push({alert: number, patched: patchedId});
    }
  }

  /** @type {Floor[]} */
  const floors = [];

  for (const group of groups.values()) {
    const {name, major} = group;
    const ok = group.items.filter((item) => parseXyz(item.patched)[0] === major);
    for (const item of group.items) {
      const fixed = parseXyz(item.patched)[0];
      if (fixed !== major) {
        declined.push({alert: item.alert, reason: `the fix is a new major (${major} -> ${fixed}): a person decides`});
      }
    }
    if (ok.length === 0) continue;
    if (patchedNames.has(name)) {
      for (const item of ok) {
        declined.push({alert: item.alert, reason: `package '${name}' is keyed in patchedDependencies: human decision`});
      }
      continue;
    }

    /** @type {Set<number>} */
    const treeMajors = new Set();
    for (const v of versions.get(name) ?? []) {
      const t = splitVersion(v);
      if (t) treeMajors.add(t.major);
    }
    const multiMajor = treeMajors.size >= 2;
    const plainSelector = multiMajor ? `${name}@${major}` : name;

    // Relevant existing entries: selectorless by name, `name@m` by name + major, and a
    // `name@n` whose value sends major n's requests into this major (`encoding-sniffer@0:
    // ^1.0.2`): what the tree holds of this major came through it. Other plain majors of the
    // package are separate floors (one entry per major); path keys ("web-ext>@pkg", '-'
    // removals) are human artifacts we never touch; a selector we cannot model declines the
    // group rather than being second-guessed.
    /** @type {WorkspaceEntry | null} */
    let selectorless = null;
    /** @type {WorkspaceEntry | null} */
    let selected = null;
    /** @type {WorkspaceEntry | null} */
    let redirect = null;
    /** @type {string | null} */
    let unmodelable = null;
    for (const entry of entries) {
      if (entry.key === name) {
        selectorless = entry;
      } else if (entry.key.startsWith(`${name}@`)) {
        const tail = entry.key.slice(name.length + 1);
        if (tail === String(major)) selected = entry;
        else if (!NUMERIC_RE.test(tail)) unmodelable = entry.key;
        else if (CARET_RE.test(entry.value) && parseXyz(entry.value.slice(1))[0] === major) redirect = entry;
      } else if (entry.key.endsWith(`>${name}`) || entry.key.includes(`>${name}@`)) {
        // A parent-scoped key ('web-ext>pkg') wins over a plain one in pnpm: ours would do nothing.
        unmodelable = entry.key;
      }
    }
    if (unmodelable) {
      for (const item of ok) declined.push({alert: item.alert, reason: `existing override '${unmodelable}' has a selector we cannot model`});
      continue;
    }
    if (selectorless && (multiMajor || selected)) {
      const reason = multiMajor ?
        `override '${name}' is selectorless but the tree holds majors ${[...treeMajors].sort((a, b) => a - b).join(', ')}` :
        `existing overrides hold both '${name}' and '${name}@${major}'`;
      for (const item of ok) declined.push({alert: item.alert, reason});
      continue;
    }
    if (redirect && (selectorless || selected)) {
      // Two keys reach this major's requests: which one pnpm applies is not ours to guess.
      const other = /** @type {WorkspaceEntry} */ (selectorless ?? selected);
      for (const item of ok) {
        declined.push({alert: item.alert, reason: `existing overrides '${redirect.key}: ${redirect.value}' and '${other.key}' both reach major ${major}`});
      }
      continue;
    }
    const matched = selectorless ?? selected ?? redirect;
    if (matched && !CARET_RE.test(matched.value)) {
      // Alias values ('npm:...'), '-' removals and tilted specs stay human territory.
      for (const item of ok) {
        declined.push({alert: item.alert, reason: `existing override '${matched.key}' is not a plain ^x.y.z: '${matched.value}'`});
      }
      continue;
    }

    const maxPatched = ok.map((item) => item.patched).reduce((m, p) => (cmpVersions(p, m) > 0 ? p : m));
    let selector = plainSelector;
    /** @type {Floor['action']} */
    let action = 'add';
    /** @type {string | undefined} */
    let from;
    if (matched) {
      selector = matched.key;
      const oldTriple = parseXyz(matched.value.slice(1));
      const newTriple = parseXyz(maxPatched);
      const c = cmpTriples(oldTriple, newTriple);
      if (c >= 0) {
        // main asks for this fix already, and the lockfile still holds a vulnerable version:
        // the override does not take as written, and another floor would not either.
        for (const item of ok) {
          declined.push({alert: item.alert, reason: `the override '${matched.key}: ${matched.value}' on main asks for the fix already, yet the lockfile holds a vulnerable ${name}: it does not apply as written`});
        }
        continue;
      } else if (oldTriple[0] === newTriple[0]) {
        action = 'raise';
        from = matched.value;
      } else {
        for (const item of ok) {
          declined.push({alert: item.alert, reason: `existing override '${matched.key}' forces major ${oldTriple[0]} but the fix lands in ${newTriple[0]}`});
        }
        continue;
      }
    }
    /** @type {Floor} */
    const floor = {name, selector, floor: `^${maxPatched}`, alerts: ok.map((item) => item.alert), action};
    if (from !== undefined) floor.from = from;
    floors.push(floor);
  }

  const seen = new Set();
  const once = declined.filter((d) => !seen.has(`${d.alert} ${d.reason}`) && seen.add(`${d.alert} ${d.reason}`));
  return {floors, declined: once};
}

// ---- applying ----------------------------------------------------------------

/**
 * Word-wrap to comment lines of at most `width` columns, each prefixed '  # '.
 * A token wider than the text width is cut at the boundary ÔÇö the spec says the
 * summary is cut to fit, so nothing may widen the block beyond 100 columns.
 * @param {string} text single-spaced, single-line text
 * @param {number} width
 * @returns {string[]}
 */
function wrapComment(text, width) {
  const max = width - '  # '.length;
  /** @type {string[]} */
  const out = [];
  let line = '';
  for (let word of text.split(' ')) {
    while (word.length > max) {
      if (line !== '') {
        out.push(line);
        line = '';
      }
      out.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out.map((l) => `  # ${l}`);
}

/**
 * The mechanical comment for one alert: automation cannot write the "why is this safe"
 * prose (humans extend the block by hand on the PR), it stamps only the traceable facts.
 * @param {Alert} alert
 * @param {string} name
 * @param {string} today
 * @returns {string[]}
 */
function alertCommentLines(alert, name, today) {
  const severity = alert.security_advisory.severity;
  const range = alert.security_vulnerability.vulnerable_version_range;
  const summary = String(alert.security_advisory.summary ?? '').replace(/\s+/g, ' ').trim();
  return wrapComment(
      `Dependabot #${alert.number} (${today}, ${severity}): ${name} ${range}: ${summary}. Floor added by security-alerts.yml.`,
      100,
  );
}

/**
 * Apply the planned floors to pnpm-workspace.yaml by line surgery: a raise rewrites the
 * value in place and stamps a dated line directly above the entry; an add appends the
 * per-alert comment blocks plus the entry at the end of the overrides block, before the
 * next column-0 key. Every other byte is preserved so the explanatory comments survive.
 * @param {string} workspaceText
 * @param {Floor[]} floors
 * @param {Map<number, Alert> | Record<number, Alert>} alertsByNumber
 * @param {string} today 'YYYY-MM-DD', stamped into the generated comment lines
 * @returns {string}
 */
export function applyFloors(workspaceText, floors, alertsByNumber, today) {
  if (typeof today !== 'string' || today === '') {
    throw new TypeError('applyFloors: `today` is stamped into comments and must be a non-empty string');
  }
  const lines = workspaceText.split('\n');
  const section = findSection(lines, 'overrides');
  if (!section) throw new Error('pnpm-workspace.yaml: no column-0 `overrides:` block');
  const entries = parseEntries(lines, section);
  /** @param {number} n @returns {Alert | undefined} */
  const getAlert = (n) => (alertsByNumber instanceof Map ? alertsByNumber.get(n) : alertsByNumber[n]);

  /** @type {{ line: number, valueStart: number, value: string, comment: string }[]} */
  const raises = [];
  /** @type {string[]} */
  const added = [];

  for (const floor of floors) {
    if (floor.action === 'none') continue;
    if (!CARET_RE.test(floor.floor) || !SELECTOR_RE.test(floor.selector) || !String(floor.selector).startsWith(floor.name)) {
      throw new Error(`applyFloors: not a floor to write: ${JSON.stringify(floor)}`);
    }
    if (floor.action === 'raise') {
      const entry = entries.find((e) => e.key === floor.selector);
      if (!entry) throw new Error(`applyFloors: no existing override line for '${floor.selector}' to raise`);
      raises.push({
        line: entry.line,
        valueStart: entry.valueStart,
        value: floor.floor,
        comment: `  # ${today}: raised to ${floor.floor} (Dependabot ${floor.alerts.map((n) => `#${n}`).join(', ')})${entry.raw.endsWith('\r') ? '\r' : ''}`,
      });
      continue;
    }
    if (entries.some((e) => e.key === floor.selector)) {
      throw new Error(`applyFloors: override '${floor.selector}' already exists; a duplicate key would corrupt the file`);
    }
    for (const n of floor.alerts) {
      const alert = getAlert(n);
      if (!alert) throw new Error(`applyFloors: alertsByNumber is missing alert #${n}`);
      for (const line of alertCommentLines(alert, floor.name, today)) added.push(line);
    }
    added.push(`  ${keyToText(floor.selector)}: ${floor.floor}`);
  }

  // Raises bottom-up so the line indices of the remaining ones stay valid.
  raises.sort((a, b) => b.line - a.line);
  for (const r of raises) {
    const old = lines[r.line];
    const end = old.endsWith('\r') ? '\r' : '';
    const quote = /^['"]/.test(old.slice(r.valueStart)) ? old[r.valueStart] : '';
    lines[r.line] = `${old.slice(0, r.valueStart)}${quote}${r.value}${quote}${end}`;
    lines.splice(r.line, 0, r.comment);
  }
  if (added.length > 0) {
    // Re-find the terminator: the inserts from raises above shifted it downwards.
    const end = findSection(lines, 'overrides')?.end;
    if (end === undefined) throw new Error('pnpm-workspace.yaml: no column-0 `overrides:` block');
    lines.splice(end, 0, ...added);
  }
  return lines.join('\n');
}

// ---- verification --------------------------------------------------------------

/**
 * What must hold before the run is allowed to push; one message per problem.
 * (a) any in-tree version of an alerted package still inside its range; (b) any floor
 * whose spec is not met by every in-tree version its selector covers ('name@m': the
 * versions with major m, 'name': all); (c) any package outside the floors whose version
 * set drifted between the old and new lockfiles. The caller passes one route's alerts
 * and the old/new maps of that route's lockfile.
 * @param {Alert[]} alerts
 * @param {VersionMap} oldVersions
 * @param {VersionMap} newVersions
 * @param {Floor[]} floors
 * @returns {string[]}
 */
export function verifyLock(alerts, oldVersions, newVersions, floors) {
  /** @type {string[]} */
  const problems = [];

  for (const alert of alerts) {
    const name = alert.dependency.package.name;
    const rangeText = alert.security_vulnerability.vulnerable_version_range;
    /** @type {RangePredicate} */
    let inRange;
    try {
      inRange = parseRange(rangeText);
    } catch {
      problems.push(`alert #${alert.number}: cannot parse vulnerable_version_range '${rangeText}'`);
      continue;
    }
    for (const v of newVersions.get(name) ?? []) {
      if (!XYZ_RE.test(v)) {
        problems.push(`alert #${alert.number}: ${name}@${v} is not a plain release, and cannot be checked against '${rangeText}'`);
      } else if (inRange(v)) {
        problems.push(`alert #${alert.number}: ${name}@${v} is still inside '${rangeText}'`);
      }
    }
  }

  for (const floor of floors) {
    const floorBase = floor.floor.slice(1);
    if (!XYZ_RE.test(floorBase)) throw new Error(`verifyLock: unsupported floor value '${floor.floor}'`);
    // A `name@n` floor governs the major its value names: n itself, or for a key that sends
    // major n's requests to another major, that one.
    /** @type {number | null} */
    let majorFilter = null;
    if (floor.selector !== floor.name) {
      if (!floor.selector.startsWith(`${floor.name}@`)) {
        throw new Error(`verifyLock: unsupported selector '${floor.selector}'`);
      }
      const tail = floor.selector.slice(floor.name.length + 1);
      if (!NUMERIC_RE.test(tail)) throw new Error(`verifyLock: unsupported selector '${floor.selector}'`);
      majorFilter = parseXyz(floorBase)[0];
    }
    for (const v of newVersions.get(floor.name) ?? []) {
      const t = splitVersion(v);
      if (majorFilter !== null && (!t || t.major !== majorFilter)) continue;
      if (!satisfiesCaret(v, floorBase)) {
        problems.push(`floor '${floor.selector}: ${floor.floor}' is not met by ${floor.name}@${v}`);
      }
    }
  }

  // Churn outside the floors usually means a stale lockfile on main, not our edit. Only the
  // majors a floor covers may change (a selectorless floor covers them all).
  /** @type {Map<string, Set<number>|'all'>} */
  const covered = new Map();
  for (const floor of floors) {
    if (floor.selector === floor.name) {
      covered.set(floor.name, 'all');
    } else if (covered.get(floor.name) !== 'all') {
      const majors = /** @type {Set<number>} */ (covered.get(floor.name) || new Set());
      majors.add(parseXyz(floor.floor.slice(1))[0]);
      covered.set(floor.name, majors);
    }
  }
  /** @param {string} name @param {string} v */
  const exempt = (name, v) => {
    const c = covered.get(name);
    if (c === 'all') return true;
    const t = splitVersion(v);
    return Boolean(c && t && c.has(t.major));
  };
  // Any order will do, as long as it is the same both times: no version is left out for its shape.
  /** @param {string} name @param {VersionMap} map */
  const listed = (name, map) => [...(map.get(name) ?? [])].filter((v) => !exempt(name, v)).sort().join(', ') || '(none)';
  const names = [...new Set([...oldVersions.keys(), ...newVersions.keys()])].sort();
  for (const name of names) {
    const before = listed(name, oldVersions);
    const after = listed(name, newVersions);
    if (before !== after) {
      problems.push(`the lockfile changed more than the floors: ${name} ${before} -> ${after}`);
    }
  }
  return problems;
}

// ---- the workflow's two steps ---------------------------------------------------

/**
 * An alert as security-alerts.yml's fetch_alerts flattens it.
 * @typedef {{number: number, created_at?: string, package: string, manifest: string, severity?: string,
 *     summary?: string, range: string, patched?: string|null}} FlatAlert
 */

/**
 * An alert as security-alerts.yml's fetch_alerts flattens it, back in the REST shape the
 * functions above read.
 * @param {FlatAlert} flat
 * @return {Alert}
 */
export function fromFlat(flat) {
  return {
    number: flat.number,
    dependency: {manifest_path: flat.manifest, package: {name: flat.package}},
    security_advisory: {ghsa_id: '', severity: flat.severity || '', summary: flat.summary || ''},
    security_vulnerability: {
      vulnerable_version_range: flat.range,
      first_patched_version: flat.patched ? {identifier: flat.patched} : null,
    },
  };
}

/**
 * The check job's plan: the floors for the flattened alerts, which of them the pull request
 * takes (handled), the declines, and the edited pnpm-workspace.yaml when a floor changes it.
 * versions: what the lockfile holds now of each floored package, verify's "before".
 * @param {{alerts: FlatAlert[], lockText: string, workspaceText: string, today: string, baseSha: string}} input
 * @return {{plan: {lockfile: string, base_sha: string, handled: number[], floors: Floor[], declined: Decline[], alerts: FlatAlert[], versions: Object<string, string[]>}, routing: {handled: number[], declined: Decline[]}, workspace: string|null}}
 */
export function planBundle({alerts, lockText, workspaceText, today, baseSha}) {
  const versions = lockVersions(lockText);
  const rest = alerts.map(fromFlat);
  const {floors, declined} = planFloors(rest, versions, workspaceText, today);
  const handled = [...new Set(floors.flatMap((floor) => floor.alerts))].sort((a, b) => a - b);
  /** @type {Object<string, string[]>} */
  const before = {};
  for (const floor of floors) before[floor.name] = [...(versions.get(floor.name) ?? [])];
  const workspace = floors.length ? applyFloors(workspaceText, floors, new Map(rest.map((alert) => [alert.number, alert])), today) : null;
  return {
    plan: {lockfile: 'pnpm-lock.yaml', base_sha: baseSha, handled, floors, declined, alerts, versions: before},
    routing: {handled, declined},
    workspace,
  };
}

/**
 * The install job's check of the lockfile pnpm wrote: the alerts the pull request takes are
 * fixed by it, its floors hold, and nothing else moved. Reads nothing else (no token there).
 * @param {{handled: number[], floors: Floor[], alerts: FlatAlert[], versions: Object<string, string[]>}} plan
 * @param {string} lockText - The new pnpm-lock.yaml.
 * @return {{ok: boolean, problems: string[]}}
 */
export function verifyBundle(plan, lockText) {
  const before = new Map(Object.entries(plan.versions || {}).map(([name, list]) => [name, new Set(list)]));
  const after = lockVersions(lockText);
  // The floored packages only: the rest of the lockfile is compared as a whole below.
  const scoped = new Map([...after].filter(([name]) => before.has(name)));
  const taken = plan.alerts.filter((alert) => plan.handled.includes(alert.number)).map(fromFlat);
  const problems = verifyLock(taken, before, scoped, plan.floors);
  return {ok: problems.length === 0, problems};
}

/**
 * Everything but the floored packages, name@version a line: the install job compares the
 * lockfile before and after with it, so a floor that moved anything else is caught.
 * @param {string} lockText
 * @param {string[]} floored
 * @return {string}
 */
export function unfloored(lockText, floored) {
  const skip = new Set(floored);
  return [...lockVersions(lockText)].filter(([name]) => !skip.has(name))
      .flatMap(([name, set]) => [...set].map((version) => `${name}@${version}`)).sort().join('\n');
}

//   node tools/security-overrides.mjs plan <alerts.json> <out-dir>
//     in a checkout of main: reads pnpm-lock.yaml and pnpm-workspace.yaml, writes plan.json,
//     routing.json and (when a floor changes it) pnpm-workspace.yaml into <out-dir>.
//   node tools/security-overrides.mjs verify <dir>
//     reads <dir>/plan.json, <dir>/pnpm-lock.yaml (pnpm's new one) and <dir>/before.lock.yaml
//     (main's); prints the problems and exits 1 when there are any.
/**
 * `plan <alerts.json> <out-dir>`, in a checkout of main.
 * @param {string} alertsFile
 * @param {string} out
 */
async function runPlan(alertsFile, out) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const {execFileSync} = await import('node:child_process');
  const {plan, routing, workspace} = planBundle({
    alerts: JSON.parse(fs.readFileSync(alertsFile, 'utf8')),
    lockText: fs.readFileSync('pnpm-lock.yaml', 'utf8'),
    workspaceText: fs.readFileSync('pnpm-workspace.yaml', 'utf8'),
    today: new Date().toISOString().slice(0, 10),
    baseSha: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  });
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'routing.json'), `${JSON.stringify(routing, null, 2)}\n`);
  if (workspace !== null) fs.writeFileSync(path.join(out, 'pnpm-workspace.yaml'), workspace);
  console.log(`plan: ${plan.floors.length} floor(s) for ${routing.handled.length} alert(s), ${routing.declined.length} declined`);
}

/**
 * `verify <dir>`: plan.json, pnpm's new pnpm-lock.yaml and main's before.lock.yaml in <dir>.
 * @param {string} dir
 */
async function runVerify(dir) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  const lockText = fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8');
  const {problems} = verifyBundle(plan, lockText);
  const floored = plan.floors.map((/** @type {Floor} */ floor) => floor.name);
  if (unfloored(fs.readFileSync(path.join(dir, 'before.lock.yaml'), 'utf8'), floored) !== unfloored(lockText, floored)) {
    problems.push('the lockfile changed more than the floored packages (run `pnpm install` on main first, perhaps)');
  }
  for (const problem of problems) console.error(`- ${problem}`);
  if (problems.length) {
    process.exitCode = 1;
  } else {
    console.log(`verify: the ${plan.handled.length} alert(s) taken are fixed, and only the floored packages moved`);
  }
}

/** The commands, by name, with the number of arguments each takes. */
/** @type {Map<string, {count: number, run: (args: string[]) => Promise<void>}>} */
const COMMANDS = new Map([
  ['plan', {count: 2, run: (args) => runPlan(args[0], args[1])}],
  ['verify', {count: 1, run: (args) => runVerify(args[0])}],
]);

async function main() {
  const [name, ...args] = process.argv.slice(2);
  const command = COMMANDS.get(name || '');
  if (!command || args.length !== command.count) {
    console.error('usage: node tools/security-overrides.mjs plan <alerts.json> <out-dir> | verify <dir>');
    process.exitCode = 2;
    return;
  }
  await command.run(args);
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  await main();
}
