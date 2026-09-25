#!/usr/bin/env bash
# Runs CI's Linux checks on a copy of the working tree, as tools/verify-linux.mjs asks.
# Runs as the unprivileged user tools/linux/setup.sh creates.
#
#   verify.sh <repo path> [all|verify|workflows]
#     verify     `pnpm run verify` - CI's verify job
#     workflows  actionlint with shellcheck - CI's workflows job
#     all        both (the default)
set -euo pipefail
# wsl.exe writes stdout and stderr to a redirected file each at its own offset, so one
# overwrites the other; as one stream the log keeps every line.
exec 2>&1

src=${1:?usage: verify.sh <repo path> [all|verify|workflows]}
what=${2:-all}
dst="$HOME/faststream"
mkdir -p "$dst"

# The working tree as it stands, committed or not, without what .gitignore keeps out.
# node_modules (Linux's own) and the pnpm store stay between runs; the e2e fixtures are
# rebuilt every time, as on CI, where each run starts empty.
rsync -a --delete --exclude=.git --exclude=node_modules --exclude=tests/e2e/fixtures \
  --filter=':- .gitignore' "$src/" "$dst/"
cd "$dst"
mkdir -p tests/e2e/fixtures
find tests/e2e/fixtures -mindepth 1 -maxdepth 1 ! -name sample.mp4 -exec rm -rf {} +

status=0
if [ "$what" = all ] || [ "$what" = workflows ]; then
  echo '== workflows: actionlint + shellcheck'
  # actionlint finds the project by its .git, which the copy leaves out.
  [ -d .git ] || git init -q
  actionlint -color || status=1
fi
if [ "$what" = all ] || [ "$what" = verify ]; then
  echo '== verify: pnpm run verify'
  pnpm install --frozen-lockfile
  FIREFOX_BINARY=/opt/firefox/firefox pnpm run verify || status=1
fi
exit "$status"
