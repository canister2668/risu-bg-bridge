# risu-bg-extension adapter image for PocketRisu 1.10.0.
#
# The base tag below is pinned by targets/pocket.lock.yaml
# (imageId sha256:f41477424f0764179d3cd4b6d0761bea5f34f89dee69c76bd362bb9e4561282a).
# scripts/build.mjs re-verifies that pin (lock -> snapshot hashes) before the
# context is usable, and checks the COPY lines below against the series's
# touched files so this Dockerfile can never silently drift behind
# adapters/pocket/series.yaml.

FROM risuai:nodeonly-client-aux-handoff-20260829

COPY bg-worker.cjs /app/server/node/bg-worker.cjs
COPY server.cjs /app/server/node/server.cjs
COPY model-jobs.cjs /app/server/node/model-jobs.cjs

# Build context is produced by:
#   node scripts/build.mjs --target pocket --out <ctx>
# Image build (local only; nothing here deploys or restarts anything):
#   docker build -t risuai:pocketrisu-1.10.0-bgbridge <ctx>