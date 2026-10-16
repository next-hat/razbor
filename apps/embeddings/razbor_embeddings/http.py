"""Bounded HTTP request handling around the shared local model encoders."""

import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys
import threading

from .encoder import InputError
from .settings import (
    DOCUMENT_MAX_INPUT_BYTES,
    DOCUMENT_MAX_TOKENS,
    MAX_BATCH_SIZE,
    MAX_BODY_BYTES,
    MAX_INPUT_BYTES,
    MAX_TOKENS,
    SOCKET_TIMEOUT_SECONDS,
    identity,
)


class InputByteLimitError(Exception):
    """A submitted text exceeds the selected endpoint UTF-8 byte limit."""

    pass


class Server(ThreadingHTTPServer):
    """Serve bounded request threads with one inference slot shared by both models."""

    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address, encoder, document_encoder, token):
        """Bind the handler with both encoders, bearer credentials, and concurrency limits."""
        self.encoder = encoder
        self.document_encoder = document_encoder
        self.inference_lock = threading.Lock()
        self.token = token
        self.workers = threading.BoundedSemaphore(8)
        super().__init__(address, Handler)

    def get_request(self):
        """Accept a connection and apply the socket timeout before reading its request."""
        connection, address = super().get_request()
        connection.settimeout(SOCKET_TIMEOUT_SECONDS)
        return connection, address

    def process_request(self, request, client_address):
        """Start a bounded request worker, closing connections when all slots are occupied.

        Release the reserved slot if the parent cannot start its worker thread.
        """
        if not self.workers.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.workers.release()
            raise

    def process_request_thread(self, request, client_address):
        """Handle one request and return its worker slot even when processing fails."""
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.workers.release()

    def handle_error(self, request, client_address):
        """Report a fixed failure event without exposing exceptions or request contents."""
        print('{"event":"embeddings_request_failed"}', file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    """Expose health metadata and authenticated embedding endpoints with bounded inputs."""

    server_version = "razbor-embeddings"
    sys_version = ""

    def log_message(self, format, *args):
        """Suppress access logs because request fields may contain credentials or source text."""
        pass

    def send_error(self, code, message=None, explain=None):
        """Replace standard HTTP error pages and reflected details with a fixed JSON error."""
        self.respond(code, {"error": "invalid_http_request"})

    def respond(self, status, value):
        """Write length-delimited JSON, disable caching, and close the connection."""
        body = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        """Return model identity and limits for the two health paths; reject other paths."""
        if self.path not in ("/health", "/documents/health"):
            self.respond(404, {"error": "not_found"})
            return
        documents = self.path == "/documents/health"
        self.respond(200, {
            "status": "ok",
            **identity(documents),
            "maxTokens": DOCUMENT_MAX_TOKENS if documents else MAX_TOKENS,
            "maxInputBytes": DOCUMENT_MAX_INPUT_BYTES if documents else MAX_INPUT_BYTES,
            "maxBatchSize": MAX_BATCH_SIZE,
        })

    def read_payload(self, documents, length):
        """Read the declared body and validate the endpoint-specific JSON shape and limits.

        Return texts and the optional document purpose. Malformed bodies raise
        ValueError, oversized text raises InputByteLimitError, and socket timeouts
        propagate so the handler can choose the appropriate HTTP status.
        """
        max_input_bytes = DOCUMENT_MAX_INPUT_BYTES if documents else MAX_INPUT_BYTES
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError()
        payload = json.loads(raw)
        fields = {"texts", "purpose"} if documents else {"texts"}
        if not isinstance(payload, dict) or set(payload) != fields:
            raise ValueError()
        purpose = payload.get("purpose")
        if documents and purpose not in ("query", "passage"):
            raise ValueError()
        texts = payload["texts"]
        if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_BATCH_SIZE:
            raise ValueError()
        for text in texts:
            if not isinstance(text, str) or not text.strip():
                raise ValueError()
            if len(text.encode("utf-8")) > max_input_bytes:
                raise InputByteLimitError()
        return texts, purpose

    def do_POST(self):
        """Authenticate, validate, and embed code or documents using the shared inference slot.

        Reject unsupported framing and oversized bodies before inference. Requests
        that find the model busy fail immediately; processing failures are mapped
        to fixed public errors, and the inference slot is always released.
        """
        if self.path not in ("/embed", "/documents/embed"):
            self.respond(404, {"error": "not_found"})
            return
        documents = self.path == "/documents/embed"
        provided = self.headers.get("Authorization", "").encode("utf-8")
        expected = f"Bearer {self.server.token}".encode("utf-8")
        if not hmac.compare_digest(provided, expected):
            self.respond(401, {"error": "unauthorized"})
            return
        if self.headers.get_content_type() != "application/json":
            self.respond(415, {"error": "content_type_invalid"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if (
            len(lengths) != 1
            or len(lengths[0]) > 7
            or not lengths[0].isdigit()
            or self.headers.get("Transfer-Encoding")
        ):
            self.respond(400, {"error": "content_length_invalid"})
            return
        length = int(lengths[0])
        if not 0 < length <= MAX_BODY_BYTES:
            self.respond(413, {"error": "body_limit_exceeded"})
            return
        try:
            texts, purpose = self.read_payload(documents, length)
        except InputByteLimitError:
            self.respond(413, {"error": "input_byte_limit_exceeded"})
            return
        except (ValueError, RecursionError):
            self.respond(400, {"error": "input_invalid"})
            return
        except TimeoutError:
            self.respond(408, {"error": "request_timeout"})
            return
        if not self.server.inference_lock.acquire(blocking=False):
            self.respond(503, {"error": "embedding_service_busy"})
            return
        try:
            encoder = self.server.document_encoder if documents else self.server.encoder
            embeddings = encoder.embed(texts, purpose)
        except InputError:
            self.respond(413, {"error": "input_token_limit_exceeded"})
            return
        except TimeoutError:
            self.respond(504, {"error": "inference_timeout"})
            return
        except Exception:
            self.respond(500, {"error": "embedding_failed"})
            return
        finally:
            self.server.inference_lock.release()
        self.respond(200, {**identity(documents), "embeddings": embeddings})
