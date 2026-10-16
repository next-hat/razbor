# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24.14.0

FROM node:${NODE_VERSION}-bookworm-slim AS dependencies
RUN npm install --global pnpm@12.11.2 --ignore-scripts --no-audit --no-fund
WORKDIR /workspace
# Source edits reuse the manifest-only dependency layer.
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
RUN --mount=type=cache,id=razbor-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.json tsconfig.base.json ./
COPY apps/web apps/web
COPY apps/runner/src apps/runner/src
COPY packages packages
RUN --mount=type=cache,target=/workspace/apps/web/.next/cache pnpm --filter @razbor/web build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="razbor-web" \
      org.opencontainers.image.description="Razbor production console and control plane" \
      org.opencontainers.image.source="https://github.com/next-hat/razbor" \
      org.opencontainers.image.url="https://github.com/next-hat/razbor" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /workspace/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
