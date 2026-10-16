"""Pinned, local code and document inference; explicit online provisioning."""

import argparse
import json
import logging
import os
from pathlib import Path
import sys

from razbor_embeddings.bundle import provision
from razbor_embeddings.encoder import Encoder
from razbor_embeddings.http import Server
from razbor_embeddings.settings import bounded_integer, identity, read_token


def main():
    """Run explicit model provisioning or start the offline HTTP service from CLI options.

    Provision both model bundles before serving is possible. Serving validates
    credentials, configures PyTorch threads, loads both encoders, and emits only
    fixed readiness metadata before accepting requests.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("provision", "serve"))
    args = parser.parse_args()
    # Third-party warnings may include paths or request contents; only emit the
    # service's fixed status/error events. No per-request access logs are kept.
    logging.disable(logging.CRITICAL)
    directory = Path(os.environ.get("EMBEDDINGS_MODEL_DIR", "/models/codesage-small-v2"))
    document_directory = Path(os.environ.get(
        "EMBEDDINGS_DOCUMENT_MODEL_DIR", str(directory.parent / "multilingual-e5-small")
    ))
    if args.command == "provision":
        provision(directory)
        provision(document_directory, documents=True)
        return
    token = read_token()

    import torch

    torch.set_num_threads(bounded_integer("EMBEDDINGS_CPU_THREADS", "2", 1, 32))
    torch.set_num_interop_threads(1)
    encoder = Encoder(directory)
    document_encoder = Encoder(document_directory, documents=True)
    port = bounded_integer("EMBEDDINGS_PORT", "8090", 1, 65535)
    server = Server(("0.0.0.0", port), encoder, document_encoder, token)
    print(json.dumps({"event": "embeddings_ready", **identity()}))
    print(json.dumps({"event": "document_embeddings_ready", **identity(True)}))
    with server:
        server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception:
        print('{"event":"embeddings_startup_failed"}', file=sys.stderr)
        sys.exit(1)
