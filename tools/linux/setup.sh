#!/usr/bin/env bash
# Brings a WSL Ubuntu (or any Ubuntu) up to date and provisions it as CI's Linux runner.
# tools/verify-linux.mjs runs it as root before every check.
#
# Every run starts from what is newest, as a runner starts from a freshly built image: apt
# updates and upgrades every package, and Node and Firefox are replaced as soon as a newer
# one is out. What CI's verify job has, and so this gets: Node at .nvmrc's major
# (actions/setup-node with check-latest: its newest release), pnpm at package.json's packageManager version (through npm),
# ffmpeg from apt (libx264, as on the runner), and the current stable Firefox
# (browser-actions/setup-firefox, `latest`). For the workflows job: the binaries of
# actionlint and shellcheck from the image .github/actionlint/Dockerfile pins, and zizmor's
# from the one .github/zizmor/Dockerfile pins. Plus an unprivileged user, `faststream`,
# since Firefox is not meant to run as root.
set -euo pipefail
# wsl.exe writes stdout and stderr to a redirected file each at its own offset, so one
# overwrites the other; as one stream the log keeps every line.
exec 2>&1

repo=${1:?usage: setup.sh <repo path>}
export DEBIAN_FRONTEND=noninteractive
# unattended-upgrades may hold the dpkg lock just after the distro starts; wait for it.
apt=(apt-get -qq -o DPkg::Lock::Timeout=600)

"${apt[@]}" update
upgrades=$(apt-get -s full-upgrade | grep -c '^Inst' || true)
"${apt[@]}" -y full-upgrade > /dev/null
need_apt=()
# libatomic1: Node 26's binary needs libatomic.so.1, which a WSL Ubuntu lacks and the
# runner image has; without it every `node` fails to start.
for pkg in ffmpeg rsync git curl xz-utils bzip2 ca-certificates jq gpg libatomic1 \
    libgtk-3-0t64 libasound2t64 libdbus-glib-1-2 libx11-xcb1 libxtst6 libpci3 libegl1; do
  dpkg -s "$pkg" > /dev/null 2>&1 || need_apt+=("$pkg")
