import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  Agent,
  Dispatcher1Wrapper,
  type RequestInit as UndiciRequestInit,
} from "undici";

import { memoryOperationSchema, type ReviewProgress } from "@razbor/contracts";

import type { ResolvedConfig } from "@runner/src/config.js";
import { PermanentError } from "@runner/src/errors.js";

// Model generation can wait up to an hour for headers. Each request's abort
// signal owns the finite deadline instead of Undici's shorter transport timers.
const modelDispatcher = new Dispatcher1Wrapper(
  new Agent({ headersTimeout: 0, bodyTimeout: 0 }),
);

/**
 * Collect a stream into memory, rejecting it as soon as the configured byte limit is
 * exceeded.
 */
async function boundedBody(stream: AsyncIterable<Uint8Array>, limit: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Parse finite, nonnegative decimal header values without accepting signs or unrelated
 * numeric syntax.
 */
function nonnegativeNumber(value: string | null) {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Normalize native Claude quota headers for the shared request and token limiter. */
function anthropicQuotaHeaders(headers: Headers, now: number) {
  const normalized = new Headers(headers);
  for (const kind of ["requests", "tokens"] as const) {
    for (const field of ["remaining", "limit"] as const) {
      const value = headers.get(`anthropic-ratelimit-${kind}-${field}`);
      if (value !== null) normalized.set(`x-ratelimit-${field}-${kind}`, value);
    }
    const value = headers.get(`anthropic-ratelimit-${kind}-reset`);
    const date =
      value && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
    if (Number.isFinite(date))
      normalized.set(
        `x-ratelimit-reset-${kind}`,
        String(Math.max(1, date - now) / 1000),
      );
  }
  return normalized;
}

/** Parse provider quota-reset delays expressed as seconds or concatenated duration units. */
function resetDelay(value: string | null) {
  const seconds = nonnegativeNumber(value);
  if (seconds !== undefined) return seconds * 1000;
  if (!value || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value))
    return undefined;
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
  };
  const milliseconds = [
    ...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/gy),
  ].reduce((total, match) => total + Number(match[1]) * units[match[2]], 0);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/**
 * Read retry delay headers in precedence order, accepting HTTP dates only when they resemble
 * date syntax.
 */
