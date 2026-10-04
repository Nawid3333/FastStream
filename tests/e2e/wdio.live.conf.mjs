// The installed extension against real streams on the internet: the playback checklist in
// docs/notes/playback-testing.md, automated (live-specs/streams.e2e.mjs says what it covers).
//
// Not part of verify or CI, on purpose: it depends on third-party servers, and an outage
// there must not hold back a release. Run it after a change to the player, the loaders or
// the vendored libraries:
//
//   pnpm run build:keep && pnpm run test:live
//
// Same add-on, same throwaway profile and harness server as wdio.extension.conf.mjs.

import path from 'node:path';

import {recordRetriedSpecs} from './retriedSpecs.mjs';
import {testTimeout} from './testTimeout.mjs';
import {BUILD, config as base} from './wdio.extension.conf.mjs';

export const config = {
  ...base,
  specs: [path.join(import.meta.dirname, 'live-specs/**/*.e2e.mjs')],
  onWorkerEnd: recordRetriedSpecs(base.outputDir, `live-${BUILD}`),
  // A slow CDN answer is not a FastStream failure; a stream that does not play is. Each
  // test carries its own budget (see the spec), and a spec file that fails still runs
  // once more in a fresh browser, as in the other suites.
  mochaOpts: {...base.mochaOpts, timeout: testTimeout(300000)},
};