done
if [ ${#need_apt[@]} -gt 0 ]; then
  "${apt[@]}" -y install --no-install-recommends "${need_apt[@]}" > /dev/null
fi
"${apt[@]}" -y autoremove --purge > /dev/null
# shellcheck source=/dev/null
echo "apt: $(. /etc/os-release && echo "$PRETTY_NAME"), $upgrades package(s) upgraded${need_apt[*]:+, installed ${need_apt[*]}}"

# Node: the newest release of the major .nvmrc names - the file every workflow's
# setup-node reads - so this moves with CI; checked against nodejs.org's SHASUMS256.
node_major=$(sed -n 's/^ *v\{0,1\}\([0-9][0-9]*\).*/\1/p' "$repo/.nvmrc" | head -1)
if [ -z "$node_major" ]; then
  echo "setup.sh: no Node major in $repo/.nvmrc"
  exit 1
fi
node_want=$(curl -fsSL https://nodejs.org/dist/index.json |
  jq -r --arg prefix "v$node_major." '[.[] | select(.version | startswith($prefix))][0].version')
if [ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "$node_want" ]; then
  echo "node: $node_want"
  tmp=$(mktemp -d)
  file="node-$node_want-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/$node_want/$file"
  curl -fsSL "https://nodejs.org/dist/$node_want/SHASUMS256.txt" | grep " $file\$" > "$tmp/sum"
  (cd "$tmp" && sha256sum -c sum > /dev/null)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
  rm -rf "$tmp"
fi
for bin in node npm npx; do ln -sf "/opt/node/bin/$bin" "/usr/local/bin/$bin"; done

# pnpm: the version package.json's packageManager names, as pnpm/action-setup gives CI,
# installed with that Node's npm. This used corepack, which Node 25 and later no longer ship
# (#238): with .nvmrc at 26 the corepack link pointed at nothing and setup stopped here.
pnpm_want=$(jq -r '.packageManager // ""' "$repo/package.json" | sed -n 's/^pnpm@\([0-9][0-9.]*\).*/\1/p')
if [ -z "$pnpm_want" ]; then
  echo "setup.sh: no pnpm@<version> in $repo/package.json's packageManager"
  exit 1
fi
if [ "$(/opt/node/bin/pnpm --version 2>/dev/null || true)" != "$pnpm_want" ]; then
  echo "pnpm: $pnpm_want"
  /opt/node/bin/npm install --global --prefix /opt/node --ignore-scripts --no-audit --no-fund "pnpm@$pnpm_want" > /dev/null
fi
# Over corepack's pnpm and pnpx links, if an earlier run made them; and its own link goes
# once it points at nothing.
for bin in pnpm pnpx; do ln -sf "/opt/node/bin/$bin" "/usr/local/bin/$bin"; done
[ -e /usr/local/bin/corepack ] || rm -f /usr/local/bin/corepack

# verify_signed_sum <dir> <name> <file> <fingerprint>: checks <file> against the SHA-512 that
# <dir>/SHA512SUMS lists for <name>, once <dir>/SHA512SUMS.asc has proven a good signature on
# that list by the key in <dir>/KEY, and KEY has proven to hold that one primary key and no
# other. gpg reads KEY into a throwaway home, never a keyring of this machine's, and starts no
# agent. Any failure says what failed and returns 1, which stops setup.
verify_signed_sum() {
  local dir=$1 name=$2 file=$3 fingerprint=$4 home primaries status want got
  home=$(mktemp -d)
  primaries=$(gpg --homedir "$home" --batch --no-autostart --show-keys --with-colons "$dir/KEY" 2> /dev/null |
    awk -F: '$1 == "pub" { pub = 1; next } pub && $1 == "fpr" { print $10; pub = 0 }' || true)
  if [ "$primaries" != "$fingerprint" ]; then
    echo "$dir/KEY: primary key(s) ${primaries//$'\n'/ }, not the pinned $fingerprint"
    rm -rf "$home"
    return 1
  fi
  # GOODSIG: a good signature by a key that is neither expired nor revoked.
  if ! gpg --homedir "$home" --batch --no-autostart --quiet --import "$dir/KEY" 2> /dev/null ||
    ! status=$(gpg --homedir "$home" --batch --no-autostart --status-fd 1 \
      --verify "$dir/SHA512SUMS.asc" "$dir/SHA512SUMS" 2> /dev/null) ||
    ! grep -q '^\[GNUPG:\] GOODSIG ' <<< "$status"; then
    echo "$dir/SHA512SUMS.asc: not a good signature by $fingerprint"
    grep -E '^\[GNUPG:\] [A-Z]*(SIG|PUBKEY)' <<< "${status:-}" || true
    rm -rf "$home"
    return 1
  fi
  rm -rf "$home"
  want=$(awk -v name="$name" '$2 == name { print $1 }' "$dir/SHA512SUMS")
  if [ -z "$want" ] || [ "$(wc -l <<< "$want")" -ne 1 ]; then
    echo "$dir/SHA512SUMS: lists $name $(grep -c . <<< "$want") times, not once"
    return 1
  fi
  got=$(sha512sum "$file" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then
    echo "$file: SHA-512 $got, but the signed SHA512SUMS says $want"
    return 1
  fi
}

# The current stable Firefox, from Mozilla, when product-details names a newer one. Its
# SHA-512 comes from the SHA512SUMS that Mozilla's release key signs (#248): a sum from the
# same server alone proved nothing. The key is pinned by its primary fingerprint, read from
# the KEY files of Firefox 60.0, 115.0, 140.0esr and 157.0 and from keyserver.ubuntu.com
# (2026-10-03, all the same): Mozilla Software Releases <release@mozilla.com>, 2015. Its
# signing subkeys change every two years or so; KEY brings the current one. Should Mozilla
# ever replace the primary key itself, setup stops naming both: check the new one the same
# way before changing this line.
mozilla_key=14F26682D0916CDD81E37B6D61B7B526D98F0353
ff_want=$(curl -fsSL https://product-details.mozilla.org/1.0/firefox_versions.json | jq -r .LATEST_FIREFOX_VERSION)
ff_have=$(/opt/firefox/firefox --version 2>/dev/null | awk '{print $3}' || true)
if [ "$ff_have" != "$ff_want" ]; then
  echo "firefox: $ff_want"
  tmp=$(mktemp -d)
  release=https://download-installer.cdn.mozilla.net/pub/firefox/releases/$ff_want
  curl -fsSL -o "$tmp/firefox.tar.xz" "$release/linux-x86_64/en-US/firefox-$ff_want.tar.xz"
  for f in SHA512SUMS SHA512SUMS.asc KEY; do curl -fsSL -o "$tmp/$f" "$release/$f"; done
  verify_signed_sum "$tmp" "linux-x86_64/en-US/firefox-$ff_want.tar.xz" "$tmp/firefox.tar.xz" "$mozilla_key"
  rm -rf /opt/firefox
  tar -xJf "$tmp/firefox.tar.xz" -C /opt
  rm -rf "$tmp"
fi

# Copies files out of a container image by the digest a Dockerfile in .github pins: every
# manifest and layer the registry sends is checked against its digest, and of a
# multi-platform image the linux/amd64 manifest is the one taken. <dir> is replaced, with
# the files and a `digest` file, only once every file is there.
#   image_files <registry API base> <token> <digest> <dir> <path in the image>...
image_files() {
  local api=$1 token=$2 digest=$3 dir=$4
  shift 4
  local tmp amd64 layer file
  tmp=$(mktemp -d)
  image_fetch() { # manifests|blobs, digest, file
    curl -fsSL -H "Authorization: Bearer $token" -o "$3" "$api/$1/$2" \
      -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
    if [ "sha256:$(sha256sum "$3" | cut -d' ' -f1)" != "$2" ]; then
      echo "$api: what the registry sent for $2 does not match that digest"
      exit 1
    fi
  }
  image_fetch manifests "$digest" "$tmp/manifest.json"
  amd64=$(jq -r '.manifests[]? | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest' "$tmp/manifest.json")
  [ -z "$amd64" ] || image_fetch manifests "$amd64" "$tmp/manifest.json"
  mkdir -p "$tmp/fs"
  for layer in $(jq -r '.layers[].digest' "$tmp/manifest.json"); do
    image_fetch blobs "$layer" "$tmp/layer"
    # Most layers hold none of the files, which tar reports as an error.
    tar -xf "$tmp/layer" -C "$tmp/fs" "$@" > /dev/null 2>&1 || true
  done
  for file in "$@"; do
    if [ ! -x "$tmp/fs/$file" ]; then
      echo "$api: no /$file in the image $digest"
      exit 1
    fi
  done
  rm -rf "$dir" && mkdir -p "$dir"
  for file in "$@"; do cp "$tmp/fs/$file" "$dir/"; done
  echo "$digest" > "$dir/digest"
  rm -rf "$tmp"
}

# actionlint and shellcheck: the binaries in the image ci.yml's workflows job runs, by the
# digest .github/actionlint/Dockerfile pins. apt's shellcheck is another version (0.9.0 on
# 24.04), and versions differ in findings.
image=$(sed -n 's|^FROM rhysd/actionlint:\([0-9.]*@sha256:[0-9a-f]\{64\}\).*|\1|p' "$repo/.github/actionlint/Dockerfile" | head -1)
if [ -z "$image" ]; then
  echo "actionlint: no line 'FROM rhysd/actionlint:<version>@sha256:<digest>' in .github/actionlint/Dockerfile"
  exit 1
fi
digest=${image#*@}
if [ "$(cat /opt/actionlint/digest 2>/dev/null || true)" != "$digest" ]; then
  echo "actionlint: rhysd/actionlint:$image"
  token=$(curl -fsSL 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:rhysd/actionlint:pull' | jq -r .token)
  image_files https://registry-1.docker.io/v2/rhysd/actionlint "$token" "$digest" /opt/actionlint \
    usr/local/bin/actionlint usr/local/bin/shellcheck
fi
# /usr/local/bin comes before /usr/bin on PATH, ahead of any apt shellcheck.
for bin in actionlint shellcheck; do ln -sf "/opt/actionlint/$bin" "/usr/local/bin/$bin"; done

# zizmor: the binary in the image .github/zizmor/Dockerfile pins, which ci.yml's workflows
# job runs after actionlint. verify.sh runs it there too (#239).
image=$(sed -n 's|^FROM ghcr.io/zizmorcore/zizmor:\([0-9.]*@sha256:[0-9a-f]\{64\}\).*|\1|p' "$repo/.github/zizmor/Dockerfile" | head -1)
if [ -z "$image" ]; then
  echo "zizmor: no line 'FROM ghcr.io/zizmorcore/zizmor:<version>@sha256:<digest>' in .github/zizmor/Dockerfile"
  exit 1
fi
digest=${image#*@}
if [ "$(cat /opt/zizmor/digest 2>/dev/null || true)" != "$digest" ]; then
  echo "zizmor: ghcr.io/zizmorcore/zizmor:$image"
  token=$(curl -fsSL 'https://ghcr.io/token?service=ghcr.io&scope=repository:zizmorcore/zizmor:pull' | jq -r .token)
  image_files https://ghcr.io/v2/zizmorcore/zizmor "$token" "$digest" /opt/zizmor usr/bin/zizmor
fi
ln -sf /opt/zizmor/zizmor /usr/local/bin/zizmor

id faststream > /dev/null 2>&1 || useradd -m -s /bin/bash faststream

# The e2e ports, out of the range Linux hands out to outgoing connections (ci.yml). WSL
# distros share one kernel, so this holds for all of them until WSL restarts.
sysctl -w net.ipv4.ip_local_reserved_ports=41800-41999 > /dev/null

echo "ready: node $(node --version), pnpm $(pnpm --version), firefox $(/opt/firefox/firefox --version | awk '{print $3}')," \
  "actionlint $(actionlint -version | head -1), shellcheck $(shellcheck --version | sed -n 's/^version: //p')," \
  "zizmor $(zizmor --version | awk '{print $2}')," \
  "ffmpeg $(ffmpeg -hide_banner -version | awk 'NR == 1 {print $3}') with $(ffmpeg -hide_banner -encoders 2>/dev/null | grep -c libx264) libx264 encoder(s)"
