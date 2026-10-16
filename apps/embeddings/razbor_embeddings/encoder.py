"""Offline tokenization and normalized embeddings for code and documents."""

import os
import time

from .bundle import verify_bundle
from .settings import (
    DIMENSIONS,
    DOCUMENT_DIMENSIONS,
    DOCUMENT_MAX_TOKENS,
    MAX_REQUEST_SECONDS,
    MAX_TOKENS,
)


class InputError(Exception):
    """An input cannot be encoded under the selected model tokenization contract."""

    pass


class Encoder:
    """A verified, offline model and tokenizer for one embedding identity."""

    def __init__(self, directory, documents=False):
        """Verify the local bundle, load its model offline, and check its dimensions.

        Hugging Face offline flags are set before importing Transformers. CodeSage
        loads the verified custom implementation; E5 uses built-in model support.
        Unsupported devices or incompatible model configuration fail startup.
        """
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        verify_bundle(directory, documents)
        self.documents = documents
        self.dimensions = DOCUMENT_DIMENSIONS if documents else DIMENSIONS
        self.max_tokens = DOCUMENT_MAX_TOKENS if documents else MAX_TOKENS

        import torch
        from transformers import AutoModel, AutoTokenizer

        self.torch = torch
        self.device = os.environ.get("EMBEDDINGS_DEVICE", "cpu")
        if self.device not in ("cpu", "cuda"):
            raise ValueError("device_invalid")
        self.tokenizer = AutoTokenizer.from_pretrained(
            directory,
            trust_remote_code=not documents,
            local_files_only=True,
            use_fast=documents,
            **({} if documents else {"add_eos_token": True, "add_bos_token": False}),
        )
        self.model = AutoModel.from_pretrained(
            directory,
            trust_remote_code=not documents,
            local_files_only=True,
            weights_only=True,
            use_safetensors=documents,
            torch_dtype=torch.float32,
        ).to(self.device).eval()
        if (
            self.model.config.hidden_size != self.dimensions
            or self.model.config.max_position_embeddings != self.max_tokens
            or self.tokenizer.eos_token_id is None
        ):
            raise ValueError("model_configuration_invalid")

    def tokenize(self, texts, purpose):
        """Tokenize without truncation, validating token limits and the final EOS token.

        Document inputs require a query or passage purpose and receive its E5 prefix.
        The CodeSage tokenizer cache is cleared even when tokenization fails so it
        does not retain submitted source words between requests.
        """
        if self.documents:
            if purpose not in ("query", "passage"):
                raise InputError("input_purpose_invalid")
            texts = [f"{purpose}: {text}" for text in texts]
        try:
            tokens = self.tokenizer(
                texts,
                padding=False,
                truncation=False,
                add_special_tokens=True,
                return_attention_mask=True,
            )
        finally:
            # CodeSage's custom tokenizer otherwise retains every input word.
            if not self.documents:
                self.tokenizer.cache.clear()
        for ids in tokens["input_ids"]:
            if len(ids) > self.max_tokens:
                raise InputError("input_token_limit_exceeded")
            if not ids or ids[-1] != self.tokenizer.eos_token_id:
                raise RuntimeError("tokenizer_eos_missing")
        return tokens

    def pool(self, output, inputs):
        """Reduce model output to one float32 vector per input using model-specific pooling.

        E5 needs an explicit attention-masked mean; CodeSage supplies its own pooler.
        """
        if self.documents:
            # E5 requires attention-masked mean pooling, not BERT's CLS pooler.
            hidden = output.last_hidden_state.float().masked_fill(
                ~inputs["attention_mask"][..., None].bool(), 0.0
            )
            return hidden.sum(dim=1) / inputs["attention_mask"].sum(
                dim=1, keepdim=True
            )
        else:
            # CodeSage implements attention-masked mean pooling itself.
            return output.pooler_output.float()

    def embed(self, texts, purpose=None):
        """Return finite, unit-length vectors in input order without retaining gradients.

        Inputs run individually to avoid padding the batch to its longest member.
        The request deadline is checked between inputs; it cannot interrupt an
        individual model call. Token limits, invalid output, and timeouts propagate
        to the HTTP layer for fixed error responses.
        """
        started = time.monotonic()
        tokens = self.tokenize(texts, purpose)
        embeddings = []
        # Process separately so one long input does not pad every batch member.
        with self.torch.inference_mode():
            for ids, mask in zip(tokens["input_ids"], tokens["attention_mask"], strict=True):
                if time.monotonic() - started > MAX_REQUEST_SECONDS:
                    raise TimeoutError("inference_deadline_exceeded")
                inputs = {
                    "input_ids": self.torch.tensor([ids], device=self.device),
                    "attention_mask": self.torch.tensor([mask], device=self.device),
                }
                output = self.model(**inputs, return_dict=True)
                pooled = self.pool(output, inputs)
                norm = self.torch.linalg.vector_norm(pooled, dim=1, keepdim=True)
                if (
                    pooled.shape != (1, self.dimensions)
                    or not self.torch.isfinite(pooled).all()
                    or not self.torch.isfinite(norm).all()
                    or (norm <= 0).any()
                ):
                    raise RuntimeError("embedding_invalid")
                embeddings.append((pooled / norm).cpu().tolist()[0])
        return embeddings
