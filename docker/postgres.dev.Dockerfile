FROM postgres:17-alpine

# Keep the existing Alpine/PostgreSQL 17 data format and add pinned pgvector.
ADD --checksum=sha256:69f4019389af05dc1c9548deb8628e62878e6e207c03907f2b8af2016472cdaa \
    https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v0.8.2 /tmp/pgvector.tar.gz
RUN apk add --no-cache --virtual .pgvector-build build-base \
    && tar -xzf /tmp/pgvector.tar.gz -C /tmp \
    && make -C /tmp/pgvector-0.8.2 OPTFLAGS="" with_llvm=no \
    && make -C /tmp/pgvector-0.8.2 install with_llvm=no \
    && mkdir -p /usr/share/doc/pgvector \
    && cp /tmp/pgvector-0.8.2/LICENSE /usr/share/doc/pgvector/ \
    && rm -rf /tmp/pgvector-0.8.2 /tmp/pgvector.tar.gz \
    && apk del .pgvector-build
