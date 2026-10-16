import { AuthError } from "@web/lib/auth.js";

/**
 * Checks the JSON content type and matching request origin; this is a browser request
 * guard, not an authentication check.
 */
export function managementRequest(request: Request) {
  const host = request.headers.get("host");
  return (
    request.headers.get("content-type") === "application/json" &&
    [`http://${host}`, `https://${host}`].includes(
      request.headers.get("origin") ?? "",
    )
  );
}

/**
 * Reads and parses a bounded JSON body, cancelling the reader when the byte limit is
 * exceeded.
 */
export async function managementJson(
  request: Request,
  limit = 4096,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "JSON body required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel();
      throw new AuthError(413, "Request too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
