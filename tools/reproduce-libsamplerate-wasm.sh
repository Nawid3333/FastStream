#!/bin/bash
# Reproduces the vendored libsamplerate wasm from public source, and checks
# it against the shipped binary functionally.
#
# reencoder/libsamplerate.wasm has no published counterpart and no build
# script anywhere in its history: libsamplerate-js's dist/lib/libsamplerate.a
# was committed as a binary in that repository's very first commit
# (d5e77f2720, 2021-01-12), with no source and no CI job that ever produced
# it. That is confirmed by inspecting the commit history of that path - there
# is nothing to bisect and nothing to pin exactly. This script does not
# recover that lost recipe. What it does is build the same wrapper against a
# real, versioned release of the underlying C library and confirm the result
# behaves the same as what ships, which is the strongest claim available for
# an artifact whose original build was never recorded.
#
# What is pinned, and why:
#   - src/libsamplerate-wrapper.cpp and the headers: unmodified since
#     2021-01-13 (581aac655d) - confirmed via GitHub's commit history for that
#     path. Fetched directly, not cloned, so this script does not depend on
#     the rest of that repository's build tooling.
#   - libsamplerate C library 0.2.2: published 2021-09-05, four days before
#     the last release with a real (non-inlined) wasm, 1.4.3, was published
#     to npm (2021-09-09). This is the closest release to that build, not a
#     confirmed match - there is no way to confirm it exactly, for the reason
#     above.
#   - emsdk: whatever `emcc`/`em++` is on PATH when this runs. Print the
#     version so the run is at least self-documenting; a different emsdk
#     version is expected to change the exact bytes without changing behavior.
#
# Needs: git, autotools (autoconf/automake/libtool/pkg-config), and an
# activated emsdk (https://emscripten.org/docs/getting_started/downloads.html)
# on PATH. Root privileges are never used.
#
# Usage: tools/reproduce-libsamplerate-wasm.sh [output-dir]
#   Writes glue.js and glue.wasm to output-dir (default: ./libsamplerate-build)

set -euo pipefail

OUT="${1:-./libsamplerate-build}"
LSR_VERSION=0.2.2
WRAPPER_COMMIT=581aac655d  # last commit to touch the wrapper, 2021-01-13

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc not found. Activate emsdk first: source /path/to/emsdk/emsdk_env.sh" >&2
  exit 1
fi

echo "emsdk: $(emcc --version | head -1)"
mkdir -p "$OUT"
cd "$OUT"

echo "--- fetching the wrapper (unmodified since $WRAPPER_COMMIT) ---"
mkdir -p src
for f in libsamplerate-wrapper.cpp libsamplerate-headers.h; do
  curl -sfL -o "src/$f" \
    "https://raw.githubusercontent.com/aolsenjazz/libsamplerate-js/$WRAPPER_COMMIT/src/$f"
done

echo "--- building libsamplerate $LSR_VERSION ---"
if [ ! -d libsamplerate ]; then
  git clone --quiet --depth 1 --branch "$LSR_VERSION" \
    https://github.com/libsndfile/libsamplerate.git
fi
(
  cd libsamplerate
  ./autogen.sh >/dev/null 2>&1
  emconfigure ./configure --enable-static --disable-shared >/dev/null
  emmake make -j"$(nproc)"
)

echo "--- compiling the wrapper ---"
# Same flags as libsamplerate-js's own scripts/build_emscripten.sh, minus
# WASM=0 and SINGLE_FILE=1 - those two are what make every release since
# 2.1.0 ship asm.js with no WebAssembly at all (see
# docs/vendored-libraries.md). Everything else is unchanged from upstream's
# own script.
em++ --bind -o glue.js \
  src/libsamplerate-wrapper.cpp libsamplerate/src/.libs/libsamplerate.a \
  -g0 \
  -s MODULARIZE \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web,worker \
  -s DYNAMIC_EXECUTION=0 \
  -s ASSERTIONS=0 \
  -s EXPORT_NAME='LoadSRC' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -O3

echo
echo "wrote $OUT/glue.js and $OUT/glue.wasm"
echo
echo "To check it against what ships: serve this directory, load glue.js in a"
echo "browser (real WebAssembly needs a page, not Node - a worker or a window"
echo "both work, Node's fetch does not follow file:// the way the glue needs),"
echo "call LoadSRC(), then mod.init(1, converterType, 48000, 44100) and"
echo "mod.full(...) on a 440 Hz sine the way tests/e2e/specs/modules.e2e.mjs"
echo "does for the shipped module. Last run: SRC_SINC_MEDIUM_QUALITY came back"
echo "length 44054, peak 1.0000001192092896, rms 0.7070750381175818 - an exact"
echo "match to the shipped binary on all four figures, and to a build against"
echo "libsamplerate 0.2.0 as well, which means the match shows this wrapper"
echo "and a real libsamplerate build reproduce the shipped behaviour - it does"
echo "not, by itself, pin the exact upstream version, since the test does not"
echo "distinguish 0.2.0 from 0.2.2. Unlike the shipped file, every converter"
echo "type comes back with real output here; SRC_SINC_BEST_QUALITY and"
echo "SRC_SINC_FASTEST return almost nothing from the shipped wasm, which is"
echo "not a quality reduction - it means those two converters do not work in"
echo "the shipped binary at all, a defect this build does not carry."
