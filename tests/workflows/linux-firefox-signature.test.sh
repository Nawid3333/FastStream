#!/usr/bin/env bash
# tools/linux/setup.sh's check of the Firefox it installs for verify:linux (#248):
# verify_signed_sum, taken out of setup.sh, on release folders made here with keys made here
# (stand-ins for Mozilla's KEY, SHA512SUMS and its signature). No network. Needs gpg, as
# GitHub's Ubuntu runners and WSL's Ubuntu have it.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
gnupg=$here/gnupg
# Making keys starts a gpg-agent for this test's own gpg home; it goes with the home.
trap 'gpgconf --homedir "$gnupg" --kill all 2> /dev/null; rm -rf "$here"' EXIT
mkdir -m 700 "$gnupg"

setup_sh=$(dirname "$0")/../../tools/linux/setup.sh
eval "$(sed -n '/^verify_signed_sum() {$/,/^}$/p' "$setup_sh")"
if ! declare -F verify_signed_sum > /dev/null; then
  echo "no verify_signed_sum() { ... } in tools/linux/setup.sh"
  exit 1
fi

g() { gpg --homedir "$gnupg" --batch --quiet --pinentry-mode loopback --passphrase '' "$@"; }

# newkey <name> [gpg options]: a signing key valid for a year; prints its fingerprint.
newkey() {
  local name=$1
  shift
  g "$@" --quick-gen-key "$name <$name@test.invalid>" ed25519 sign 1y || return 1
  g --with-colons --list-keys "$name@test.invalid" | awk -F: '$1 == "fpr" { print $10; exit }'
}

mozilla=$(newkey mozilla)
other=$(newkey other)
# Valid for 2020 only.
old=$(newkey old --faked-system-time 20200101T000000)
if [ -z "$mozilla" ] || [ -z "$other" ] || [ -z "$old" ]; then
  echo "could not make the test keys"
  exit 1
fi

name=linux-x86_64/en-US/firefox-1.0.tar.xz

# release <dir> <signing key> <key in KEY>... [-- <gpg options for signing>]: a release
# folder: the tarball, a SHA512SUMS listing it among others, that list's signature, and KEY.
release() {
  local dir=$here/$1 signer=$2 keys=() sign=()
  shift 2
  while [ $# -gt 0 ] && [ "$1" != -- ]; do keys+=("$1"); shift; done
  [ $# -gt 0 ] && shift && sign=("$@")
  mkdir -p "$dir"
  printf 'a Firefox build\n' > "$dir/firefox.tar.xz"
  {
    printf '%s  linux-x86_64/de/firefox-1.0.tar.xz\n' "$(printf 'other\n' | sha512sum | cut -d' ' -f1)"
    printf '%s  %s\n' "$(sha512sum "$dir/firefox.tar.xz" | cut -d' ' -f1)" "$name"
  } > "$dir/SHA512SUMS"
  g "${sign[@]}" --local-user "$signer" --armor --detach-sign -o "$dir/SHA512SUMS.asc" "$dir/SHA512SUMS"
  g --armor --export "${keys[@]}" > "$dir/KEY"
}

# passes <dir> <pinned fingerprint>; refused: the opposite. The output is in $here/out.
passes() {
  verify_signed_sum "$here/$1" "$name" "$here/$1/firefox.tar.xz" "$2" > "$here/out" 2>&1
}
refused() {
  ! passes "$@"
}

release good "$mozilla" "$mozilla"
check 'a release signed by the pinned key, with its tarball, passes' passes good "$mozilla"

check 'a pinned fingerprint that is not the KEY'"'"'s is refused' refused good "$other"
check '  and says so' contains "$here/out" "not the pinned $other"

release other "$other" "$other"
check 'a KEY and signature of another key are refused' refused other "$mozilla"

release extra "$mozilla" "$mozilla" "$other"
check 'a KEY with a key besides the pinned one is refused' refused extra "$mozilla"

cp -r "$here/good" "$here/changed"
sed -i '1s/^./0/' "$here/changed/SHA512SUMS"
check 'a SHA512SUMS changed after it was signed is refused' refused changed "$mozilla"
check '  and says the signature is bad' contains "$here/out" 'BADSIG'

release unsigned "$other" "$mozilla"
check 'a signature by a key that is not in KEY is refused' refused unsigned "$mozilla"

release expired "$old" "$old" -- --faked-system-time 20200601T000000
check 'a signature by an expired key is refused' refused expired "$old"
check '  and says it is one' contains "$here/out" 'EXPKEYSIG'

cp -r "$here/good" "$here/tarball"
printf 'something else\n' >> "$here/tarball/firefox.tar.xz"
check 'a tarball whose SHA-512 is not the signed one is refused' refused tarball "$mozilla"
check '  and says so' contains "$here/out" 'but the signed SHA512SUMS says'

unlisted() {
  ! verify_signed_sum "$here/good" linux-x86_64/fr/firefox-1.0.tar.xz "$here/good/firefox.tar.xz" "$mozilla" > "$here/out" 2>&1
}
check 'a tarball the signed list does not name is refused' unlisted
check '  and says so' contains "$here/out" 'firefox-1.0.tar.xz 0 times, not once'

finish
