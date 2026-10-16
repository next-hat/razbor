"""Download pinned model bundles and verify their local integrity before use."""

import hashlib
import json
from pathlib import Path
import tempfile

from .settings import DOCUMENT_MODEL_FILES, MANIFEST, MODEL_FILES, identity


def digest(path):
    """Stream a file into SHA-256 and return its hexadecimal digest."""
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def verify_bundle(directory, documents=False):
    """Validate a local bundle against its pinned identity and recorded file hashes.

    Require the manifest to list exactly the model file allowlist. Missing or
    unreadable files and identity, manifest, or hash mismatches abort loading.
    """
    files = DOCUMENT_MODEL_FILES if documents else MODEL_FILES
    manifest = json.loads((directory / MANIFEST).read_text())
    if any(manifest.get(key) != value for key, value in identity(documents).items()):
        raise ValueError("model_identity_mismatch")
    hashes = manifest.get("files")
    if not isinstance(hashes, dict) or set(hashes) != set(files):
        raise ValueError("model_manifest_invalid")
    for filename in files:
        if digest(directory / filename) != hashes[filename]:
            raise ValueError("model_file_mismatch")


def provision(directory, documents=False):
    """Download and atomically publish a verified bundle for the selected model.

    Existing directories are verified and reused, never overwritten. New bundles
    are downloaded at the pinned revision into a sibling temporary directory,
    then renamed into place only after every required file has been verified.
    """
    from huggingface_hub import snapshot_download

    model_identity = identity(documents)
    files = DOCUMENT_MODEL_FILES if documents else MODEL_FILES

    if directory.exists():
        verify_bundle(directory, documents)
        print(json.dumps({"status": "already_provisioned", **model_identity}))
        return
    directory.parent.mkdir(parents=True, exist_ok=True)
    # Only publish a complete bundle. A failed download leaves no ready directory.
    with tempfile.TemporaryDirectory(dir=directory.parent, prefix=".provision-") as staging:
        bundle = Path(staging) / "model"
        snapshot_download(
            repo_id=model_identity["model"],
            revision=model_identity["revision"],
            allow_patterns=list(files),
            local_dir=bundle,
            token=False,
            max_workers=2,
        )
        manifest = {
            **model_identity,
            "files": {filename: digest(bundle / filename) for filename in files},
        }
        (bundle / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n")
        verify_bundle(bundle, documents)
        bundle.rename(directory)
    print(json.dumps({"status": "provisioned", **model_identity}))
