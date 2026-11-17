import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// A release page offers four files with no word on which one to take, and people took the
// unsigned zip for the add-on and thought a special Firefox was needed (the owner,
// 2026-11-17). release.yml puts .github/release-notes.md, how to install, above GitHub's
// generated list of changes; the README's Installation section says the same at length.

const root = path.resolve(import.meta.dirname, '..', '..');
const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const notesPath = path.join(root, '.github/release-notes.md');

describe('release.yml\'s install notes', () => {
  it('creates a release with the install notes above the generated ones', () => {
    const create = release.match(/gh release create [^\n]*\\\n[^\n]*/);
    expect(create).not.toBeNull();
    expect(create[0]).toContain('--notes-file .github/release-notes.md');
    expect(create[0]).toContain('--generate-notes');
  });

  it('says which file to take, that a normal Firefox takes it, and where updates come from', () => {
    const notes = fs.readFileSync(notesPath, 'utf8');
    expect(notes).toContain('`.xpi`');
    expect(notes).toContain('normal Firefox');
    expect(notes).toContain('Check for Updates');
    // The floor the manifest sets (build.mjs's strict_min_version).
    const build = fs.readFileSync(path.join(root, 'build.mjs'), 'utf8');
    const floor = build.match(/strict_min_version: '(\d+)\.0'/);
    expect(floor).not.toBeNull();
    expect(notes).toContain(`(${floor[1]} or newer)`);
  });
});
