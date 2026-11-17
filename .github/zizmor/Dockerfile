# The zizmor image: ci.yml's "Lint workflows" job runs it (its settings are in
# .github/zizmor.yml), and tools/linux/setup.sh takes the zizmor binary out of it for the WSL
# verify. Nothing builds this file; both read the FROM line, and toolchain-updates.yml moves
# it to the newest release (tools/check-toolchain.mjs, IMAGES).
FROM ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d
