#!/usr/bin/env bash
# auto-release.yml's "Did anything shipped change since the last release?": CI's build of the
# commit (both zips of faststream-bundles) against the latest release (its firefox-github zip,
# and its signed xpi, which is the AMO build plus Mozilla's META-INF/). release=no only when
# both are file for file the same; any doubt releases. gh is a stub that hands out fixture
# zips as the real one does: the artifact's two zips, and the release's assets matching a
# --pattern.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step=$here/shipped.sh
step_script auto-release.yml 'Did anything shipped change since the last release?' > "$step" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIX/gh.log"
args=("$@")
opt() { local i; for ((i = 0; i < ${#args[@]} - 1; i++)); do if [ "${args[i]}" = "$1" ]; then printf '%s\n' "${args[i + 1]}"; return 0; fi; done; return 1; }
case "$1 $2" in
  'release view')
    [ -f "$FIX/tag" ] || { echo 'release not found' >&2; exit 1; }
    cat "$FIX/tag" ;;
  'run download')
    d=$(opt --dir); mkdir -p "$d"
    cp "$FIX/new-github.zip" "$d/firefox-github-faststream_video_player-1.3.82.52.zip"
    cp "$FIX/new-amo.zip" "$d/firefox-amo-faststream_video_player-1.3.82.52.zip" ;;
  'release download')
    d=$(opt --dir); mkdir -p "$d"
    pats=$(for ((i = 0; i < ${#args[@]} - 1; i++)); do if [ "${args[i]}" = --pattern ]; then printf '%s\n' "${args[i + 1]}"; fi; done)
    if grep -qxF 'firefox-github-*.zip' <<< "$pats"; then cp "$FIX/old-github.zip" "$d/firefox-github-faststream_video_player-1.3.82.52.zip"; fi
    if grep -qxF '*.xpi' <<< "$pats" && [ -f "$FIX/old.xpi" ]; then cp "$FIX/old.xpi" "$d/99f1b8e844554f46b28a-1.3.82.52.xpi"; fi ;;
  *)
    echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
# GitHub's runners have unzip; a WSL Ubuntu may not. Then `unzip -q <zip> -d <dir>`, the
# one form the step uses, through python3 (a missing zip fails, as unzip does). Like
# Info-ZIP's unzip, it makes only the last folder of <dir>: python3 made them all, and the
# step's two-level folders passed here and failed on GitHub.
if ! command -v unzip > /dev/null; then
  cat > "$here/bin/unzip" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -q ] && [ "$3" = -d ] || { echo "unzip stand-in: only -q <zip> -d <dir>" >&2; exit 2; }
[ -d "$(dirname "$4")" ] || { echo "checkdir:  cannot create extraction directory: $4" >&2; exit 3; }
exec python3 -m zipfile -e "$2" "$4"
EOF
  chmod +x "$here/bin/unzip"
fi
chmod +x "$here/bin/gh"

export GH_TOKEN=stub GITHUB_REPOSITORY='Nawid3333/FastStream' RUN_ID=37065133847

# build <zip name> <update_url or ""> <player.js> [signed]: a build of 1.3.82.52 (an AMO one
# when given an update_url), with Mozilla's META-INF/ when signed.
build() {
  local d=$FIX/src/$1
  rm -rf "$d" "${FIX:?}/$1"
  mkdir -p "$d"
  if [ -n "$2" ]; then
    printf '{"version":"1.3.82.52","browser_specific_settings":{"gecko":{"update_url":"%s"}}}\n' "$2" > "$d/manifest.json"
  else
    printf '{"version":"1.3.82.52","permissions":["contextualIdentities"]}\n' > "$d/manifest.json"
  fi
  printf '%s\n' "$3" > "$d/player.js"
  local files=(manifest.json player.js)
  if [ -n "${4:-}" ]; then mkdir -p "$d/META-INF"; printf 'sig\n' > "$d/META-INF/mozilla.rsa"; files+=(META-INF); fi
  (cd "$d" && python3 -m zipfile -c "$FIX/$1" "${files[@]}")
}
URL=https://github.com/Nawid3333/FastStream/releases/latest/download/updates.json
# fixtures: a release v1.3.82.52 and CI's build of a commit after it, the same files.
fixtures() {
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp" GITHUB_OUTPUT="$here/fix/output"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$FIX/gh.log"; : > "$GITHUB_OUTPUT"
  echo v1.3.82.52 > "$FIX/tag"
  build old-github.zip '' 'play()'
  build old.xpi "$URL" 'play()' signed
  build new-github.zip '' 'play()'
  build new-amo.zip "$URL" 'play()'
}
run() {
  echo "$1"
  (PATH="$here/bin:$PATH" run_step "$step") > "$FIX/out" 2>&1
  status=$?
}
released() { grep -qx "release=$1" "$GITHUB_OUTPUT"; }

fixtures
run 'a1 both builds as released (the xpi with its signature) -> no release'
check 'succeeds' test "$status" -eq 0
check 'release=no' released no
check 'asked for the github zip and the xpi' contains "$FIX/gh.log" '--pattern firefox-github-*.zip --pattern *.xpi'

fixtures
build new-github.zip '' 'play(); fix()'
run 'a2 the github build changed -> a release'
check 'succeeds' test "$status" -eq 0
check 'release=yes' released yes

fixtures
build new-amo.zip 'https://example.com/moved/updates.json' 'play()'
run 'a3 only the AMO build changed (its update_url), the github zip as released -> a release (#164)'
check 'succeeds' test "$status" -eq 0
check 'release=yes' released yes
check "names the AMO build's manifest" contains "$FIX/out" 'amo/manifest.json'

fixtures
rm -f "$FIX/old.xpi"
run 'a4 the latest release has no signed xpi yet -> released as usual, with a warning'
check 'succeeds' test "$status" -eq 0
check 'release=yes' released yes
check 'warns' contains "$FIX/out" 'Could not compare this build with the latest release'

fixtures
rm -f "$FIX/tag"
run 'a5 no release yet -> a release'
check 'succeeds' test "$status" -eq 0
check 'release=yes' released yes

finish
