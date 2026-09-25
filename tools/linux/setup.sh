#!/usr/bin/env bash
# Brings a WSL Ubuntu (or any Ubuntu) up to date and provisions it as CI's Linux runner.
# tools/verify-linux.mjs runs it as root before every check.
#
# Every run starts from what is newest, as a runner starts from a freshly built image: apt
# updates and upgrades every package, and Node and Firefox are replaced as soon as a newer
# one is out. What CI's verify job has, and so this gets: Node 22 (actions/setup-node, `22`
# with check-latest), pnpm at package.json's packageManager version (through corepack),
# ffmpeg from apt (libx264, as on the runner), and the current stable Firefox
# (browser-actions/setup-firefox, `latest`). For the workflows job: the actionlint and
# shellcheck binaries from the image ci.yml pins. Plus an unprivileged user, `faststream`,
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
for pkg in ffmpeg rsync git curl xz-utils bzip2 ca-certificates jq \
    libgtk-3-0t64 libasound2t64 libdbus-glib-1-2 libx11-xcb1 libxtst6 libpci3 libegl1; do
  dpkg -s "$pkg" > /dev/null 2>&1 || need_apt+=("$pkg")
done
if [ ${#need_apt[@]} -gt 0 ]; then
  "${apt[@]}" -y install --no-install-recommends "${need_apt[@]}" > /dev/null
fi
"${apt[@]}" -y autoremove --purge > /dev/null
echo "apt: $(. /etc/os-release && echo "$PRETTY_NAME"), $upgrades package(s) upgraded${need_apt[*]:+, installed ${need_apt[*]}}"

# Node 22: the newest 22.x, checked against nodejs.org's SHASUMS256.
node_want=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | startswith("v22."))][0].version')
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
for bin in node npm npx corepack; do ln -sf "/opt/node/bin/$bin" "/usr/local/bin/$bin"; done
corepack enable --install-directory /usr/local/bin pnpm > /dev/null

# The current stable Firefox, from Mozilla, when product-details names a newer one.
ff_want=$(curl -fsSL https://product-details.mozilla.org/1.0/firefox_versions.json | jq -r .LATEST_FIREFOX_VERSION)
ff_have=$(/opt/firefox/firefox --version 2>/dev/null | awk '{print $3}' || true)
if [ "$ff_have" != "$ff_want" ]; then
  echo "firefox: $ff_want"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/firefox.tar.xz" \
    "https://download-installer.cdn.mozilla.net/pub/firefox/releases/$ff_want/linux-x86_64/en-US/firefox-$ff_want.tar.xz"
  curl -fsSL "https://download-installer.cdn.mozilla.net/pub/firefox/releases/$ff_want/SHA256SUMS" |
    grep " linux-x86_64/en-US/firefox-$ff_want.tar.xz\$" | awk '{print $1 "  firefox.tar.xz"}' > "$tmp/sum"
  (cd "$tmp" && sha256sum -c sum > /dev/null)
  rm -rf /opt/firefox
  tar -xJf "$tmp/firefox.tar.xz" -C /opt
  rm -rf "$tmp"
fi

# actionlint and shellcheck: the binaries in the image ci.yml's workflows job runs, taken
# from its layers by the digest ci.yml pins, each download checked against its digest.
# apt's shellcheck is another version (0.9.0 on 24.04), and versions differ in findings.
image=$(sed -n 's|.*docker://rhysd/actionlint:\([0-9.]*@sha256:[0-9a-f]*\).*|\1|p' "$repo/.github/workflows/ci.yml" | head -1)
digest=${image#*@}
if [ "$(cat /opt/actionlint/digest 2>/dev/null || true)" != "$digest" ]; then
  echo "actionlint: rhysd/actionlint:$image"
  tmp=$(mktemp -d)
  registry=https://registry-1.docker.io/v2/rhysd/actionlint
  token=$(curl -fsSL 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:rhysd/actionlint:pull' | jq -r .token)
  fetch() { # manifests|blobs, digest, file
    curl -fsSL -H "Authorization: Bearer $token" -o "$3" "$registry/$1/$2" \
      -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
    if [ "sha256:$(sha256sum "$3" | cut -d' ' -f1)" != "$2" ]; then
      echo "actionlint image: what the registry sent for $2 does not match that digest"
      exit 1
    fi
  }
  fetch manifests "$digest" "$tmp/manifest.json"
  # A multi-platform image lists a manifest per platform; this takes the linux/amd64 one.
  amd64=$(jq -r '.manifests[]? | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest' "$tmp/manifest.json")
  [ -z "$amd64" ] || fetch manifests "$amd64" "$tmp/manifest.json"
  mkdir -p "$tmp/fs"
  for layer in $(jq -r '.layers[].digest' "$tmp/manifest.json"); do
    fetch blobs "$layer" "$tmp/layer"
    # Most layers have nothing under usr/local/bin, which tar reports as an error.
    tar -xf "$tmp/layer" -C "$tmp/fs" --wildcards 'usr/local/bin/*' > /dev/null 2>&1 || true
  done
  for bin in actionlint shellcheck; do
    if [ ! -x "$tmp/fs/usr/local/bin/$bin" ]; then
      echo "actionlint image: no /usr/local/bin/$bin in rhysd/actionlint:$image"
      exit 1
    fi
  done
  rm -rf /opt/actionlint && mkdir -p /opt/actionlint
  cp "$tmp/fs/usr/local/bin/actionlint" "$tmp/fs/usr/local/bin/shellcheck" /opt/actionlint/
  echo "$digest" > /opt/actionlint/digest
  rm -rf "$tmp"
fi
# /usr/local/bin comes before /usr/bin on PATH, ahead of any apt shellcheck.
for bin in actionlint shellcheck; do ln -sf "/opt/actionlint/$bin" "/usr/local/bin/$bin"; done

id faststream > /dev/null 2>&1 || useradd -m -s /bin/bash faststream

echo "ready: node $(node --version), firefox $(/opt/firefox/firefox --version | awk '{print $3}')," \
  "actionlint $(actionlint -version | head -1), shellcheck $(shellcheck --version | sed -n 's/^version: //p')," \
  "ffmpeg $(ffmpeg -hide_banner -version | awk 'NR == 1 {print $3}') with $(ffmpeg -hide_banner -encoders 2>/dev/null | grep -c libx264) libx264 encoder(s)"
