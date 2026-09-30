#!/usr/bin/env node
// Proves where chrome/player/modules/vad/silero_vad_half.onnx came from.
//
// The voice-activity detector ships snakers4/silero-vad's published
// half-precision model exactly as released: the same bytes, not a conversion.
// This checks that twice. The file in the tree must hash to the value recorded
// here, and the file upstream publishes at the pinned tag must hash to the same
// value - so a reviewer can re-run it and see that the binary is the published
// one, and a replaced or edited model fails.
//
// Until 1.3.82.44 the model was silero_vad_half.ort, a conversion to ONNX
// Runtime's own format that its custom reduced runtime needed. The stock
// onnxruntime-web runtime loads ONNX directly, so the conversion step, and the
// content-sampling proof it needed, are gone.
//
// Run with: pnpm run verify:vad   (needs network, downloads about 1.3 MB)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const vendored = path.join(root, 'chrome/player/modules/vad/silero_vad_half.onnx');

// Pinned by tag so this cannot start failing because upstream moved.
const TAG = 'v6.2.1';
const PUBLISHED = `https://raw.githubusercontent.com/snakers4/silero-vad/${TAG}/` +
  'src/silero_vad/data/silero_vad_half.onnx';
const SHA256 = '1e0b195ad4806595ef4466f419d16fca7e4afcfc6669b8c0b5f76ea87547c769';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const local = fs.readFileSync(vendored);
const localHash = sha256(local);
console.log(`${path.basename(vendored)}: ${local.length.toLocaleString()} bytes`);
console.log(`  in the tree  ${localHash}`);

const res = await fetch(PUBLISHED);
if (!res.ok) {
  console.error(`could not fetch ${PUBLISHED}: ${res.status}`);
  process.exit(1);
}
const published = Buffer.from(await res.arrayBuffer());
const publishedHash = sha256(published);
console.log(`  published    ${publishedHash}  (${TAG})`);
console.log(`  recorded     ${SHA256}`);

if (publishedHash !== SHA256) {
  console.error(
      `\nsilero-vad ${TAG} no longer serves the file this records. A tag ` +
      `should not move; re-derive the provenance before trusting ` +
      `docs/vendored-libraries.md.`);
  process.exit(1);
}
if (localHash !== SHA256) {
  console.error(
      `\nThe model in the tree is not the published one. Either it was ` +
      `replaced or edited; restore it from ${PUBLISHED}.`);
  process.exit(1);
}

console.log(
    `\nVerified: silero_vad_half.onnx is snakers4/silero-vad ${TAG}'s ` +
    `published model, byte for byte.`);
