// @ts-check
// Fetches the signed xpi of a version already submitted to AMO, without uploading anything.
// AMO has no "signed" callback and refuses a second upload: amo-signing-failsafe.yml collects a late xpi.
// Usage: node tools/fetch-amo-signed.mjs <version> [--wait <minutes>]
//   Credentials as in tools/sign-amo.mjs: .amo-credentials.json, or AMO_API_KEY and
//   AMO_API_SECRET. The add-on id is read from build_firefox_amo/manifest.json.
//   --wait keeps asking every 30 s while the version is pending or the network fails, up to that many minutes.
// Prints `state=<state>` for the workflow and exits with:
//   0  signed   - the xpi is saved in web-ext-artifacts/
//   3  pending  - uploaded, still awaiting review: try again later
//   4  missing  - AMO has no such version: the upload never happened, sign it now
//   5  rejected - AMO disabled or rejected it: waiting will not help
//   1  error    - anything else (network, credentials)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// @ts-ignore - web-ext/util/submit-addon resolves to untyped JavaScript with no published
import {JwtApiAuth} from 'web-ext/util/submit-addon';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AMO_API = 'https://addons.mozilla.org/api/v5';

export const EXIT = {signed: 0, error: 1, pending: 3, missing: 4, rejected: 5};

/**
 * @param {number} httpStatus
 * @param {{file?: {status: string, url: string}}|null} version
 * @return {'signed'|'pending'|'missing'|'rejected'|'error'}
 */
export function signingState(httpStatus, version) {
  if (httpStatus === 404) return 'missing';
  if (httpStatus !== 200 || !version) return 'error';
  const status = version.file?.status;
  if (status === 'public' && version.file?.url) return 'signed';
  if (status === 'unreviewed') return 'pending';
  if (status === 'disabled') return 'rejected';
  return 'error';
}

function credentials() {
  const file = path.join(root, '.amo-credentials.json');
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (process.env.AMO_API_KEY && process.env.AMO_API_SECRET) {
    return {apiKey: process.env.AMO_API_KEY, apiSecret: process.env.AMO_API_SECRET};
  }
  throw new Error('no AMO credentials: .amo-credentials.json or AMO_API_KEY/AMO_API_SECRET');
}

/**
 * Node's fetch rejects with TypeError('fetch failed') and the socket error as its cause; web-ext passes it on.
 * @param {*} error
 * @return {boolean}
 */
export function isNetworkError(error) {
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
  for (let e = error; e; e = e.cause) {
    if (e.message === 'fetch failed' || codes.has(e.code)) {
      return true;
    }
  }
  return false;
}

/**
 * A check the network failed is asked again at the next interval; any other error is thrown at once.
 * @param {() => Promise<string>} check
 * @param {Object} options
 * @param {number} options.deadline - ms since the epoch.
 * @param {number} [options.interval] - ms.
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(message: string) => void} [options.log]
 * @return {Promise<string>} signed, rejected or missing; when the time runs out pending, or error if the last check failed.
 */
export async function waitForSigned(check, {
  deadline,
  interval = 30 * 1000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
  for (;;) {
    let state;
    try {
      state = await check();
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }
      state = 'error';
      log(`Asking AMO failed: ${/** @type {Error} */ (error).message}`);
    }
    if (state === 'signed' || state === 'rejected' || state === 'missing') {
      return state;
    }
    if (now() + interval > deadline) {
      return state === 'error' ? 'error' : 'pending';
    }
    await sleep(interval);
  }
}

/**
 * @param {string} version
 * @return {Promise<string>}
 */
export async function fetchSigned(version) {
  const {apiKey, apiSecret} = credentials();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'build_firefox_amo', 'manifest.json'), 'utf8'));
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (!id) {
    throw new Error('no gecko id in build_firefox_amo/manifest.json: run pnpm run build:keep first');
  }
  if (manifest.version !== version) {
    throw new Error(`build_firefox_amo is version ${manifest.version}, not ${version}: build the right tag first`);
  }

  // web-ext sign's own authentication (a short-lived HS256 token per request).
  const jwt = new JwtApiAuth({apiKey, apiSecret});
  const auth = async () => ({Authorization: await jwt.getAuthHeader()});
  // The `v` prefix makes AMO look the version up by number rather than by id.
  const response = await fetch(`${AMO_API}/addons/addon/${encodeURIComponent(id)}/versions/v${version}/`, {headers: await auth()});
  const body = response.status === 200 ? await response.json() : null;
  const state = signingState(response.status, body);
  console.log(`state=${state}`);
  console.log(`AMO: ${id} ${version}: HTTP ${response.status}${body ? `, file.status=${body.file?.status}` : ''}`);

  if (state === 'signed') {
    // The host is checked against AMO's own (CodeQL js/http-to-file-access).
    const fileUrl = new URL(body.file.url);
    if (fileUrl.protocol !== 'https:' || !/(^|\.)addons\.(mozilla\.org|allizom\.org)$/.test(fileUrl.hostname)) {
      throw new Error(`${body.file.url}: not an addons.mozilla.org download URL`);
    }
    const download = await fetch(fileUrl, {headers: await auth()});
    if (!download.ok) {
      throw new Error(`downloading ${body.file.url}: HTTP ${download.status}`);
    }
    const name = decodeURIComponent(/** @type {string} */ (fileUrl.pathname.split('/').pop()));
    if (!/^[\w.-]+\.xpi$/.test(name)) {
      throw new Error(`${name}: not a plain .xpi file name`);
    }
    const artifacts = path.join(root, 'web-ext-artifacts');
    fs.mkdirSync(artifacts, {recursive: true});
    // Guarded by the file name check and the https and AMO-host check above (CodeQL js/http-to-file-access).
    const bytes = Buffer.from(await download.arrayBuffer());
    const target = path.join(artifacts, name);
    fs.writeFileSync(target, bytes);
    console.log(`Saved web-ext-artifacts/${name} (${bytes.length} bytes)`);
  }
  return state;
}

/**
 * @param {string[]} args
 * @return {{version: string, waitMinutes: number}}
 */
export function parseArgs(args) {
  const [version, ...rest] = args;
  if (!version || version.startsWith('-')) {
    throw new Error('usage: node tools/fetch-amo-signed.mjs <version> [--wait <minutes>]');
  }
  let waitMinutes = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--wait' && /^\d+$/.test(rest[i + 1] || '')) {
      waitMinutes = Number(rest[++i]);
    } else {
      throw new Error(`unknown argument: ${rest[i]}`);
    }
  }
  return {version, waitMinutes};
}

async function main() {
  const {version, waitMinutes} = parseArgs(process.argv.slice(2));
  const state = waitMinutes > 0 ?
    await waitForSigned(() => fetchSigned(version), {deadline: Date.now() + waitMinutes * 60 * 1000}) :
    await fetchSigned(version);
  process.exitCode = EXIT[/** @type {'signed'|'pending'|'missing'|'rejected'|'error'} */ (state)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log('state=error');
    console.error(error.message);
    process.exit(EXIT.error);
  });
}
