ARG III_VERSION=0.11.2

FROM iiidev/iii:${III_VERSION} AS iii-image

# Build @agentmemory/agentmemory from this repository and pack it so the
# runtime stage can install a local tarball instead of the npm registry.
# Build context must be the repository root (Railway Root Directory = /).
# node:22-slim ships npm 10.9.x, which crashes this install with
# "Cannot read properties of null (reading 'edgesOut')". Pin Node 24 +
# npm 12 to match the local toolchain that already builds this repo.
FROM node:24-slim AS build

RUN npm install -g npm@12

WORKDIR /workspace
COPY . .
RUN npm install --no-fund --no-audit \
 && npm run build \
 && npm pack --pack-destination /tmp \
 && mv /tmp/agentmemory-agentmemory-*.tgz /tmp/agentmemory.tgz

FROM node:24-slim

ARG III_VERSION=0.11.2
ARG III_SDK_VERSION=0.11.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini gosu curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g npm@12

COPY --from=iii-image /app/iii /usr/local/bin/iii

# Install agentmemory into a dedicated prefix so the local package.json's
# `overrides` field pins iii-sdk down to match the engine (agentmemory's
# caret range `^0.11.2` otherwise resolves to 0.11.6, the version that
# requires the new sandbox-everything worker model the agentmemory CLI
# is not refactored for yet). `npm install -g` ignores overrides, hence
# the local prefix.
WORKDIR /opt/agentmemory
COPY --from=build /tmp/agentmemory.tgz /tmp/agentmemory.tgz
RUN printf '{"name":"agentmemory-deploy","version":"1.0.0","private":true,"overrides":{"iii-sdk":"%s"}}\n' "${III_SDK_VERSION}" > package.json \
 && npm install /tmp/agentmemory.tgz --omit=optional --no-fund --no-audit \
 && rm -f /tmp/agentmemory.tgz \
 && ln -s /opt/agentmemory/node_modules/.bin/agentmemory /usr/local/bin/agentmemory

ENV AGENTMEMORY_III_VERSION=${III_VERSION} \
    TINI_SUBREAPER=1

COPY --chmod=0755 deploy/railway/entrypoint.sh /usr/local/bin/agentmemory-entrypoint.sh

EXPOSE 3111

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentmemory-entrypoint.sh"]
