# syntax=docker/dockerfile:1.7
FROM python:3.12-slim-bookworm AS dependencies
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HF_HOME=/tmp/huggingface HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_DISABLE_PROGRESS_BARS=1 TOKENIZERS_PARALLELISM=false \
    EMBEDDINGS_MODEL_DIR=/models/codesage-small-v2
WORKDIR /app
COPY apps/embeddings/requirements.txt requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url "$TORCH_INDEX_URL" torch==2.14.1 \
    && pip install -r requirements.txt

FROM dependencies AS models
COPY apps/embeddings/razbor_embeddings/__init__.py \
    apps/embeddings/razbor_embeddings/bundle.py \
    apps/embeddings/razbor_embeddings/settings.py razbor_embeddings/
# Pinned, verified bundles are released with the image; serving needs no download.
# HTTP/inference edits preserve the independent model-download layer.
RUN python -c 'import os; from pathlib import Path; from razbor_embeddings.bundle import provision; directory = Path(os.environ["EMBEDDINGS_MODEL_DIR"]); provision(directory); provision(directory.parent / "multilingual-e5-small", documents=True)' \
    && rm -rf /models/*/.cache

FROM dependencies AS runtime
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="razbor-embeddings" \
      org.opencontainers.image.description="Razbor offline CPU inference with pinned code and document models" \
      org.opencontainers.image.source="https://github.com/next-hat/razbor" \
      org.opencontainers.image.url="https://github.com/next-hat/razbor" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN useradd --uid 10001 --create-home embeddings
COPY --chmod=0444 apps/embeddings/service.py /app/service.py
COPY apps/embeddings/razbor_embeddings /app/razbor_embeddings
COPY --from=models /models /models
RUN find /app/razbor_embeddings /models -type d -exec chmod 0555 {} + \
    && find /app/razbor_embeddings /models -type f -exec chmod 0444 {} +
USER embeddings
EXPOSE 8090
ENTRYPOINT ["python", "/app/service.py"]
CMD ["serve"]
