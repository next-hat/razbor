FROM python:3.12-slim-bookworm

ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/tmp/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_DISABLE_PROGRESS_BARS=1 \
    TOKENIZERS_PARALLELISM=false \
    EMBEDDINGS_MODEL_DIR=/models/codesage-small-v2

WORKDIR /app

COPY apps/embeddings/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --index-url "$TORCH_INDEX_URL" torch==2.14.1 \
    && pip install --no-cache-dir -r /app/requirements.txt \
    && useradd --uid 10001 --create-home embeddings \
    && mkdir /models \
    && chown embeddings:embeddings /models

COPY --chown=root:root --chmod=0444 apps/embeddings/service.py /app/service.py
COPY --chown=root:root apps/embeddings/razbor_embeddings/ /app/razbor_embeddings/
RUN find /app/razbor_embeddings -type d -exec chmod 0555 {} + \
    && find /app/razbor_embeddings -type f -exec chmod 0444 {} +

USER embeddings

EXPOSE 8090

ENTRYPOINT ["python", "/app/service.py"]
CMD ["serve"]
