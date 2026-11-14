// @ts-check
// Sites where autoplay could not go on (his wish, 2026-10-11): kept per site and kind, newest
// first, for the options page to list and report as a GitHub issue the user reviews. Only the
// page's host and path are kept - a query often carries a session token.

const StorageKey = 'siteProblems';
const MaxEntries = 50;

/** What went wrong, as the options page names it. */
export const ProblemKinds = Object.freeze({
  // No next episode found in the page: the last one, or a site FastStream cannot read yet.
  NO_NEXT: 'no_next',
  // Went on to the next episode's page, and no video came from it within a minute.
  NO_STREAM: 'no_stream',
});

/**
 * A site's problem of one kind, as the list keeps it.
 * @typedef {Object} ProblemEntry
 * @property {string} id - Its host and kind.
 * @property {string} [protocol] - Not in an entry noted before it was kept.
 * @property {string} host
 * @property {string} path - The page's path, without its query.
 * @property {string} kind - One of ProblemKinds.
 * @property {'player'|'mpv'} mode
 * @property {number} count
 * @property {number} first - When it was first noted (ms since 1970).
 * @property {number} last - When it was last noted.
 */

/**
 * The list as stored.
 * @return {Promise<Array<ProblemEntry>>}
 */
export async function readProblems() {
  // The callback form: every page that reads it has it (the options page's tests too).
  const stored = await new Promise((resolve) => chrome.storage.local.get(StorageKey, resolve));
  const list = stored?.[StorageKey];
  return Array.isArray(list) ? list : [];
}

// The changes to the list, one after the other: two notes at once (two tabs, the player's and
// mpv's) read the same list, and the second write lost the first (final review, 2026-10-11).
let changes = Promise.resolve();

/**
 * Runs a change of the list after the ones before it.
 * @param {() => Promise<void>} change
 * @return {Promise<void>}
 */
function queued(change) {
  const done = changes.then(change);
  changes = done.catch(() => {});
  return done;
}

/**
 * Notes a problem on a page: a second one of the same kind on the same site counts up.
 * @param {{url: string, kind: string, mode: 'player'|'mpv'}} problem
 * @param {number} [now]
 * @return {Promise<void>}
 */
export function recordProblem(problem, now = Date.now()) {
  return queued(() => note(problem, now));
}

/**
 * recordProblem's change.
 * @param {{url: string, kind: string, mode: 'player'|'mpv'}} problem
 * @param {number} now
 * @return {Promise<void>}
 */
async function note({url, kind, mode}, now) {
  if (!Object.values(ProblemKinds).includes(/** @type {"no_next" | "no_stream"} */ (kind))) return;
  let page;
  try {
    page = new URL(url);
  } catch (e) {
    return;
  }
  if (!/^https?:$/.test(page.protocol)) return;
  const list = await readProblems();
  const id = `${page.host} ${kind}`;
  const entry = list.find((e) => e.id === id);
  if (entry) {
    entry.count++;
    entry.last = now;
    entry.path = page.pathname;
    entry.protocol = page.protocol;
    entry.mode = mode;
  } else {
    list.push({id, protocol: page.protocol, host: page.host, path: page.pathname, kind, mode, count: 1, first: now, last: now});
  }
  list.sort((a, b) => b.last - a.last);
  await store(list.slice(0, MaxEntries));
}

/**
 * Empties the list (after a note still being made, which would bring it back).
 * @return {Promise<void>}
 */
export function clearProblems() {
  return queued(() => store([]));
}

/**
 * Writes the list.
 * @param {Array<ProblemEntry>} list
 * @return {Promise<void>}
 */
function store(list) {
  return new Promise((resolve) => chrome.storage.local.set({[StorageKey]: list}, () => resolve()));
}

/**
 * The GitHub issue a report opens, for the user to check and submit: the site, what went
 * wrong, the versions. English, for the repository.
 * @param {ProblemEntry} entry - One of the list.
 * @param {{version: string, browser: string}} about
 * @return {string} The new-issue address.
 */
export function issueUrl(entry, about) {
  const what = entry.kind === ProblemKinds.NO_NEXT ?
    'autoplay found no next episode on the page (the last episode, or a page FastStream cannot read yet)' :
    'autoplay went on to the next episode\'s page, and no video came from it within a minute';
  const title = `Autoplay: ${entry.host} - ${entry.kind === ProblemKinds.NO_NEXT ? 'no next episode found' : 'next episode brought no video'}`;
  const body = [
    `**Site:** ${entry.host}`,
    `**Page:** ${entry.protocol || 'https:'}//${entry.host}${entry.path} (the address without its query)`,
    `**What happened:** ${what}`,
    `**Where:** ${entry.mode === 'mpv' ? 'MPV mode' : 'the FastStream player'}`,
    `**Seen:** ${entry.count} time(s), first ${new Date(entry.first).toISOString().slice(0, 10)}, ` +
      `last ${new Date(entry.last).toISOString().slice(0, 10)}`,
    `**FastStream:** ${about.version}`,
    `**Browser:** ${about.browser}`,
    '',
    '_Sent from FastStream\'s options page. GitHub issues are public: remove anything you do not want to share before you submit._',
  ].join('\n');
  return 'https://github.com/Nawid3333/FastStream/issues/new?' +
    new URLSearchParams({title, body}).toString();
}
