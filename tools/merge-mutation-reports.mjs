// mutation-tests.yml's report job: the shards' reports, as their artifacts were downloaded
// (shards/mutation-reports-<shard>/mutation.json), put together into the one report the
// summary and the week's issue read (reports/mutation/mutation.json). No arguments: the
// paths are the job's own, and a shard without a report is left out (the step names it).
import fs from 'node:fs';
import path from 'node:path';
import {merge} from './mutation-report.mjs';

const reports = [];
for (const artifact of fs.readdirSync('shards').sort()) {
  let text;
  try {
    text = fs.readFileSync(path.join('shards', artifact, 'mutation.json'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') continue;
    throw e;
  }
  reports.push(JSON.parse(text));
}
fs.mkdirSync('reports/mutation', {recursive: true});
fs.writeFileSync('reports/mutation/mutation.json', JSON.stringify(merge(reports)));
