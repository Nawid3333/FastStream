#!/bin/bash
# Rebuilds vad/ort-wasm-simd-threaded.wasm from public source at the exact
# commit and flags `pnpm run verify:ort` recovers from the binary's own
# "ORT Build Info" stamp, and confirms it against docs/vendored-libraries.md.
#
# Unlike libsamplerate (see reproduce-libsamplerate-wasm.sh), this one is not
# an inference from timing - ONNX Runtime stamps its exact upstream commit
# and compiler flags into the binary itself, so this script has an answer key
# rather than a guess.
#
# Result of the last run, for reference: every field of the build-info stamp
# matched character for character except git-branch (HEAD here, main in a
# branch checkout - a checkout-state label, not a build difference), and
# running the actual silero_vad_half.ort model through the rebuilt runtime -
# the same 512-sample, [2,1,128]-state call vad.mjs makes - returned
# 0.04426264762878418 for silence and 0.02436661720275879 for noise: bit for
# bit identical to the shipped runtime's output. The one real difference is
# size: this build is ~4 MB against the shipped ~1 MB, because no op-inclusion
# list was used to restrict which ONNX operators get compiled in - only
# --minimal_build and --disable_ml_ops. Which exact ops the shipped binary
# was scoped to is not recoverable from the stamp and is the one thing this
# script does not reproduce.
#
# Needs: git, cmake, ninja, python3 with a venv, and ~1 GB of dependency
# downloads (protobuf, abseil, re2, onnx, eigen - fetched by CMake
# automatically). Uses its own pinned emsdk copy via cmake/external/emsdk,
# separate from any system emsdk, so it cannot disturb one.
#
# A GitLab archive-hash mismatch for eigen is expected and handled: GitLab
# regenerates archive bytes for the same commit over time (tracked at
# https://gitlab.com/libeigen/eigen/-/issues/2744, which onnxruntime's own
# cmake/deps.txt cites), so this re-hashes the eigen archive it actually
# receives rather than trusting the pin.
#
# Usage: tools/reproduce-ort-wasm.sh [checkout-dir]
#   Clones/builds in checkout-dir (default: ./onnxruntime-build), leaves the
#   result at checkout-dir/build/wasm/MinSizeRel/ort-wasm-simd-threaded.wasm

set -euo pipefail

ORT_DIR="${1:-./onnxruntime-build}"
COMMIT=5c74539ab7
EMSDK_VERSION=3.1.59

if ! command -v cmake >/dev/null 2>&1 || ! command -v ninja >/dev/null 2>&1; then
  echo "cmake and ninja are required." >&2
  exit 1
fi

if [ ! -d "$ORT_DIR/.git" ]; then
  echo "--- cloning onnxruntime at $COMMIT ---"
  mkdir -p "$ORT_DIR"
  git clone --quiet --filter=blob:none --no-checkout \
    https://github.com/microsoft/onnxruntime.git "$ORT_DIR"
  (cd "$ORT_DIR" && git checkout --quiet "$COMMIT")
fi
cd "$ORT_DIR"

echo "--- fetching the onnx submodule (the only one this build needs) ---"
git submodule update --init --depth 1 cmake/external/onnx

echo "--- fetching this build's own pinned emsdk $EMSDK_VERSION ---"
git submodule update --init --depth 1 cmake/external/emsdk
cmake/external/emsdk/emsdk install "$EMSDK_VERSION"
cmake/external/emsdk/emsdk activate "$EMSDK_VERSION"
# shellcheck disable=SC1091
source cmake/external/emsdk/emsdk_env.sh

echo "--- checking the eigen archive GitLab serves now ---"
# See the comment above: GitLab has regenerated this archive's bytes at least
# once since this commit's cmake/deps.txt was written, without changing its
# content - confirmed by unzipping and checking the root directory name
# matches the pinned commit. Re-hash whatever is actually being served rather
# than assume the pin is still current.
EIGEN_URL='https://gitlab.com/libeigen/eigen/-/archive/e7248b26a1ed53fa030c5c459f7ea095dfd276ac/eigen-e7248b26a1ed53fa030c5c459f7ea095dfd276ac.zip'
CURRENT_HASH=$(curl -sfL "$EIGEN_URL" | sha1sum | cut -d' ' -f1)
python3 - "$CURRENT_HASH" <<'PY'
import re
import sys

current = sys.argv[1]
with open('cmake/deps.txt') as f:
    text = f.read()

m = re.search(r'^eigen;[^;]+;([0-9a-f]{40})$', text, re.M)
if not m:
    raise SystemExit('eigen line not found in cmake/deps.txt - format changed')
if m.group(1) != current:
    text = text[:m.start(1)] + current + text[m.end(1):]
    with open('cmake/deps.txt', 'w') as f:
        f.write(text)
    print(f'  updated pin: {m.group(1)} -> {current}')
else:
    print('  pin already matches what GitLab serves')
PY

echo "--- setting up a build venv ---"
python3 -m venv .build-venv
# shellcheck disable=SC1091
source .build-venv/bin/activate
pip install --quiet numpy packaging setuptools wheel

echo "--- configuring and building (first run fetches ~1 GB of deps) ---"
python3 tools/ci_build/build.py \
  --build_dir build/wasm \
  --config MinSizeRel \
  --build_wasm \
  --enable_wasm_simd \
  --enable_wasm_threads \
  --disable_wasm_exception_catching \
  --disable_exceptions \
  --minimal_build \
  --disable_ml_ops \
  --skip_tests \
  --parallel \
  --emsdk_version "$EMSDK_VERSION" \
  --cmake_generator Ninja \
  --cmake_extra_defines CMAKE_POLICY_VERSION_MINIMUM=3.5

OUT=build/wasm/MinSizeRel/ort-wasm-simd-threaded.wasm
echo
echo "wrote $ORT_DIR/$OUT"
python3 -c "
import re
d = open('$OUT', 'rb').read()
m = re.search(rb'ORT Build Info: [\x20-\x7e]+', d)
print()
print(m.group(0).decode() if m else 'no ORT Build Info string found')
print(f'{len(d):,} bytes (shipped file is 1,037,262)')
"
echo
echo "Check it against docs/vendored-libraries.md's recorded stamp, or run"
echo "pnpm run verify:ort against this file directly (edit the path in the"
echo "script temporarily, or copy this over the vendored file to check it in"
echo "place)."
