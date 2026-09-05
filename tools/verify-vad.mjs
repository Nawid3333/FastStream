#!/usr/bin/env node
// Proves where chrome/player/modules/vad/silero_vad_half.ort came from.
//
// The voice-activity detector ships a 1.8 MB model in ONNX Runtime's `.ort`
// format. snakers4/silero-vad publishes no `.ort` at all - only `.onnx` - so
// the file cannot be fetched and compared, and a reviewer looking at it sees
// an opaque binary. This turns that into a claim anyone can re-run.
//
// The method is content, not names. Both formats store weight tensors as long
// contiguous byte runs, so a model converted from another shares those runs
// verbatim even though protobuf and flatbuffers frame them differently. This
// samples fixed-size windows from each published model and asks how many
// appear byte-for-byte somewhere in the `.ort`. The published model it was
// converted from scores overwhelmingly; the others are the control that shows
// the number means something.
//
// What this does NOT prove: the ONNX Runtime *build* beside it,
// ort-wasm-simd-threaded.wasm, is a separate problem with a separate answer -
// see docs/vendored-libraries.md. This is about the model only.
//
// Run with: pnpm run verify:vad   (needs network, downloads about 4.9 MB)

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const vendored = path.join(root, 'chrome/player/modules/vad/silero_vad_half.ort');

// Pinned by tag so this cannot start failing because upstream moved.
const TAG = 'v6.2.1';
const BASE = `https://raw.githubusercontent.com/snakers4/silero-vad/${TAG}/` +
  'src/silero_vad/data/';

// The first is the claim; the rest are the control. If the control scored
// similarly the method would be measuring the format rather than the model.
const CANDIDATES = [
  {file: 'silero_vad_half.onnx', expected: 'the base'},
  {file: 'silero_vad.onnx', expected: 'control (full precision)'},
  {file: 'silero_vad_16k_op15.onnx', expected: 'control (16 kHz, opset 15)'},
];

const WINDOW = 64;
const SAMPLES = 1000;
// Measured at 96.62% for the base and at most 20.48% for a control, so this
// sits well clear of both. It is not 100% because ORT's graph optimiser fuses
// nodes - the file registers com.microsoft:FusedConv - and fusion can rewrite
// the weights it folds together.
const THRESHOLD = 90;

/**
 * Fraction of a needle file's content that appears verbatim in a haystack.
 *
 * Sampled rather than exhaustive: indexing every window of a 1.8 MB file costs
 * far more memory than the answer is worth, and a uniform sample of a thousand
 * windows separates 96% from 20% with room to spare.
 *
 * @param {Buffer} needle the file being looked for
 * @param {Buffer} haystack the file being looked in
 * @return {{percent: number, hits: number, total: number}} the score
 */
function sharedContent(needle, haystack) {
  const last = needle.length - WINDOW;
  const step = Math.max(1, Math.floor(last / SAMPLES));
  let hits = 0;
  let total = 0;
  for (let i = 0; i <= last; i += step) {
    total++;
    if (haystack.indexOf(needle.subarray(i, i + WINDOW)) !== -1) hits++;
  }
  return {percent: (100 * hits) / total, hits, total};
}

const ort = fs.readFileSync(vendored);

// Every ORT format file carries this at offset 4; anything else means the
// vendored file is not what this script is written to check.
const magic = ort.subarray(4, 8).toString('latin1');
if (magic !== 'ORTM') {
  console.error(
      `${vendored} is not an ORT model: expected "ORTM" at offset 4, ` +
      `found ${JSON.stringify(magic)}.`);
  process.exit(1);
}
console.log(`${path.basename(vendored)}: ${ort.length.toLocaleString()} ` +
  `bytes, ORT format\n`);

const results = [];
for (const {file, expected} of CANDIDATES) {
  const res = await fetch(BASE + file);
  if (!res.ok) {
    console.error(`could not fetch ${BASE + file}: ${res.status}`);
    process.exit(1);
  }
  const onnx = Buffer.from(await res.arrayBuffer());
  const {percent, hits, total} = sharedContent(onnx, ort);
  results.push({file, expected, percent});
  console.log(
      `  ${file.padEnd(28)} ${onnx.length.toLocaleString().padStart(11)} ` +
      `bytes  ${String(hits).padStart(4)}/${String(total).padEnd(4)} ` +
      `windows shared  ${percent.toFixed(2).padStart(6)}%  ${expected}`);
}

const [base, ...controls] = results;
const bestControl = Math.max(...controls.map((r) => r.percent));

if (base.percent < THRESHOLD) {
  console.error(
      `\n${base.file} shares only ${base.percent.toFixed(2)}% of its content ` +
      `with the vendored model, below the ${THRESHOLD}% this expects.\n` +
      `Either the model was replaced or upstream republished it. Re-derive ` +
      `the provenance before trusting docs/vendored-libraries.md.`);
  process.exit(1);
}

if (base.percent <= bestControl) {
  console.error(
      `\nThe control scored as high as the base (${bestControl.toFixed(2)}% ` +
      `vs ${base.percent.toFixed(2)}%), so this comparison is measuring the ` +
      `file format rather than the model. The result proves nothing.`);
  process.exit(1);
}

console.log(
    `\nsilero_vad_half.ort is silero_vad_half.onnx (${TAG}) converted to ` +
    `ORT format.\nVerified: ${base.percent.toFixed(2)}% of the published ` +
    `model's content appears\nbyte-for-byte in the vendored file, against ` +
    `${bestControl.toFixed(2)}% for the nearest other\nmodel upstream ` +
    `publishes.`);
