"""Pinned model identities, request limits, and validated environment settings."""

import os
from pathlib import Path


MODEL = "codesage/codesage-small-v2"

REVISION = "4844c2f24b25e181aa43ca058cc73dd2622565c1"

DIMENSIONS = 1024

MAX_TOKENS = 2048

MAX_INPUT_BYTES = 1800

DOCUMENT_MODEL = "intfloat/multilingual-e5-small"

DOCUMENT_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"

DOCUMENT_DIMENSIONS = 384

DOCUMENT_MAX_TOKENS = 512

# Bound request text; token limits still apply after prefixing and normalization.
DOCUMENT_MAX_INPUT_BYTES = 480

MAX_BATCH_SIZE = 8

MAX_BODY_BYTES = 128 * 1024

SOCKET_TIMEOUT_SECONDS = 15

MAX_REQUEST_SECONDS = 120

MODEL_FILES = (
    "added_tokens.json",
    "config.json",
    "config_codesage.py",
    "merges.txt",
    "modeling_codesage.py",
    "pytorch_model.bin",
    "special_tokens_map.json",
    "tokenization_codesage.py",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
)

DOCUMENT_MODEL_FILES = (
    "config.json",
    "model.safetensors",
    "sentencepiece.bpe.model",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
)

MANIFEST = "razbor-model.json"


def identity(documents=False):
    """Return the pinned model identity reported in manifests and HTTP responses.

    The documents flag selects E5; code inputs use CodeSage.
    """
    if documents:
        return {
            "model": DOCUMENT_MODEL,
            "revision": DOCUMENT_REVISION,
            "dimensions": DOCUMENT_DIMENSIONS,
        }
    return {"model": MODEL, "revision": REVISION, "dimensions": DIMENSIONS}


def read_token():
    """Read the bearer token, preferring the configured secret file over the environment.

    Raise ValueError unless it contains at least 32 non-whitespace ASCII characters;
    file access errors propagate without including the token in diagnostics.
    """
    token_file = os.environ.get("EMBEDDINGS_TOKEN_FILE")
    token = (
        Path(token_file).read_text().strip()
        if token_file
        else os.environ.get("EMBEDDINGS_TOKEN", "").strip()
    )
    if len(token) < 32 or not token.isascii() or any(char.isspace() for char in token):
        raise ValueError("embeddings_token_invalid")
    return token


def bounded_integer(name, default, minimum, maximum):
    """Read an integer environment setting and enforce inclusive bounds.

    Use default only when the variable is absent. Invalid numbers or values
    outside minimum and maximum raise ValueError.
    """
    value = int(os.environ.get(name, default))
    if not minimum <= value <= maximum:
        raise ValueError("configuration_invalid")
    return value
