import { parse, isLosslessNumber } from "lossless-json";
import { z } from "zod";

import type { ForgeConnection } from "@forge-adapters/src/types.js";

export class ForgeReadError extends Error {
  /**
   * Expose a safe repository-read failure category without provider response
   * bodies or credentials.
   */
  constructor(
    readonly reason:
      "unauthorized" | "unavailable" | "not-found" | "invalid-response",
  ) {
    super(`forge repository read: ${reason}`);
  }
}

export const providerId = z.preprocess(
  (value) => (isLosslessNumber(value) ? value.toString() : value),
  z.string().min(1).max(256),
);

/**
 * Require a credential-free configured HTTP(S) URL without query or fragment;
 * plaintext HTTP must be explicitly enabled.
 */
export function approvedUrl(value: string, allowHttp: boolean) {
  const url = new URL(value);
  if (
    (!allowHttp && url.protocol !== "https:") ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("invalid configured forge URL");
  return url;
}

/**
 * Encode an owner/repository selector as two path segments, rejecting empty or
 * traversal segments.
 */
export function repositoryPath(selector: string) {
  const parts = selector.split("/");
  if (parts.length !== 2 || parts.some((v) => !v || v === "." || v === ".."))
    throw new Error("expected owner/repository selector");
  return parts.map(encodeURIComponent).join("/");
}

/**
 * Map provider response status to a safe authorization, absence or
 * availability category.
 */
function responseErrorReason(status: number) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  return "unavailable";
}

/** Read a provider response as UTF-8 with a one-megabyte size limit. */
async function readResponseBody(response: Response) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body)
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1048576) throw new ForgeReadError("invalid-response");
      chunks.push(chunk);
    }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read bounded lossless JSON under the approved API prefix with redirects
 * disabled and a deadline; normalize transport failures to safe errors.
 */
export async function readJson(
  c: ForgeConnection,
  route: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const base = approvedUrl(c.apiUrl, c.allowHttp);
  const url = new URL(`${base.href.replace(/\/$/, "")}/${route}`);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)
  )
    throw new Error("invalid provider route");
  try {
    const response = await fetch(url, {
      redirect: "error",
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.any([
        AbortSignal.timeout(Math.min(c.timeoutMs ?? 10000, 30000)),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ForgeReadError(responseErrorReason(response.status));
    }
    return parse(await readResponseBody(response));
  } catch (error) {
    if (error instanceof ForgeReadError) throw error;
    throw new ForgeReadError("unavailable");
  }
}
