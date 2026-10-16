# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24.14.0

FROM node:${NODE_VERSION}-bookworm-slim AS dependencies
RUN npm install --global pnpm@12.11.2 --ignore-scripts --no-audit --no-fund
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent/package.json apps/agent/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/indexer/package.json apps/indexer/package.json
COPY packages/harness/package.json packages/harness/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/forge-adapters/package.json packages/forge-adapters/package.json
RUN --mount=type=cache,id=razbor-pnpm,target=/pnpm/store pnpm --filter-prod @razbor/indexer... install --prod --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store \
    && test ! -d node_modules/next \
    && test ! -d node_modules/typescript

FROM node:${NODE_VERSION}-bookworm-slim AS memory
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/provision-cbm.sh /tmp/provision-cbm.sh
RUN bash /tmp/provision-cbm.sh /cbm

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="razbor-indexer" \
      org.opencontainers.image.description="Razbor repository indexing with pinned Codebase Memory" \
      org.opencontainers.image.source="https://github.com/next-hat/razbor" \
      org.opencontainers.image.url="https://github.com/next-hat/razbor" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /index-data \
    && chown node:node /index-data
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=dependencies /workspace ./
COPY tsconfig.json tsconfig.base.json ./
COPY apps/indexer/src apps/indexer/src
COPY packages packages
COPY --from=memory /cbm /cbm
USER node
EXPOSE 8790
ENTRYPOINT ["node", "--import=tsx", "apps/indexer/src/index.ts"]
CMD ["--config", "/index-config/indexer.toml"]
