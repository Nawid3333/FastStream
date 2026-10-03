import fs from 'node:fs';
import path from 'node:path';
// js-yaml 5 has no default export, only named ones; this form reads 4 and 5 alike.
import * as yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';

// How the workflows' run: scripts call gh, where a mistake passes every stubbed test.

const dir = path.resolve(import.meta.dirname, '../../.github/workflows');
const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

/**
 * Every command of a workflow's run: scripts, a continued line (ending in a backslash)
 * joined to the next.
 * @param {string} file - The workflow file's name.
 * @return {Array<{step: string, command: string}>}
 */
function commands(file) {
  const workflow = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
  const out = [];
  for (const [id, job] of Object.entries(workflow.jobs || {})) {
    for (const step of job.steps || []) {
      if (typeof step.run !== 'string') continue;
      for (const command of step.run.replace(/\\\n/g, ' ').split('\n')) {
        if (command.trim().startsWith('#')) continue;
        out.push({step: `${file} ${id}: ${step.name || step.run.slice(0, 40)}`, command});
      }
    }
  }
  return out;
}

describe('gh in the workflows', () => {
  // gh pr list --head matches the branch name in any repository ("<owner>:<branch>" is not
  // supported), so a fork's pull request from a branch of the same name is listed too, and
  // was taken for the workflow's own (#169): assigned, labelled, edited, closed, or read as
  // the owner's decision. Each such list asks whether a pull request is a fork's, and drops
  // it (the workflow tests check the dropping).
  it('asks for isCrossRepository wherever it lists pull requests by branch', () => {
    const lists = files.flatMap(commands).filter(({command}) => /\bgh pr list\b/.test(command) && /\s(--head|-H)\s/.test(command));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.filter(({command}) => !command.includes('isCrossRepository'))).toEqual([]);
  });
});
