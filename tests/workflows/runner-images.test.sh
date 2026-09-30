#!/usr/bin/env bash
# runner-images.yml's "Read the image list": the image ubuntu-latest and windows-latest
# give and the newest of each, from the runner-images README's table (curl is a stub that
# prints $README). An Ubuntu or Windows Server image none of whose labels has the shape
# the step reads fails the step by name: it would be read as no image, and its early
# warning never come.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script runner-images.yml 'Read the image list' > "$here/images.sh" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$README"
EOF
chmod +x "$here/bin/curl"

# A row as the README writes one: name and badge, architecture, labels, the image's page.
row() { printf '| %s<br>![Endpoint Badge](https://img.shields.io/badge) | %s | %s | [%s] |\n' "$1" "$2" "$3" "$4"; }
# The x64 and arm64 rows of 2026-09-30.
today() {
  row 'Ubuntu 26.04' x64 '`ubuntu-26.04`' ubuntu-26.04
  row 'Ubuntu 24.04' x64 '`ubuntu-latest` or `ubuntu-24.04`' ubuntu-24.04
  row 'Ubuntu 22.04' x64 '`ubuntu-22.04`' ubuntu-22.04
  row 'Ubuntu Slim' x64 '`ubuntu-slim`' ubuntu-slim
  row 'Ubuntu 24.04 Arm64' arm64 '`ubuntu-24.04-arm`' ubuntu-24.04-arm
  row 'macOS 26' x64 '`macos-latest-large`, `macos-26-intel`, `macos-26-large`' macOS-26
  row 'Windows Server 2025' x64 '`windows-latest`, `windows-2025`, or `windows-2025-vs2026`' windows-2025-vs2026
  row 'Windows Server 2022' x64 '`windows-2022`' windows-2022
}

# scenario <name> <README>
scenario() {
  echo "$1"
  export FIX="$here/fix"
  rm -rf "$FIX"
  mkdir -p "$FIX"
  : > "$FIX/output"
  README=$2 OSES='linux windows' GITHUB_OUTPUT=$FIX/output PATH="$here/bin:$PATH" \
    run_step "$here/images.sh" > "$FIX/out" 2>&1
  status=$?
}

scenario 'the table as it is' "$(today)"
check 'succeeds' test "$status" -eq 0
check 'ubuntu-latest gives 24.04' contains "$FIX/output" 'latest-linux=ubuntu-24.04'
check 'the newest Ubuntu is 26.04' contains "$FIX/output" 'next-linux=ubuntu-26.04'
check 'windows-latest gives 2025' contains "$FIX/output" 'latest-windows=windows-2025'
check 'the newest Windows is 2025' contains "$FIX/output" 'next-windows=windows-2025'
check 'reports nothing' lacks "$FIX/out" '::error::'

scenario 'a new Ubuntu with labels of another shape' "$(today; row 'Ubuntu 28.04' x64 '`ubuntu-28.04-lts`' ubuntu-28.04)"
check 'fails' test "$status" -ne 0
check 'names the image' contains "$FIX/out" '::error::The runner-images README lists Ubuntu 28.04 with no label of the shape'

scenario 'a new Windows Server with labels of another shape' \
  "$(today; row 'Windows Server 2028' x64 '`windows-server-2028`' windows-2028)"
check 'fails' test "$status" -ne 0
check 'names the image' contains "$FIX/out" '::error::The runner-images README lists Windows Server 2028 with no label'

scenario 'a new Ubuntu in the usual shape' "$(today; row 'Ubuntu 28.04' x64 '`ubuntu-28.04`' ubuntu-28.04)"
check 'succeeds' test "$status" -eq 0
check 'the newest Ubuntu is 28.04' contains "$FIX/output" 'next-linux=ubuntu-28.04'

scenario 'other names are not checked' \
  "$(today; row 'Ubuntu Slim 2' x64 '`ubuntu-slim-2`' ubuntu-slim-2; row 'macOS 27' x64 '`macos-27-large`' macOS-27)"
check 'succeeds' test "$status" -eq 0
check 'reports nothing' lacks "$FIX/out" '::error::'

finish
