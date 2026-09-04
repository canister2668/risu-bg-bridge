# SPDX-License-Identifier: AGPL-3.0-only
# Explicit verified base required. Installer refuses anything but pocketrisu@1.10.0.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY adapters/ui/ui-continuity.js /opt/risu-bg-ui-kit/adapters/ui/ui-continuity.js
COPY scripts/install-ui-continuity.mjs /opt/risu-bg-ui-kit/scripts/install-ui-continuity.mjs
RUN node /opt/risu-bg-ui-kit/scripts/install-ui-continuity.mjs --host=/app
