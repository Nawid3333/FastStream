# The zizmor image: ci.yml's "Lint workflows" job runs it (its settings are in
# .github/zizmor.yml), and tools/linux/setup.sh takes the zizmor binary out of it for the WSL
# verify. Nothing builds this file; both read the FROM line. It is here and not
# in ci.yml because Dependabot updates the tag and digest of a Dockerfile's FROM line (the
# docker entry in .github/dependabot.yml) but not a docker:// line in a workflow.
FROM ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d