function retryDelay(headers: Headers, now: number) {
  const milliseconds = nonnegativeNumber(headers.get("retry-after-ms"));
  if (milliseconds !== undefined) return milliseconds;
  const value = headers.get("retry-after");
  const seconds = nonnegativeNumber(value);
  if (seconds !== undefined && Number.isFinite(seconds * 1000))
    return seconds * 1000;
  // A malformed numeric delay must not be interpreted as a calendar date.
  if (!value || !/^[A-Za-z]{3},/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Honor explicit retry hints before falling back to transient HTTP status codes. */
function retryableResponse(response: Response) {
  if (response.ok) return false;
  const hint = response.headers.get("x-should-retry");
  if (hint === "false") return false;
  return (
    hint === "true" ||
    [408, 409, 429].includes(response.status) ||
    response.status >= 500
  );
}

type RateBudget = {
  remaining: number;
  resetsAt: number;
  limit?: number;
};

type QuotaReservation = {
  generation: number;
  startedAlone: boolean;
};

type QuotaState = {
  key: string;
  budgets: Map<"requests" | "tokens", RateBudget>;
  requestIntervalMs: number;
  nextRequestAt: number;
  blockedUntil: number;
  admissionGeneration: number;
  inFlightRequests: number;
  users: number;
  cleanup?: ReturnType<typeof setTimeout>;
};

export type RelayConfig = Pick<
  ResolvedConfig,
  "model" | "endpoint" | "apiKey" | "runner"
>;

type Access = {
  endpoint: string;
  apiKey: string;
  model: ResolvedConfig["model"] & { model: string };
  quota: QuotaState;
  controller: AbortController;
  requests: number;
  busy: boolean;
  expires: number;
  mcpToken?: string;
  mcpEndpoint?: string;
  mcpQueryMs?: number;
  mcpServers?: Map<
    string,
    { endpoint: string; token: string; queryMs: number }
  >;
  memoryToken?: string;
  memoryEndpoint?: string;
  memoryQueryMs?: number;
  diagnostic?: (message: string, level?: ReviewProgress["level"]) => void;
};

type RelayResponse = {
  status: number;
  body: string | Buffer | ReadableStream<Uint8Array> | null;
  headers?: Record<string, string>;
};

/** Return a fixed rejection body that cannot expose upstream payloads or credentials. */
function failure(status: number): RelayResponse {
  return {
    status,
    body: '{"error":"model request rejected"}',
    headers: { "x-should-retry": "false" },
  };
}

/**
 * Choose a quota reset time from provider hints, an active prior window, or a fixed
 * one-minute fallback.
 */
function budgetReset(
  now: number,
  reset: number | undefined,
  retryAfterMs: number | undefined,
  previous: RateBudget | undefined,
) {
  if (reset && Number.isFinite(reset)) return now + reset;
  if (retryAfterMs !== undefined) return now + retryAfterMs;
  if (previous && previous.resetsAt > now) return previous.resetsAt;
  return now + 60000;
}

/**
 * Classify model failures using their actual phase, retaining only bounded request size,
 * known error classes, parse metadata, and an allowlisted stack-frame location.
 */
function requestFailure(
  error: unknown,
  signal: AbortSignal,
  operationSignal: AbortSignal,
  timeout: number,
  phase: "body_read" | "json_parse" | "model_policy" | "upstream_forward",
  bodyBytes?: number,
) {
  const errorClass =
    error instanceof Error &&
    [
      "Error",
      "SyntaxError",
      "TypeError",
      "RangeError",
      "AggregateError",
      "AbortError",
      "TimeoutError",
    ].includes(error.name)
      ? error.name
      : "UnknownError";
  const details = [`phase ${phase}`, `class ${errorClass}`];
  if (bodyBytes !== undefined) details.push(`request body ${bodyBytes} bytes`);
  if (phase === "json_parse" && error instanceof SyntaxError) {
    details.push(
      bodyBytes === 0
        ? "JSON empty_body"
        : error.message === "Unexpected end of JSON input"
          ? "JSON unexpected_end"
          : "JSON invalid_json",
    );
    // Parse messages may quote request content. Extract only the bounded numeric
    // position suffix emitted by JSON.parse, never the surrounding message.
    const position =
      / at position (\d{1,8})(?: \(line \d+ column \d+\))?$/.exec(
        error.message,
      );
    if (position && Number(position[1]) <= (bodyBytes ?? 0))
      details.push(`JSON position ${position[1]}`);
  }
  if (error instanceof Error) {
    // Skip the message line and disclose only the first recognized module and line.
    // The remainder may contain credentials, provider URLs, or quoted payloads.
    for (const line of (error.stack ?? "")
      .slice(0, 16384)
      .split("\n")
      .slice(1)) {
      const frame =
        /(?:^|[\s(/])(apps\/runner\/src\/relay\.ts|apps\/web\/lib\/runner-broker\.ts|node:internal\/deps\/undici\/undici|node_modules\/next\/dist\/server\/lib\/patch-fetch\.js|\.next\/server\/chunks\/[A-Za-z0-9_-]{1,64}\.js):(\d{1,8}):\d{1,8}\)?$/.exec(
          line,
        );
      if (!frame) continue;
      const module = frame[1].startsWith(".next/")
        ? "next/server/chunk"
        : frame[1].replace("node_modules/", "");
      details.push(`frame ${module}:${frame[2]}`);
      break;
    }
  }
  const reason = signal.aborted
    ? "Model request cancelled or attempt deadline exceeded"
    : operationSignal.aborted
      ? `Model request timed out after ${timeout}ms`
      : phase === "json_parse" && error instanceof SyntaxError
        ? "Model relay received invalid request JSON"
        : "Model transport failed or exceeded its configured payload limit";
  return `${reason} · ${details.join(" · ")}`;
}

export class ModelRelay {
  private readonly active = new Map<string, Access>();
  private readonly quotas = new Map<string, QuotaState>();

  /**
   * Share pacing state by a hash of endpoint and credential, retaining no raw credentials in
   * the quota key.
   */
  private acquireQuota(endpoint: string, apiKey: string) {
    const key = createHash("sha256")
      .update(JSON.stringify([endpoint, apiKey]))
      .digest("hex");
    let quota = this.quotas.get(key);
    if (!quota) {
      quota = {
        key,
        budgets: new Map(),
        requestIntervalMs: 0,
        nextRequestAt: 0,
        blockedUntil: 0,
        admissionGeneration: 0,
        inFlightRequests: 0,
        users: 0,
      };
      this.quotas.set(key, quota);
    }
    clearTimeout(quota.cleanup);
    quota.users++;
    return quota;
  }

  /**
   * Retain idle quota state until its active pacing windows expire, then remove it without
   * disturbing concurrent users or requests.
   */
  private retireQuota(quota: QuotaState) {
    if (
      this.quotas.get(quota.key) !== quota ||
      quota.users ||
      quota.inFlightRequests
    )
      return;
    clearTimeout(quota.cleanup);
    const expires = Math.max(
      quota.blockedUntil,
      quota.nextRequestAt,
      ...[...quota.budgets.values()].map((budget) => budget.resetsAt),
    );
    const remaining = expires - Date.now();
    if (remaining <= 0) {
      this.quotas.delete(quota.key);
      return;
    }
    // Retain shared pacing across consecutive attempts, then remove idle state
    // once its provider quota windows expire. Never retain upstream credentials.
    quota.cleanup = setTimeout(
      () => this.retireQuota(quota),
      Math.min(remaining, 2147483647),
    ).unref();
  }

  /**
   * Apply provider rate-limit headers while tracking whether the response can safely replace
   * an isolated reservation estimate.
   */
  private observeLimits(
    quota: QuotaState,
    headers: Headers,
    now: number,
    reservation: QuotaReservation,
    retryAfterMs?: number,
  ) {
    const isolated =
      reservation.startedAlone &&
      reservation.generation === quota.admissionGeneration;
    const rpm = nonnegativeNumber(headers.get("x-ratelimit-limit-requests"));
    if (rpm !== undefined && rpm > 0) quota.requestIntervalMs = 60000 / rpm;
    for (const kind of ["requests", "tokens"] as const) {
      this.observeBudget(quota, kind, headers, now, isolated, retryAfterMs);
    }
  }

  /**
   * Update a request or token budget without allowing overlapping responses to restore quota
   * reserved by another request.
   */
  private observeBudget(
    quota: QuotaState,
    kind: "requests" | "tokens",
    headers: Headers,
    now: number,
    isolated: boolean,
    retryAfterMs?: number,
  ) {
    const remaining = nonnegativeNumber(
      headers.get(`x-ratelimit-remaining-${kind}`),
    );
    if (remaining === undefined) return;
    const reset = resetDelay(headers.get(`x-ratelimit-reset-${kind}`));
    const previous = quota.budgets.get(kind);
    const reportedLimit = nonnegativeNumber(
      headers.get(`x-ratelimit-limit-${kind}`),
    );
    const limit =
      reportedLimit !== undefined && reportedLimit > 0
        ? reportedLimit
        : previous?.limit;
    quota.budgets.set(kind, {
      limit,
      // An isolated response replaces its own estimate with provider quota.
      // Overlapping responses must not restore another request's reservation.
      remaining:
        !isolated && previous && previous.resetsAt > now
          ? Math.min(previous.remaining, remaining)
          : remaining,
      // Azure can report zero even with an active quota. Keep a fixed fallback
      // window: extending it on each response would prevent quota replenishment.
      resetsAt: budgetReset(now, reset, retryAfterMs, previous),
    });
  }

  /**
   * Refresh expired quota windows and compute when the next request can reserve its
   * estimated cost.
   */
  private quotaReadiness(
    quota: QuotaState,
    now: number,
    estimatedTokens: number,
  ) {
    let readyAt = Math.max(quota.blockedUntil, quota.nextRequestAt);
    const constraints: string[] = [];
    for (const [kind, budget] of quota.budgets) {
      if (budget.resetsAt <= now) {
        if (budget.limit === undefined) {
          quota.budgets.delete(kind);
          continue;
        }
        // Keep reservations active across resets, including before the next
        // response arrives. Otherwise concurrent attempts could overspend.
        budget.remaining = budget.limit;
        budget.resetsAt = now + 60000;
      }
      // An estimate larger than capacity reserves a full window, allowing
      // the provider to decide whether this single request actually fits.
      const cost =
        kind === "requests"
          ? 1
          : Math.min(estimatedTokens, budget.limit ?? Infinity);
      if (budget.remaining < cost) {
        readyAt = Math.max(readyAt, budget.resetsAt);
        constraints.push(
          `${kind} ${Math.floor(budget.remaining)} remaining / ${Math.ceil(cost)} required`,
        );
      }
    }
    return { readyAt, constraints };
  }

  /**
   * Wait cancellably for shared provider quota, then reserve pacing and estimated token
   * usage synchronously before dispatch.
   */
  private async waitForQuota(
    access: Access,
    signal: AbortSignal,
    estimatedTokens: number,
  ) {
    const quota = access.quota;
    for (;;) {
      signal.throwIfAborted();
      const now = Date.now();
      const { readyAt, constraints } = this.quotaReadiness(
        quota,
        now,
        estimatedTokens,
      );
      if (readyAt <= now) {
        // Reserve synchronously before fetch so concurrent attempts share pacing.
        quota.nextRequestAt = now + quota.requestIntervalMs;
        for (const [kind, budget] of quota.budgets)
          budget.remaining = Math.max(
            0,
            budget.remaining -
              (kind === "requests"
                ? 1
                : Math.min(estimatedTokens, budget.limit ?? Infinity)),
          );
        const reservation = {
          generation: ++quota.admissionGeneration,
          startedAlone: quota.inFlightRequests === 0,
        };
        quota.inFlightRequests++;
        return reservation;
      }
      const waitMs = Math.ceil(Math.min(readyAt - now, access.expires - now));
      if (waitMs >= 500) {
        const detail = constraints.length ? " · " + constraints.join("; ") : "";
        access.diagnostic?.(
          `Model rate-limit pacing · waiting ${(waitMs / 1000).toFixed(1)}s before sending${detail}`,
          "info",
        );
      }
      await delay(Math.max(1, waitMs), undefined, { signal });
    }
  }

  readonly server = createServer((req, res) => {
    void this.handle(req)
      .then(async ({ status, body, headers }) => {
        res.writeHead(status, {
          "content-type": "application/json",
          ...headers,
        });
        if (body instanceof ReadableStream)
          await pipeline(
            Readable.fromWeb(
              body as import("node:stream/web").ReadableStream<Uint8Array>,
            ),
            res,
          );
        else res.end(body ?? undefined);
      })
      .catch(() => {
        if (!res.destroyed) {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.writeHead(502, { "x-should-retry": "false" });
          res.end('{"error":"model request failed"}');
        }
      });
  });
  /**
   * Configure the local HTTP server with bounded request time, header time, and header
   * count.
   */
  constructor(private readonly c: RelayConfig) {
    this.server.requestTimeout = Math.min(c.model.timeout_ms, 60000);
    this.server.headersTimeout = Math.min(c.model.timeout_ms, 10000);
    this.server.maxHeadersCount = 32;
  }
  /**
   * Issue a random attempt capability bound to fixed model, MCP, and memory targets;
   * cancellation or explicit revocation aborts its upstream work.
   */
  issue(
    signal: AbortSignal,
    mcp?: { token: string; endpoint: string; queryMs: number },
    diagnostic?: (message: string, level?: ReviewProgress["level"]) => void,
    config: RelayConfig = this.c,
    memory?: { token: string; endpoint: string; queryMs: number },
    mcpServers?: {
      id: string;
      token: string;
      endpoint: string;
      queryMs: number;
    }[],
  ) {
    if (!config.endpoint || !config.apiKey || !config.model.model)
      throw new PermanentError("No AI reviewer model connection is configured");
    const quota = this.acquireQuota(config.endpoint, config.apiKey);
    const token = randomBytes(32).toString("hex");
    const access: Access = {
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: { ...config.model, model: config.model.model },
      quota,
      controller: new AbortController(),
      requests: 0,
      busy: false,
      expires: Date.now() + this.c.runner.timeout_ms,
      mcpToken: mcp?.token,
      mcpEndpoint: mcp?.endpoint,
      mcpQueryMs: mcp?.queryMs,
      mcpServers: mcpServers?.length
        ? new Map(mcpServers.map((server) => [server.id, server]))
        : undefined,
      memoryToken: memory?.token,
      memoryEndpoint: memory?.endpoint,
      memoryQueryMs: memory?.queryMs,
      diagnostic,
    };
    this.active.set(token, access);
    /**
     * Remove the capability once, abort its in-flight work, release its quota user, and
     * detach the cancellation listener.
     */
    const revoke = () => {
      if (!this.active.delete(token)) return;
      access.controller.abort();
      quota.users--;
      this.retireQuota(quota);
      signal.removeEventListener("abort", revoke);
    };
    signal.addEventListener("abort", revoke, { once: true });
    if (signal.aborted) revoke();
    return { token, revoke };
  }
  /**
   * Adapt a Fetch request to the same authorization and body-limit path used by the local
   * HTTP relay, without opening a listening socket.
   */
  async handleRequest(request: Request): Promise<Response> {
    request.signal.throwIfAborted();
    const stream = request.body
      ? Readable.fromWeb(
          request.body as import("node:stream/web").ReadableStream<Uint8Array>,
        )
      : Readable.from([]);
    const incoming = Object.assign(stream, {
      method: request.method,
      url: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
    }) as IncomingMessage;
    const { status, body, headers } = await this.handle(
      incoming,
      request.signal,
    );
    return new Response(
      [204, 205, 304].includes(status)
        ? null
        : body instanceof ReadableStream ||
            typeof body === "string" ||
            body === null
          ? body
          : new Uint8Array(body),
      {
        status,
        headers: { "content-type": "application/json", ...headers },
      },
    );
  }
  /** Expose the local relay on the configured port for agents on the isolated job network. */
  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.c.model.relay_port, "0.0.0.0", resolve);
    });
  }
  /**
   * Abort all capability work, clear quota timers, and close every relay connection and the
   * listening server.
   */
  async close() {
    for (const entry of this.active.values()) entry.controller.abort();
    this.active.clear();
    for (const quota of this.quotas.values()) clearTimeout(quota.cleanup);
    this.quotas.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  /**
   * Accept only the fixed model, MCP, and memory routes, then require a live attempt
   * capability before dispatch.
   */
  private async handle(
    req: IncomingMessage,
    requestSignal?: AbortSignal,
  ): Promise<RelayResponse> {
    const externalMcp = /^\/mcp\/(mcp_[A-Za-z0-9]{16})$/.exec(req.url ?? "");
    const mcp =
      (req.url === "/mcp" || !!externalMcp) &&
      ["POST", "GET", "DELETE"].includes(req.method ?? "");
    const memory = req.url === "/memory" && req.method === "POST";
    if (
      !mcp &&
      !memory &&
      (req.method !== "POST" ||
        !["/v1/responses", "/v1/messages"].includes(req.url ?? ""))
    )
      return failure(404);
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : req.url === "/v1/messages" &&
          typeof req.headers["x-api-key"] === "string"
        ? req.headers["x-api-key"]
        : undefined;
    const access = token ? this.active.get(token) : undefined;
    if (
      !access ||
      access.expires <= Date.now() ||
      access.controller.signal.aborted
    )
      return failure(401);
    if (mcp) return this.handleMcp(req, access, token!, externalMcp?.[1]);
    if (memory) return this.handleMemory(req, access, token!);
    const route =
      access.model.provider === "anthropic" ? "/v1/messages" : "/v1/responses";
    if (req.url !== route) return failure(404);
    return this.handleModel(req, access, token!, requestSignal);
  }

  /**
   * Proxy bounded MCP requests to the capability-bound endpoint with its upstream token,
   * forwarding only protocol headers and checking revocation before returning.
   */
  private async handleMcp(
    req: IncomingMessage,
    access: Access,
    token: string,
    serverId?: string,
  ): Promise<RelayResponse> {
    const target = serverId
      ? access.mcpServers?.get(serverId)
      : access.mcpToken && access.mcpEndpoint
        ? {
            token: access.mcpToken,
            endpoint: access.mcpEndpoint,
            queryMs: access.mcpQueryMs ?? 15000,
          }
        : undefined;
    if (!target) return failure(403);
    const signal = AbortSignal.any([
      access.controller.signal,
      AbortSignal.timeout(target.queryMs),
    ]);
    const headers: Record<string, string> = {
      authorization: `Bearer ${target.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    for (const name of [
      "mcp-session-id",
      "mcp-protocol-version",
      "last-event-id",
      "mcp-method",
      "mcp-name",
    ])
      if (typeof req.headers[name] === "string")
        headers[name] = req.headers[name];
    /** Interrupt a pending MCP body read on attempt revocation or its deadline. */
    const cancel = () => {
      req.destroy();
    };
    signal.addEventListener("abort", cancel, { once: true });
    let requestBody: Buffer | undefined;
    try {
      signal.throwIfAborted();
      if (req.method === "POST") requestBody = await boundedBody(req, 65536);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    const upstream = await fetch(target.endpoint, {
      method: req.method,
      redirect: "error",
      signal,
      headers,
      body: requestBody ? new Uint8Array(requestBody) : undefined,
    });
    const responseHeaders: Record<string, string> = {};
    for (const name of [
      "content-type",
      "mcp-session-id",
      "mcp-protocol-version",
    ])
      if (upstream.headers.has(name))
        responseHeaders[name] = upstream.headers.get(name)!;
    if (
      serverId &&
      upstream.body &&
      ![204, 205, 304].includes(upstream.status)
    ) {
      const reader = upstream.body.getReader();
      let size = 0;
      const body = new ReadableStream<Uint8Array>({
        /** Forward bounded protocol data while the attempt and request remain active. */
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) {
              controller.close();
              reader.releaseLock();
              return;
            }
            size += chunk.value.byteLength;
            if (size > 1048576) throw new Error("MCP response too large");
            controller.enqueue(chunk.value);
          } catch {
            await reader.cancel().catch(() => {});
            controller.error(new Error("MCP transport failed"));
          }
        },
        /** Release the upstream connection when the agent stops reading. */
        async cancel() {
          await reader.cancel();
        },
      });
      return { status: upstream.status, body, headers: responseHeaders };
    }
    const body = upstream.body
      ? await boundedBody(upstream.body, 1048576)
      : null;
    if (signal.aborted || !this.active.has(token!)) return failure(401);
    return { status: upstream.status, body, headers: responseHeaders };
  }

  /**
   * Validate bounded memory operations and forward them to the attempt-bound service.
   * Preserve conflict responses, while revocation or cancellation aborts all transport.
   */
  private async handleMemory(
    req: IncomingMessage,
    access: Access,
    token: string,
  ): Promise<RelayResponse> {
    if (!access.memoryToken || !access.memoryEndpoint)
      return { status: 403, body: '{"error":"memory capability is disabled"}' };
    const signal = AbortSignal.any([
      access.controller.signal,
      AbortSignal.timeout(access.memoryQueryMs ?? 15000),
    ]);
    /** Destroy the incoming stream when memory cancellation interrupts body reading. */
    const cancel = () => req.destroy();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      let payload;
      try {
        payload = memoryOperationSchema.safeParse(
          JSON.parse((await boundedBody(req, 1048576)).toString("utf8")),
        );
      } catch {
        return { status: 400, body: '{"error":"invalid memory operation"}' };
      }
      if (!payload.success)
        return { status: 400, body: '{"error":"invalid memory operation"}' };
      signal.throwIfAborted();
      const upstream = await fetch(access.memoryEndpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${access.memoryToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload.data),
      });
      const body = upstream.body
        ? await boundedBody(upstream.body, 1048576)
        : '{"error":"memory service returned no response"}';
      signal.throwIfAborted();
      if (!this.active.has(token)) return failure(401);
      return {
        status: upstream.status,
        body,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  /**
   * Enforce per-attempt request count and single-request concurrency, bound input parsing,
   * and release the busy flag on every outcome.
   */
  private async handleModel(
    req: IncomingMessage,
    access: Access,
    token: string,
    requestSignal?: AbortSignal,
  ): Promise<RelayResponse> {
    if (access.busy || access.requests >= access.model.max_requests) {
      access.diagnostic?.(
        access.busy
          ? "Model relay rejected a concurrent request"
          : `Model request limit reached (${access.model.max_requests})`,
      );
      return failure(429);
    }
    access.requests++;
    access.busy = true;
    const signal = AbortSignal.any([
      access.controller.signal,
      AbortSignal.timeout(Math.max(1, access.expires - Date.now())),
      ...(requestSignal ? [requestSignal] : []),
    ]);
    /**
     * Destroy the incoming model stream when attempt cancellation or request timeout
     * interrupts body reading.
     */
    const cancel = () => req.destroy();
    signal.addEventListener("abort", cancel, { once: true });
    const operation = { signal };
    const inputTimeoutMs = Math.min(access.model.timeout_ms, 60000);
    let phase: Parameters<typeof requestFailure>[4] = "body_read";
    let bodyBytes: number | undefined;
    try {
      operation.signal = AbortSignal.any([
        signal,
        AbortSignal.timeout(inputTimeoutMs),
      ]);
      operation.signal.addEventListener("abort", cancel, { once: true });
      let payload;
      try {
        operation.signal.throwIfAborted();
        const body = await boundedBody(req, access.model.max_request_bytes);
        bodyBytes = body.length;
        phase = "json_parse";
        payload = JSON.parse(body.toString("utf8"));
      } finally {
        operation.signal.removeEventListener("abort", cancel);
      }
      phase = "model_policy";
      const requestBody = this.modelRequest(payload, access.model);
      if (requestBody === undefined) return failure(400);
      phase = "upstream_forward";
      return await this.forwardModel(
        access,
        token,
        signal,
        requestBody,
        operation,
      );
    } catch (error) {
      access.diagnostic?.(
        requestFailure(
          error,
          signal,
          operation.signal,
          phase === "upstream_forward"
            ? access.model.timeout_ms
            : inputTimeoutMs,
          phase,
          bodyBytes,
        ),
      );
      throw error;
    } finally {
      access.busy = false;
      signal.removeEventListener("abort", cancel);
    }
  }
  /**
   * Build an allowlisted native request using trusted provider and model policy; reject
   * streaming and tools that would execute outside the review sandbox.
   */
  private modelRequest(
    payload: {
      input?: unknown;
      messages?: unknown;
      system?: unknown;
      stream?: unknown;
      tools?: {
        type?: string;
        name?: unknown;
        description?: unknown;
        input_schema?: unknown;
      }[];
      tool_choice?: unknown;
      parallel_tool_calls?: unknown;
      max_tokens?: unknown;
      max_output_tokens?: unknown;
    } | null,
    model: Access["model"],
  ) {
    if (model.provider === "anthropic") {
      if (
        !payload ||
        !Array.isArray(payload.messages) ||
        payload.stream === true ||
        (payload.tools !== undefined &&
          (!Array.isArray(payload.tools) ||
            payload.tools.some(
              (tool) =>
                !tool ||
                (tool.type !== undefined && tool.type !== "custom") ||
                typeof tool.name !== "string" ||
                !tool.name ||
                !tool.input_schema ||
                typeof tool.input_schema !== "object" ||
                Array.isArray(tool.input_schema),
            )))
      )
        return undefined;
      const choice = payload.tool_choice as
        { type?: unknown; name?: unknown } | undefined;
      if (
        choice?.type === "tool" &&
        !payload.tools?.some((tool) => tool.name === choice.name)
      )
        return undefined;
      // Preserve native message/tool-result blocks while pinning all connection and cost policy.
      return JSON.stringify({
        model: model.model,
        messages: payload.messages,
        system: payload.system,
        tools: model.supports_tools
          ? payload.tools?.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.input_schema,
            }))
          : undefined,
        tool_choice:
          model.supports_tools && payload.tools?.length
            ? choice?.type === "tool"
              ? { type: "tool", name: choice.name }
              : {
                  type:
                    choice?.type === "none" || choice?.type === "any"
                      ? choice.type
                      : "auto",
                }
            : undefined,
        max_tokens:
          typeof payload.max_tokens === "number" &&
          Number.isInteger(payload.max_tokens) &&
          payload.max_tokens > 0
            ? Math.min(payload.max_tokens, model.max_output_tokens)
            : model.max_output_tokens,
        stream: false,
      });
    }
    if (
      !payload ||
      !Array.isArray(payload.input) ||
      payload.stream === true ||
      (payload.tools !== undefined &&
        (!Array.isArray(payload.tools) ||
          payload.tools.some(
            (tool: { type?: string } | null) => tool?.type !== "function",
          )))
    )
      return undefined;
    let toolChoice:
      | "none"
      | "auto"
      | "required"
      | { type: "function"; name: unknown }
      | undefined;
    if (model.supports_tools && payload.tools?.length) {
      const choice = payload.tool_choice as
        { type?: unknown; name?: unknown } | undefined;
      if (choice?.type === "function") {
        if (!payload.tools.some((tool) => tool.name === choice.name))
          return undefined;
        toolChoice = { type: "function", name: choice.name };
      } else {
        toolChoice =
          payload.tool_choice === "none" || payload.tool_choice === "required"
            ? payload.tool_choice
            : "auto";
      }
    }
    // Explicit allowlist: no caller-supplied upstream, headers, token budget or model.
    return JSON.stringify({
      model: model.model,
      input: payload.input,
      tools: model.supports_tools ? payload.tools : undefined,
      tool_choice: toolChoice,
      parallel_tool_calls: model.supports_tools
        ? payload.parallel_tool_calls !== false
        : undefined,
      reasoning: { effort: model.reasoning_effort },
      text: { format: { type: "json_object" } },
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: false,
      max_output_tokens:
        typeof payload.max_output_tokens === "number" &&
        Number.isInteger(payload.max_output_tokens) &&
        payload.max_output_tokens > 0
          ? Math.min(payload.max_output_tokens, model.max_output_tokens)
          : model.max_output_tokens,
    });
  }

  /**
   * Pace model requests without automatically repeating any provider dispatch.
   * Failed HTTP responses and timeouts may be billed; a new review attempt must own any retry.
   * Bound returned bodies, and refuse results after capability revocation.
   */
  private async forwardModel(
    access: Access,
    token: string,
    signal: AbortSignal,
    requestBody: string,
    operation: { signal: AbortSignal },
  ): Promise<RelayResponse> {
    const quota = access.quota;
    // A conservative heuristic, not billed usage or Azure's exact token estimate.
    const estimatedTokens =
      Math.ceil(Buffer.byteLength(requestBody) / 3) +
      access.model.max_output_tokens;
    operation.signal = signal;
    const reservation = await this.waitForQuota(
      access,
      signal,
      estimatedTokens,
    );
    try {
      operation.signal = AbortSignal.any([
        signal,
        AbortSignal.timeout(access.model.timeout_ms),
      ]);
      const upstream = await fetch(access.endpoint, {
        method: "POST",
        redirect: "error",
        dispatcher: modelDispatcher,
        signal: operation.signal,
        headers: {
          ...(access.model.provider === "anthropic"
            ? {
                "x-api-key": access.apiKey,
                "anthropic-version": "2023-06-01",
              }
            : { authorization: `Bearer ${access.apiKey}` }),
          "content-type": "application/json",
        },
        body: requestBody,
      } as RequestInit & Pick<UndiciRequestInit, "dispatcher">);
      operation.signal.throwIfAborted();
      const now = Date.now();
      const retryMs = retryableResponse(upstream)
        ? Math.max(250, retryDelay(upstream.headers, now) ?? 1000)
        : undefined;
      this.observeLimits(
        quota,
        access.model.provider === "anthropic"
          ? anthropicQuotaHeaders(upstream.headers, now)
          : upstream.headers,
        now,
        reservation,
        retryMs,
      );
      if (retryMs !== undefined) {
        quota.blockedUntil = Math.max(quota.blockedUntil, now + retryMs);
        await upstream.body?.cancel().catch(() => {});
        signal.throwIfAborted();
        access.diagnostic?.(
          `Model upstream returned HTTP ${upstream.status} · automatic retries disabled`,
        );
        return {
          ...failure(upstream.status === 429 ? 429 : 502),
          headers: {
            "x-should-retry": "false",
            "retry-after": String(Math.ceil(retryMs / 1000)),
          },
        };
      }
      if (!upstream.ok || !upstream.body) {
        access.diagnostic?.(
          `Model upstream returned HTTP ${upstream.status}${!upstream.body ? " with no response body" : ""} · outgoing JSON ${Buffer.byteLength(requestBody)} bytes`,
        );
        await upstream.body?.cancel().catch(() => {});
        signal.throwIfAborted();
        return failure(upstream.status === 429 ? 429 : 502);
      }
      const body = await boundedBody(
        upstream.body,
        access.model.max_response_bytes,
      );
      operation.signal.throwIfAborted();
      if (!this.active.has(token!)) return failure(401);
      return {
        status: 200,
        body,
        headers:
          upstream.headers.get("x-razbor-usage-incomplete") === "true"
            ? { "x-razbor-usage-incomplete": "true" }
            : undefined,
      };
    } catch (error) {
      // Attempt cancellation, revocation, payload limits and arbitrary transport errors
      // are not a provider timeout and must not be retried as one.
      if (
        signal.aborted ||
        !operation.signal.aborted ||
        !(error instanceof Error) ||
        !["AbortError", "TimeoutError"].includes(error.name)
      )
        throw error;
      const reason = `Model upstream request timed out after ${access.model.timeout_ms}ms`;
      access.diagnostic?.(
        `${reason} · no automatic retry because token usage is unknown`,
      );
      return failure(502);
    } finally {
      quota.inFlightRequests--;
      this.retireQuota(quota);
    }
  }
}
