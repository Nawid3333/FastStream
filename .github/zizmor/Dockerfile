# The zizmor image: ci.yml's "Lint workflows" job runs it (its settings are in
# .github/zizmor.yml), and tools/linux/setup.sh takes the zizmor binary out of it for the WSL
# verify. Nothing builds this file; both read the FROM line, and toolchain-updates.yml moves
# it to the newest release (tools/check-toolchain.mjs, IMAGES).
FROM ghcr.io/zizmorcore/zizmor:1.33.1@sha256:ecd3ffe6158de1322e05a044ed43749bee12b1dccb7e1a7859bc6ac4b2a1c516
