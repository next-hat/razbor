# syntax=docker/dockerfile:1.7
FROM postgres:17-alpine AS vector
ADD --checksum=sha256:69f4019389af05dc1c9548deb8628e62878e6e207c03907f2b8af2016472cdaa \
    https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v0.8.2 /tmp/pgvector.tar.gz
RUN apk add --no-cache build-base \
    && tar -xzf /tmp/pgvector.tar.gz -C /tmp \
    && make -C /tmp/pgvector-0.8.2 OPTFLAGS="" with_llvm=no \
    && make -C /tmp/pgvector-0.8.2 install with_llvm=no \
    && mkdir -p /usr/share/doc/pgvector \
    && cp /tmp/pgvector-0.8.2/LICENSE /usr/share/doc/pgvector/

FROM postgres:17-alpine AS runtime
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="razbor-postgres" \
      org.opencontainers.image.description="Razbor PostgreSQL 17 with pgvector and separated database roles" \
      org.opencontainers.image.source="https://github.com/next-hat/razbor" \
      org.opencontainers.image.url="https://github.com/next-hat/razbor" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=vector /usr/local/lib/postgresql/vector.so /usr/local/lib/postgresql/
COPY --from=vector /usr/local/share/postgresql/extension/vector* /usr/local/share/postgresql/extension/
COPY --from=vector /usr/share/doc/pgvector /usr/share/doc/pgvector
# Initialization runs only for new volumes; existing database ownership is preserved.
COPY --chmod=0755 scripts/postgres/bootstrap.sh /docker-entrypoint-initdb.d/10-razbor.sh
RUN printf '%s\n' 'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;' > /docker-entrypoint-initdb.d/20-vector.sql
