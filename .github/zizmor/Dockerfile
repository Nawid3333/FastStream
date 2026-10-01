# The zizmor image: ci.yml's "Lint workflows" job runs it (its settings are in
# .github/zizmor.yml). Nothing builds this file; ci.yml reads the FROM line. It is here and not
# in ci.yml because Dependabot updates the tag and digest of a Dockerfile's FROM line (the
# docker entry in .github/dependabot.yml) but not a docker:// line in a workflow.
FROM ghcr.io/zizmorcore/zizmor:1.30.1@sha256:a2eb396d886c053073405c7a980f2139ba2248ec172243cfa3841e57196e8101
