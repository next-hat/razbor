import { z } from "zod";

import {
  publicIdSchema,
  reviewProgressSchema,
  reviewAttemptMetricsSchema,
  reviewResultSchema,
  runnerSessionSchema,
  runnerModelPolicySchema,
} from "@razbor/contracts";
import {
  authenticateRunner,
  consumeRunnerEnrollment,
  openRunnerSession,
  runnerHeartbeat,
  RunnerInputError,
} from "@razbor/database";

import { reviewDatabase } from "@web/lib/review.js";
import {
  runnerBroker,
  isRunnerRequestError,
  runnerJson,
  RunnerRequestError,
} from "@web/lib/runner-broker.js";

const enrollmentSchema = runnerSessionSchema
  .extend({ token: z.string().min(32).max(256) })
  .strict();

const claimSchema = z
  .object({
    activeAttemptIds: z.array(publicIdSchema("attempt")).max(32).default([]),
    modelPolicy: runnerModelPolicySchema,
  })
  .strict();

const progressSchema = z
  .object({ events: z.array(reviewProgressSchema).min(1).max(20) })
  .strict();

const resultSchema = z.union([
  z
    .object({
      result: reviewResultSchema,
      metrics: reviewAttemptMetricsSchema.optional(),
    })
    .strict(),
  z
    .object({
      failed: z.literal(true),
      terminal: z.boolean(),
      metrics: reviewAttemptMetricsSchema.optional(),
    })
    .strict(),
]);

/**
 * Extracts a bounded bearer credential, rejecting absent or unsupported authorization
 * headers.
 */
function bearer(request: Request, nativeMessages = false) {
  const authorization = request.headers.get("authorization");
  if (!authorization && nativeMessages) {
    const key = request.headers.get("x-api-key");
    if (key && key.length <= 256) return key;
  }
  if (!authorization?.startsWith("Bearer ") || authorization.length > 263)
    throw new RunnerRequestError(401);
  return authorization.slice(7);
}

/**
 * Builds uncached runner responses with a server Date header for lease and deadline
 * comparisons.
 */
function json(value: unknown) {
  return Response.json(value, {
    headers: { "cache-control": "no-store", date: new Date().toUTCString() },
  });
}

/**
 * Routes enrollment, session, and attempt operations through their credential
 * boundaries, returning only controlled public error messages. Path segments are
 * relative to the /api/runner prefix.
 */
export async function handleRunnerRequest(request: Request, path: string[]) {
  try {
    if (
      request.method === "POST" &&
      path.length === 1 &&
      path[0] === "enroll"
    ) {
      const input = enrollmentSchema.parse(await runnerJson(request));
      return json(await consumeRunnerEnrollment(await reviewDatabase(), input));
    }
    if (
      path.length === 1 &&
      ["session", "heartbeat"].includes(path[0]) &&
      request.method === "POST"
    ) {
      const input = runnerSessionSchema.parse(await runnerJson(request));
      if (
        path[0] === "heartbeat" &&
        request.headers.get("x-razbor-session") !== input.sessionId
      )
        throw new RunnerRequestError(401);
      const database = await reviewDatabase();
      return json(
        await (path[0] === "session" ? openRunnerSession : runnerHeartbeat)(
          database,
          bearer(request),
          input,
        ),
      );
    }
    const broker = await runnerBroker();
    if (path[0] === "attempts" && path.length >= 3) {
      const id = publicIdSchema("attempt").parse(path[1]);
      if (path.length === 3 && path[2] === "source" && request.method === "GET")
        return await broker.source(id, bearer(request), request);
      if (
        path.length === 3 &&
        path[2] === "memory" &&
        request.method === "POST"
      )
        return await broker.memory(id, bearer(request), request);
      if (
        path.length === 5 &&
        path[2] === "model" &&
        path[3] === "v1" &&
        (path[4] === "responses" || path[4] === "messages") &&
        request.method === "POST"
      ) {
        const response = await broker.model(
          id,
          bearer(request, path[4] === "messages"),
          request,
          path[4],
        );
        response.headers.set("cache-control", "no-store");
        return response;
      }
      if (
        path.length === 4 &&
        path[2] === "mcp" &&
        ["POST", "GET", "DELETE"].includes(request.method)
      )
        return await broker.externalMcp(
          id,
          bearer(request),
          publicIdSchema("mcpServer").parse(path[3]),
          request,
        );
      if (
        path.length === 3 &&
        path[2] === "mcp" &&
        ["POST", "GET", "DELETE"].includes(request.method)
      )
        return await broker.mcp(id, bearer(request), request);
    }
    if (request.method !== "POST") throw new RunnerRequestError(404);
    const sessionId = z
      .string()
      .uuid()
      .parse(request.headers.get("x-razbor-session"));
    const runner = await authenticateRunner(
      await reviewDatabase(),
      bearer(request),
      sessionId,
    );
    if (path.length === 1 && path[0] === "claim") {
      const input = claimSchema.parse(await runnerJson(request));
      // Reservation already enforces enabled state. A reservation made just
      // before draining is an active attempt and can still reach its host.
      return json(
        await broker.claim(
          runner.runnerId,
          sessionId,
          input.activeAttemptIds,
          input.modelPolicy,
        ),
      );
    }
    if (path.length === 3 && path[0] === "attempts") {
      const id = publicIdSchema("attempt").parse(path[1]);
      if (path[2] === "renew") {
        z.object({})
          .strict()
          .parse(await runnerJson(request));
        return json(await broker.renew(id, runner.runnerId, sessionId));
      }
      if (path[2] === "progress") {
        const input = progressSchema.parse(await runnerJson(request));
        return json(
          await broker.progress(id, runner.runnerId, sessionId, input.events),
        );
      }
      if (path[2] === "result") {
        const input = resultSchema.parse(await runnerJson(request, 1000000));
        return json(
          await broker.result(
            id,
            runner.runnerId,
            sessionId,
            "result" in input
              ? input
              : { terminal: input.terminal, metrics: input.metrics },
          ),
        );
      }
    }
    throw new RunnerRequestError(404);
  } catch (error) {
    const status =
      isRunnerRequestError(error) || error instanceof RunnerInputError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : 503;
    return Response.json(
      {
        error:
          status === 409
            ? "runner session or attempt ownership unavailable"
            : "runner operation rejected",
      },
      {
        status,
        headers: {
          "cache-control": "no-store",
          date: new Date().toUTCString(),
        },
      },
    );
  }
}
