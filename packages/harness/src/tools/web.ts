import dns from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

import { z } from "zod";

import { textPrefix } from "@harness/src/tools/text.js";

export const webSearchArguments = z
  .object({
    query: z.string().trim().min(1).max(2000),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const fetchUrlArguments = z
  .object({
    url: z.string().min(1).max(8192).url(),
    timeoutMs: z.number().int().min(1).max(30000).optional(),
    maxOutputBytes: z.number().int().min(1).max(100000).optional(),
  })
  .strict();

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  search(
    query: string,
    options: { limit: number; signal: AbortSignal },
  ): Promise<WebSearchResult[]>;
}

/**
 * Races an operation against timeout and parent cancellation, supplying the combined
 * signal and always removing its timer and abort listener.
 */
async function withDeadline<T>(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent
    ? AbortSignal.any([parent, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(
    () => controller.abort(new Error("Tool timed out")),
    timeoutMs,
  );
  /**
   * Holds the active race rejection listener so it can be removed when the operation
   * settles.
   */
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(
            new Error(parent?.aborted ? "Tool cancelled" : "Tool timed out"),
          );
        signal.addEventListener("abort", onAbort, { once: true });
      }),
      operation(signal),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs the configured search provider within a deadline, validates public URL syntax,
 * and bounds result count and text without exposing provider failures.
 */
export async function searchWeb(
  input: unknown,
  provider?: WebSearchProvider,
  signal?: AbortSignal,
) {
  const { query, limit = 5 } = webSearchArguments.parse(input);
  if (!provider)
    throw new Error("Web search is not configured; inject a WebSearchProvider");
  const started = performance.now();
  const results = await withDeadline(15000, signal, async (active) => {
    let found: WebSearchResult[];
    try {
      found = await provider.search(query, { limit, signal: active });
    } catch {
      throw new Error(
        active.aborted
          ? "Web search timed out or was cancelled"
          : "Web search provider failed",
      );
    }
    if (!Array.isArray(found))
      throw new Error("Web search provider returned invalid results");
    return found.slice(0, limit).map((entry) => {
      if (
        !entry ||
        typeof entry.title !== "string" ||
        typeof entry.url !== "string" ||
        typeof entry.snippet !== "string" ||
        entry.url.length > 2048
      )
        throw new Error("Web search provider returned invalid results");
      const url = publicUrl(entry.url);
      return {
        title: textPrefix(entry.title, 300),
        url: url.href,
        snippet: textPrefix(entry.snippet, 2000),
      };
    });
  });
  return {
    ok: true,
    results,
    durationMs: Math.round(performance.now() - started),
  };
}

// Conservative public-only ranges; special-use and transition networks are denied.
// https://www.iana.org/assignments/iana-ipv4-special-registry
// https://www.iana.org/assignments/iana-ipv6-special-registry
const blocked = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");

blocked.addAddress("168.63.129.16", "ipv4"); // Azure platform virtual address.

for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");

const globalV6 = new BlockList();

globalV6.addSubnet("2000::", 3, "ipv6");

/**
 * Accepts Internet-routable IP candidates under the conservative special-use blocklists
 * and IPv6 global-unicast range.
 */
function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}

/**
 * Normalizes an HTTP(S) URL, rejects credentials and nonpublic host syntax or literal
 * addresses, and strips its fragment. DNS checks occur when requesting it.
 */
function publicUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP/HTTPS URLs are supported");
  if (url.username || url.password)
    throw new Error("URL credentials are not allowed");
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    isIP(host)
      ? !publicAddress(host)
      : !host.includes(".") ||
        /\.(localhost|local|internal|lan|invalid|test|onion)$/.test(host) ||
        host.endsWith(".home.arpa")
  )
    throw new Error("URL must target a public Internet address");
  url.hash = "";
  return url;
}

/**
 * Requires every DNS answer to be public, then pins one address for the request while
 * preserving the original Host and TLS identity.
 */
async function requestPage(
  url: URL,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Public URL DNS lookup failed");
  }
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw new Error("URL DNS must resolve only to public Internet addresses");
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        agent: false,
        signal,
        maxHeaderSize: 16384,
        // Preserve the original Host and TLS verification/SNI, but never resolve twice.
        family: pinned.family,
        /**
         * Supplies the already-validated address to the HTTP client so connection setup
         * cannot perform a second DNS resolution.
         */
        lookup: (_hostname, _options, callback) =>
          callback(null, pinned.address, pinned.family),
        headers: {
          Accept:
            "text/html, text/plain, application/json, application/xml;q=0.9",
          "Accept-Encoding": "identity",
        },
      },
      resolve,
    );
    request.once("error", () =>
      reject(
        new Error(
          signal.aborted
            ? "URL request timed out or was cancelled"
            : "Public URL request failed",
        ),
      ),
    );
    request.end();
  });
}

