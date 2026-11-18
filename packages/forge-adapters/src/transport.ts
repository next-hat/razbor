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

/** Recognize GitHub's explicit HTTP rejection and bound reads of diagnostic response bodies. */
async function githubRateLimitRetry(response: Response) {
  if (response.status === 403) {
    let payload;
    try {
      payload = z
        .object({
          message: z.string().optional(),
          errors: z
            .array(
              z.object({
                type: z.string().optional(),
                message: z.string().optional(),
              }),
            )
            .optional(),
          data: z.null().optional(),
        })
        .safeParse(JSON.parse(await responseText(response, 16384, false)));
    } catch {
      return;
    }
    if (!payload.success) return;
    const messages = [payload.data, ...(payload.data.errors ?? [])];
    if (
      !messages.some(({ message }) =>
        /(?:exceeded (?:a |the )?(?:secondary |primary |api )?rate limit|api rate limit exceeded)/i.test(
          message ?? "",
        ),
      ) &&
      !payload.data.errors?.some((error) => error.type === "RATE_LIMITED")
    )
      return;
  } else {
    await response.body?.cancel();
  }
  const now = Date.now();
  const after = response.headers.get("retry-after");
  const reset =
    response.headers.get("x-ratelimit-remaining") === "0"
      ? response.headers.get("x-ratelimit-reset")
      : null;
  const times = [
    after && /^\d+$/.test(after) ? now + Number(after) * 1000 : NaN,
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
    if (remaining <= 0) throw new ForgeOperationError("unavailable");
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
        if (
          mutating &&
          this.connection.type === "github" &&
          (response.status === 403 || response.status === 429)
        ) {
          const retryAt = await githubRateLimitRetry(response);
          if (retryAt !== undefined)
            throw new ForgeOperationError(
              "unavailable",
              false,
              response.status,
              retryAt,
            );
        } else await response.body?.cancel();
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
      return text ? raw : raw ? parse(raw) : null;
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
