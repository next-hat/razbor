import { setTimeout as delay } from "node:timers/promises";

import { publicIdSchema, reviewLogSchema } from "@razbor/contracts";
import { publicationView, reviewLogs, type Database } from "@razbor/database";

import { canManageResource } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";
import { reviewWithReadiness } from "@web/lib/review-readiness.js";
import {
  authErrorResponse,
  canAccessRepository,
  requireApiUser,
} from "@web/lib/auth.js";
import { sanitizeReviewView } from "@web/lib/request-access.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Streams an authorized repository's review state and administrator-only logs,
 * rechecking grants during polling and ending after terminal publication or a
 * bounded connection lifetime.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!publicIdSchema("review").safeParse(id).success)
    return Response.json({ error: "invalid review ID" }, { status: 400 });
  const rawCursor = request.headers.get("last-event-id") ?? "0";
  if (!/^\d{1,9}$/.test(rawCursor))
    return Response.json({ error: "invalid log cursor" }, { status: 400 });
  let database;
  try {
    const user = await requireApiUser(request);
    database = await reviewDatabase();
    const review = await reviewWithReadiness(database, id);
    if (!review || !canAccessRepository(user, review.repositoryId))
      return Response.json({ error: "review not found" }, { status: 404 });
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      { error: "review storage unavailable" },
      { status: 503 },
    );
  }
  const db = database;
  const abort = new AbortController();
  /**
   * Cancels polling and further stream writes when the request or response stream is
   * aborted.
   */
  const stop = () => abort.abort();
  request.signal.addEventListener("abort", stop, { once: true });
  if (request.signal.aborted) stop();
  let cursor = Number(rawCursor);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    /**
     * Polls durable review state before logs, respecting backpressure and cleaning up
     * the request abort listener when streaming ends.
     */
    async start(controller) {
      const started = Date.now();
      /**
       * Enqueues one SSE event with an optional resume cursor unless the stream has
       * been aborted.
       */
      const send = (event: string, data: unknown, next?: number) => {
        if (abort.signal.aborted) return;
        const eventId = next === undefined ? "" : `id: ${next}\n`;
        controller.enqueue(
          encoder.encode(
            `${eventId}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          ),
        );
      };
      try {
        while (!abort.signal.aborted && Date.now() - started < 55000) {
          if ((controller.desiredSize ?? 0) <= 0) break;
          // Read status first: terminal durable state is written after log flush.
          const review = await reviewWithReadiness(db, id);
          if (!review) break;
          const user = await requireApiUser(request, {
            repositoryId: review.repositoryId,
          });
          const interaction = await publicationView(db, id);
          send("review", {
            ...(canManageResource(user, "repository")
              ? review
              : sanitizeReviewView(review)),
            interaction,
          });
          const logs = canManageResource(user, "repository")
            ? await forwardLogs(db, id, cursor, send)
            : { cursor, caughtUp: true, logsHealthy: true };
          cursor = logs.cursor;
          const { caughtUp, logsHealthy } = logs;
          const terminal =
            review.status === "completed" || review.status === "failed";
          if (terminal && caughtUp && !publicationIsPending(interaction)) {
            send("done", {});
            break;
          }
          await delay(caughtUp || !logsHealthy ? 1000 : 100, undefined, {
            signal: abort.signal,
          });
        }
      } catch {
        if (!abort.signal.aborted) send("unavailable", {});
      } finally {
        request.signal.removeEventListener("abort", stop);
        if (!abort.signal.aborted) controller.close();
      }
    },
    cancel: stop,
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

type SendEvent = (event: string, data: unknown, next?: number) => void;

/**
 * Forwards one bounded page of validated progress records, advancing past private or
 * malformed historical logs and reporting progress-storage availability.
 */
async function forwardLogs(
  database: Database,
  id: string,
  cursor: number,
  send: SendEvent,
) {
  let caughtUp = false;
  let logsHealthy = true;
  try {
    const page = await reviewLogs(database, id, cursor);
    for (const line of page.logs) {
      cursor = line.sequence;
      const event = reviewLogSchema.safeParse(line.event);
      if (event.success)
        send("log", { ...event.data, sequence: cursor }, cursor);
    }
    caughtUp = page.caughtUp;
    send("logs", { available: true, count: page.count });
  } catch {
    logsHealthy = false;
    send("logs", { available: false });
  }
  return { cursor, caughtUp, logsHealthy };
}

/**
 * Keeps the stream open while an existing forge interaction still needs acknowledgement
 * or publication.
 */
function publicationIsPending(
  interaction: Awaited<ReturnType<typeof publicationView>>,
) {
  return (
    interaction &&
    (!interaction.acknowledged ||
      !interaction.publication ||
      ["pending", "publishing"].includes(interaction.publication.state))
  );
}