/**
 * Reduces HTML to readable text by removing non-content elements and tags and decoding
 * supported entities; leaves other text formats unchanged.
 */
function extractText(body: string, contentType: string) {
  if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType))
    return body;
  return body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(
      /<(script|style|noscript|template)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      "",
    )
    .replace(/<[^<>]*>/g, " ")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (entity, code: string) => {
        const named: Record<string, string> = {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
        };
        if (!code.startsWith("#")) return named[code.toLowerCase()] ?? entity;
        const point =
          code[1].toLowerCase() === "x"
            ? Number.parseInt(code.slice(2), 16)
            : Number.parseInt(code.slice(1), 10);
        return point > 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : "";
      },
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validates an uncompressed supported text response and returns its media type and
 * supported charset.
 */
function responseTextFormat(response: IncomingMessage) {
  const contentType = response.headers["content-type"] ?? "";
  if (
    !/^(text\/(plain|html|markdown|x-markdown|csv|xml)|application\/(json|xml|xhtml\+xml|[\w.-]+\+json))\s*(;|$)/i.test(
      contentType,
    )
  )
    throw new Error("URL response is not a supported text content type");
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding.toLowerCase() !== "identity")
    throw new Error("Compressed URL responses are not supported");
  const charset =
    /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
  if (!/^(utf-8|utf8|us-ascii|ascii|iso-8859-1|windows-1252)$/i.test(charset))
    throw new Error("Unsupported URL text encoding");
  return { contentType, charset };
}

/**
 * Decodes response bytes strictly and rejects binary control characters, permitting an
 * incomplete trailing sequence only for truncated input.
 */
function decodeText(chunks: Buffer[], charset: string, truncated: boolean) {
  let decoded: string;
  try {
    decoded = new TextDecoder(charset, { fatal: true }).decode(
      Buffer.concat(chunks),
      { stream: truncated },
    );
  } catch {
    throw new Error("URL response is not valid text");
  }
  for (const character of decoded) {
    if (character.codePointAt(0)! < 32 && !"\t\n\r".includes(character))
      throw new Error("URL response contains binary content");
  }
  return decoded;
}

/**
 * Collects at most one megabyte of validated text response bytes and reports truncation
 * before decoding.
 */
async function readTextResponse(response: IncomingMessage) {
  const { contentType, charset } = responseTextFormat(response);
  const chunks: Buffer[] = [];
  const responseLimit = 1000000;
  let bytes = 0,
    truncated = false;
  for await (const chunk of response) {
    const buffer = Buffer.from(chunk);
    const length = Math.min(buffer.length, responseLimit - bytes);
    chunks.push(Buffer.from(buffer.subarray(0, length)));
    bytes += length;
    if (length < buffer.length) {
      truncated = true;
      break;
    }
  }
  return {
    contentType,
    decoded: decodeText(chunks, charset, truncated),
    truncated,
  };
}

/**
 * Fetches bounded public text under one deadline, revalidating each redirect and DNS
 * resolution. Always destroys each response and reports HTTP success separately from
 * transport failures.
 */
export async function fetchUrl(input: unknown, signal?: AbortSignal) {
  const {
    url,
    timeoutMs = 15000,
    maxOutputBytes = 32768,
  } = fetchUrlArguments.parse(input);
  const started = performance.now();
  return withDeadline(timeoutMs, signal, async (active) => {
    let current = publicUrl(url);
    for (let redirects = 0; ; redirects++) {
      const response = await requestPage(current, active);
      try {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (redirects >= 5) throw new Error("URL redirect limit exceeded");
          if (!response.headers.location)
            throw new Error("URL redirect has no location");
          const next = new URL(response.headers.location, current);
          if (next.href.length > 8192)
            throw new Error("URL redirect is too long");
          current = publicUrl(next.href);
          continue;
        }
        const { contentType, decoded, truncated } =
          await readTextResponse(response);
        const extracted = extractText(decoded, contentType);
        const body = textPrefix(extracted, maxOutputBytes);
        return {
          ok: status >= 200 && status < 300,
          url: current.href,
          status,
          contentType,
          body,
          truncated: truncated || body !== extracted,
          redirects,
          durationMs: Math.round(performance.now() - started),
        };
      } finally {
        response.destroy();
      }
    }
  });
}
