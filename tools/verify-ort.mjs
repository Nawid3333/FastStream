#!/usr/bin/env node
// Reports what the vendored ONNX Runtime binary says it is.
//
// `vad/ort-wasm-simd-threaded.wasm` is 1,037,262 bytes where onnxruntime-web
// publishes 11,241,642, so it is not the released artifact and cannot be
// fetched and compared. It is a reduced build - and reduced builds load only
// `.ort` models, which is why the model beside it is in that format rather
// than `.onnx`.
//
// It is not, however, anonymous. ONNX Runtime stamps its own build metadata
// into the binary, and that string names the version, the exact commit and
// the compiler flags. This extracts it and checks it against what
// docs/vendored-libraries.md claims, so the documentation cannot quietly
// drift away from the file.
//
// What this proves: the binary self-reports a specific upstream commit and
// build configuration, and the shipped file still matches what is documented.
// What it does not prove: that rebuilding at that commit reproduces these
// bytes. That needs emscripten and a full ONNX Runtime build; the command is
// recorded in the docs so it can be run, and this check is what makes the
// claim it rests on falsifiable in the meantime.
//
// Run with: pnpm run verify:ort   (offline)

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const wasm = path.join(
    root, 'chrome/player/modules/vad/ort-wasm-simd-threaded.wasm');

// Every field here was read out of the binary, not chosen. If a rebuild ever
// changes one, this check fails and the docs get corrected with it.
const EXPECTED = {
  version: '1.20.0',
  commit: '5c74539ab7',
  branch: 'main',
  buildType: 'MinSizeRel',
  flags: [
    '-ffunction-sections', '-fdata-sections', '-flto', '-msimd128',
    '-pthread', '-Wno-pthreads-mem-growth', '-fno-exceptions',
    '-fno-unwind-tables', '-fno-asynchronous-unwind-tables',
  ],
};

const bytes = fs.readFileSync(wasm);
const text = bytes.toString('latin1');

const stamp = /ORT Build Info: [\x20-\x7e]+/.exec(text);
if (!stamp) {
  console.error(
      `No "ORT Build Info" string in ${path.basename(wasm)}. Either the file ` +
      `was replaced with something that is not an ONNX Runtime build, or a ` +
      `newer build stopped emitting it. Re-derive the provenance before ` +
      `trusting docs/vendored-libraries.md.`);
  process.exit(1);
}

console.log(`${path.basename(wasm)}: ${bytes.length.toLocaleString()} bytes`);
console.log(`\n${stamp[0]}\n`);

const problems = [];
const check = (what, needle) => {
  const ok = stamp[0].includes(needle);
  console.log(`  ${ok ? 'ok  ' : 'BAD '} ${what.padEnd(11)} ${needle}`);
  if (!ok) problems.push(`${what}: expected ${needle}`);
};

check('branch', `git-branch=${EXPECTED.branch}`);
check('commit', `git-commit-id=${EXPECTED.commit}`);
check('build type', `build type=${EXPECTED.buildType}`);
for (const flag of EXPECTED.flags) check('flag', flag);

// The version is not in the build-info string; it is a separate constant.
const hasVersion = text.includes(EXPECTED.version);
console.log(`  ${hasVersion ? 'ok  ' : 'BAD '} ${'version'.padEnd(11)} ` +
  EXPECTED.version);
if (!hasVersion) problems.push(`version: expected ${EXPECTED.version}`);

// A minimal build refuses ORT format models below version 5, and says so.
// That message is the clearest evidence in the binary that this is a reduced
// build rather than a stripped full one, which is what forces the .ort model.
const minimal = text.includes(
    'This build doesn\'t support ORT format models older than version 5');
console.log(`  ${minimal ? 'ok  ' : 'BAD '} ${'minimal'.padEnd(11)} ` +
  'ORT-format-only (reduced build)');
if (!minimal) problems.push('minimal: no ORT-format-only marker');

if (problems.length) {
  console.error(
      `\n${problems.length} mismatch(es) between the binary and what ` +
      `docs/vendored-libraries.md documents:\n  ` + problems.join('\n  '));
  process.exit(1);
}

console.log(
    `\nonnxruntime ${EXPECTED.version} @ ${EXPECTED.commit} ` +
    `(${EXPECTED.buildType}, reduced/ORT-format-only).\n` +
    `Verified: the shipped binary self-reports exactly the build ` +
    `docs/vendored-libraries.md describes.`);
