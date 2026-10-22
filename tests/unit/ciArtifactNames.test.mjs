import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// runner-images.yml calls ci.yml twice in one run (the image -latest gives, and the next
// one), and an artifact's name belongs to the run: upload-artifact refuses a second upload
// of a name, which failed the second call over nothing its image did. A called run names
// its artifacts after its images; a push, pull request or dispatch run has no inputs and
// keeps the plain names (auto-release.yml and update-prs.yml download faststream-bundles,
// flaky-specs.yml reads every artifact starting e2e-retried).

const root = path.resolve(import.meta.dirname, '..', '..');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const suffix = '${{ inputs.linux-runner && format(\'-{0}-{1}\', inputs.linux-runner, inputs.windows-runner) || \'\' }}';

// Each upload-artifact step's name: the first "name:" line after its uses: line.
const names = [...ci.matchAll(/uses: actions\/upload-artifact@\S+/g)].map((match) => {
  const line = ci.slice(match.index).split('\n').find((l) => /^\s+name: /.test(l)) || '';
  return line.trim().replace(/^name: /, '');
});

describe('ci.yml\'s artifact names', () => {
  it('differ between the two runs runner-images.yml calls, and stay plain otherwise', () => {
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      expect(name.endsWith(suffix), name).toBe(true);
    }
    expect(names).toContain('faststream-bundles' + suffix);
    expect(names.some((name) => name.startsWith('e2e-retried-'))).toBe(true);
  });
});
