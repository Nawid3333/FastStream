// sample.mp4 for CI's e2e setup (.github/actions/e2e-setup), which keeps it in the Actions
// cache: test-videos.co.uk, where it comes from, may be down (#256).
//
//   node tests/e2e/mp4FixtureCli.mjs pin      the SHA-256 it is pinned to: the cache key
//   node tests/e2e/mp4FixtureCli.mjs ensure   makes sure the pinned file is there, fetching
//                                             it if the cache had none or another file
//
// Says what it found, for the job's log.

import {ensureMp4Fixture, MP4_FIXTURE, MP4_FIXTURE_PIN} from './mp4Fixture.mjs';

const SAID = {
  kept: 'the pinned file was there (on CI: the cache had it)',
  fetched: 'there was none (on CI: the cache had none); fetched it',
  replaced: 'there was another file; fetched the pinned one',
};

const [command] = process.argv.slice(2);
if (command === 'pin') {
  console.log(MP4_FIXTURE_PIN.sha256);
} else if (command === 'ensure') {
  const {action, reason} = await ensureMp4Fixture();
  console.log(`${MP4_FIXTURE}: ${SAID[action]}${reason ? ` (it had ${reason})` : ''}. ` +
    `It is ${MP4_FIXTURE_PIN.size} bytes, SHA-256 ${MP4_FIXTURE_PIN.sha256}.`);
} else {
  console.error('usage: node tests/e2e/mp4FixtureCli.mjs pin|ensure');
  process.exit(2);
}
