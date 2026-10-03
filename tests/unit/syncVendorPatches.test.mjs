import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {unappliedPatches} from '../../tools/check-patched-updates.mjs';

// tools/sync-vendor.mjs copies the libraries the extension ships out of node_modules; for the
// ones marked `patched`, pnpm must have applied the patch in patches/. Nothing checked that it
// had: with the patchedDependencies line gone (a bad merge) or another version installed, the
// stock library was copied, the build stayed green and playback broke (#176).

const yaml = (...entries) => `allowBuilds:\n  esbuild: true\npatchedDependencies:\n${entries.map((e) => `  ${e}: patches/${e}.patch`).join('\n')}\n`;
const vendor = [
  {name: 'hls.js', patched: true},
  {name: 'hls.js', patched: true},
  {name: 'fuse.js'},
  {name: 'mp4box', patched: false},
  {name: 'mp4box', patched: true},
];
const installed = (versions) => (name) => versions[name] ?? null;

describe('unappliedPatches', () => {
  it('passes when every patched library has its patch, at the installed version', () => {
    expect(unappliedPatches(vendor, yaml('hls.js@1.7.3', 'mp4box@2.4.1'),
        installed({'hls.js': '1.7.3', 'mp4box': '2.4.1', 'fuse.js': '7.5.0'}))).toEqual([]);
  });

  it('fails a library marked patched that pnpm-workspace.yaml does not patch', () => {
    const problems = unappliedPatches(vendor, yaml('mp4box@2.4.1'), installed({'hls.js': '1.7.3', 'mp4box': '2.4.1'}));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^hls\.js .*patchedDependencies has no entry/);
  });

  it('fails a patch cut against another version than the one installed', () => {
    const problems = unappliedPatches(vendor, yaml('hls.js@1.7.3', 'mp4box@2.4.1'), installed({'hls.js': '1.8.0', 'mp4box': '2.4.1'}));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^hls\.js 1\.8\.0 is installed, but its patch is cut against 1\.7\.3/);
  });

  it('leaves a library that is not installed to the copy, which reports it missing', () => {
    expect(unappliedPatches(vendor, yaml('hls.js@1.7.3', 'mp4box@2.4.1'), installed({}))).toEqual([]);
  });

  it('passes for this repository', () => {
    // sync-vendor.mjs runs it on every build; this keeps a broken pair out of a pull request.
    const root = path.resolve(import.meta.dirname, '..', '..');
    const source = fs.readFileSync(path.join(root, 'tools/sync-vendor.mjs'), 'utf8');
    // Each entry's text up to its patched key, ${...} included (mp4box's chunk entries).
    const marked = [...source.matchAll(/name: '([^']+)',(?:[^}$]|\$(?!\{)|\$\{[^}]*\})*?\bpatched: (?!false\b)/g)]
        .map((m) => ({name: m[1], patched: true}));
    expect(new Set(marked.map((lib) => lib.name))).toEqual(new Set(['hls.js', 'dashjs', 'sweetalert2', 'mp4box', 'gif.js', 'Coloris']));
    const version = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
      } catch (e) {
        return null;
      }
    };
    expect(unappliedPatches(marked, fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'), version)).toEqual([]);
  });
});
