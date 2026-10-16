import { parse } from "lossless-json";
import { z } from "zod";

import { approvedUrl } from "@forge-adapters/src/http.js";
import { ForgeOperationError } from "@forge-adapters/src/interactions.js";
import type { ForgeConnection } from "@forge-adapters/src/types.js";

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
        await response.body?.cancel();
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
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 4 * 1048576)
            throw new ForgeOperationError("invalid-response", mutating);
          chunks.push(chunk);
        }
      const raw = Buffer.concat(chunks).toString("utf8");
      return text ? raw : raw ? parse(raw) : null;
    } catch (error) {
      if (error instanceof ForgeOperationError) throw error;
      throw new ForgeOperationError("unavailable", mutating);
    }
  }

  /** Read every page up to a fixed bound, failing rather than returning incomplete evidence. */
  async list(route: string, pageSizeKey = "per_page"): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const rows = z
        .array(z.unknown())
        .parse(
          await this.request(
            `${route}${route.includes("?") ? "&" : "?"}${pageSizeKey}=50&page=${page}`,
          ),
        );
      all.push(...rows);
      if (rows.length < 50) return all;
    }
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
