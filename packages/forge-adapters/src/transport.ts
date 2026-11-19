import { parse } from "lossless-json";
import { z } from "zod";

import { approvedUrl } from "@forge-adapters/src/http.js";
import { ForgeOperationError } from "@forge-adapters/src/interactions.js";
import type { ForgeConnection } from "@forge-adapters/src/types.js";

/** Read at most the given number of response bytes, retaining the ambiguity of a mutation. */
async function responseText(
  response: Response,
  limit: number,
  mutating: boolean,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body)
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit)
        throw new ForgeOperationError("invalid-response", mutating);
      chunks.push(chunk);
    }
  return Buffer.concat(chunks).toString("utf8");
}

const rateLimitMessage =
  /(?:exceeded (?:a |the )?(?:secondary |primary |api )?rate limit|api rate limit exceeded)/i;

const githubRateLimit = z.object({
  message: z.string().optional(),
  data: z.null().optional(),
  errors: z
    .array(
      z.object({
        type: z.string().optional(),
        message: z.string().optional(),
        // A field-level error can follow execution of the mutation.
        path: z.array(z.unknown()).max(0).nullish(),
      }),
    )
    .nonempty()
    .optional(),
});

/** Accept an explicit request-wide rate rejection, never a partial GraphQL result or mixed errors. */
function githubRateLimited(value: unknown, allowTopLevelMessage: boolean) {
  const payload = githubRateLimit.safeParse(value);
  if (!payload.success) return false;
  const { message, errors } = payload.data;
  if (errors)
    return errors.every(
      (e) =>
        e.type === "RATE_LIMITED" ||
        (!e.type && rateLimitMessage.test(e.message ?? "")),
    );
  return allowTopLevelMessage && rateLimitMessage.test(message ?? "");
}

/** Parse only bounded diagnostic bodies on GitHub's shared permission/rate-limit status. */
async function githubRateLimitedResponse(response: Response) {
  try {
    return githubRateLimited(
      JSON.parse(await responseText(response, 16384, false)),
      true,
    );
  } catch {
    return false;
  }
}

/** Honor valid provider delay and reset headers or wait a minute before retrying. */
function rateLimitRetry(response: Response) {
  const now = Date.now();
  const after = response.headers.get("retry-after");
  const reset =
    response.headers.get("x-ratelimit-remaining") === "0"
      ? response.headers.get("x-ratelimit-reset")
      : null;
  const times = [
    after && /^\d+$/.test(after)
      ? now + Number(after) * 1000
      : after
        ? Date.parse(after)
        : NaN,
    reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN,
  ].filter(
    (time) => time >= now && Number.isSafeInteger(time) && time <= 8.64e15,
  );
  return times.length ? Math.max(...times) : now + 60000;
}

/** Bounded, lossless provider transport with no redirects or automatic write retries. */
export class HttpForgeTransport {
  private readonly deadline: number;

  /** Bind credentials and one total request budget to a trusted API prefix. */
  constructor(
    private readonly connection: ForgeConnection,
    private readonly headers: Record<string, string>,
    budgetMs = 20000,
  ) {
    this.deadline = Date.now() + budgetMs;
  }

  /** Send one bounded request; classify unreadable mutation outcomes as uncertain. */
  async request(
    route: string,
    method = "GET",
    body?: unknown,
    text = false,
    headers: Record<string, string> = {},
    mutating = method !== "GET",
  ): Promise<unknown> {
    const base = approvedUrl(this.connection.apiUrl, this.connection.allowHttp);
    const url = new URL(`${base.href.replace(/\/$/, "")}/${route}`);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)
    )
      throw new ForgeOperationError("invalid-response");
    const remaining = this.deadline - Date.now();
    if (remaining <= 0)
      throw new ForgeOperationError(mutating ? "not-sent" : "unavailable");
    try {
      const response = await fetch(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.min(this.connection.timeoutMs ?? 10000, remaining),
        ),
        headers: {
          Accept: text ? "text/plain" : "application/json",
          "Content-Type": "application/json",
          ...this.headers,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const rateLimited =
          (response.status === 429 &&
            ["github", "gitlab"].includes(this.connection.type)) ||
          (response.status === 403 &&
            this.connection.type === "github" &&
            (await githubRateLimitedResponse(response)));
        // Cleanup cannot change the refusal or delay reporting its retry deadline.
        if (!response.bodyUsed) void response.body?.cancel().catch(() => {});
        if (rateLimited)
          throw new ForgeOperationError(
            "unavailable",
            false,
            response.status,
            rateLimitRetry(response),
          );
        const reason =
          response.status === 401 || response.status === 403
            ? "permission"
            : response.status === 404 || response.status === 405
              ? "unsupported"
              : "unavailable";
        throw new ForgeOperationError(
          reason,
          mutating && response.status >= 500,
          response.status,
        );
      }
      const raw = await responseText(response, 4 * 1048576, mutating);
      const value = text ? raw : raw ? parse(raw) : null;
      if (
        this.connection.type === "github" &&
        route === "graphql" &&
        githubRateLimited(
          value,
          response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after"),
        )
      )
        throw new ForgeOperationError(
          "unavailable",
          false,
          response.status,
          rateLimitRetry(response),
        );
      return value;
    } catch (error) {
      if (error instanceof ForgeOperationError) throw error;
      throw new ForgeOperationError("unavailable", mutating);
    }
  }

  /** Read up to twenty data pages. A complete listing must also reach an empty page. */
  async list(
    route: string,
    pageSizeKey = "per_page",
    requireEmptyPage = false,
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    const dataPageLimit = 20;
    const pageSize = 50;
    const pageRoute = `${route}${route.includes("?") ? "&" : "?"}${pageSizeKey}=${pageSize}&page=`;
    for (let page = 1; page <= dataPageLimit; page++) {
      const rows = z
        .array(z.unknown())
        .parse(await this.request(`${pageRoute}${page}`));
      if (rows.length > pageSize)
        throw new ForgeOperationError("invalid-response");
      all.push(...rows);
      if (rows.length === 0 || (!requireEmptyPage && rows.length < pageSize))
        return all;
    }
    const finalPage = await this.request(`${pageRoute}${dataPageLimit + 1}`);
    if (Array.isArray(finalPage) && finalPage.length === 0) return all;
    throw new ForgeOperationError("invalid-response");
  }
}

/** Extract the immutable razbor endpoint while validating its callback URL. */
export function webhookEndpoint(value: string) {
  try {
    return /\/webhooks\/hook_[A-Za-z0-9]{16}$/.exec(
      approvedUrl(value, false).pathname,
    )?.[0];
  } catch {
    return undefined;
  }
}
