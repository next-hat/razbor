# syntax=docker/dockerfile:1.7
FROM node:24-bookworm AS runtime
RUN npm install --global pnpm@12.11.2 --ignore-scripts --no-audit --no-fund
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
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
COPY apps/agent/src apps/agent/src
COPY apps/runner/src apps/runner/src
COPY packages/harness/src packages/harness/src
COPY packages/contracts/src packages/contracts/src

FROM node:24-alpine AS search-tools
ARG TARGETARCH
ADD --checksum=sha256:33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c \
    https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz /tmp/ripgrep.tar.gz
WORKDIR /ripgrep
RUN test "$TARGETARCH" = amd64 \
    && tar -xzf /tmp/ripgrep.tar.gz --strip-components=1 \
    && chmod 0555 rg

FROM node:24-alpine AS node
FROM docker:29.8.0-dind
RUN apk add --no-cache bash git libstdc++ util-linux
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /workspace /workspace
COPY --from=search-tools /ripgrep/rg /workspace/bin/rg
COPY --from=search-tools /ripgrep/LICENSE-MIT /ripgrep/UNLICENSE /usr/share/doc/ripgrep/
COPY apps/runner/dind-entrypoint.sh /usr/local/bin/razbor-entrypoint
RUN chmod 755 /usr/local/bin/razbor-entrypoint
WORKDIR /workspace
ENTRYPOINT ["razbor-entrypoint"]
CMD []
