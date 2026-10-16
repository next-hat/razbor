import { publicIdSchema } from "@razbor/contracts";
import { acceptWebhook } from "@razbor/database";
import { logger } from "@razbor/harness/logger";

import { provisionIndex } from "@web/lib/indexer.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Receives a bounded webhook body, delegates signed delivery acceptance, and logs only
 * identifiers, status, and elapsed time.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const hookId = publicIdSchema("webhook").safeParse(id);
  const started = Date.now();
  const log = logger.child({
    hookId: hookId.success ? hookId.data : undefined,
  });
  let status = 503;
  /**
   * Creates an uncached empty ingress response while retaining its status for
   * completion logging.
   */
  const response = (code: number) => {
    status = code;
    return new Response(null, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  };
  log.info("webhook request received");
  try {
    if (!hookId.success) return response(404);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = request.body?.getReader();
    if (reader) {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        void reader.cancel().catch(() => {});
      }, 20000);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (timedOut) return response(408);
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1048576) {
            void reader.cancel().catch(() => {});
            return response(413);
          }
          chunks.push(value);
        }
      } finally {
        clearTimeout(timeout);
        reader.releaseLock();
      }
    }
    return response(
      await acceptWebhook(
        await reviewDatabase(),
        hookId.data,
        Buffer.concat(chunks),
        Object.fromEntries(request.headers),
        (repositoryId) =>
          provisionIndex(repositoryId, true, AbortSignal.timeout(720000)),
      ),
    );
  } catch {
    log.error("webhook request failed before completion");
    return response(503);
  } finally {
    log.info(
      { status, durationMs: Date.now() - started },
      "webhook request completed",
    );
  }
}

/** Rejects unsupported webhook methods with an uncached empty 404 response. */
function notFound() {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

export {
  notFound as GET,
  notFound as HEAD,
  notFound as PUT,
  notFound as PATCH,
  notFound as DELETE,
  notFound as OPTIONS,
};
