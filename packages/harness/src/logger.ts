import pino, { type Logger } from "pino";
// Keep the dynamically selected transport and its dependencies in Next's standalone trace.
import "pino-pretty";

/** Remove terminal escapes and non-printing controls while preserving log line breaks. */
function normalizeDiagnosticText(text: string) {
  return text
    .replace(/\p{Cc}\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\p{Cc}/gu, (character) =>
      "\r\n\t".includes(character) ? character : "",
    );
}

/** Redact credentials and control characters before bounding container diagnostics. */
function diagnosticText(
  value: unknown,
  secrets: readonly string[],
  limit: number,
) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return undefined;
  let text = normalizeDiagnosticText(
    typeof value === "string" ? value : value.toString("utf8"),
  );
  for (const secret of secrets) {
    if (!secret) continue;
    for (const normalized of [secret, normalizeDiagnosticText(secret)]) {
      if (!normalized) continue;
      for (const encoded of [
        normalized,
        encodeURIComponent(Buffer.from(normalized, "utf8").toString("utf8")),
      ])
        text = text.replaceAll(encoded, "[REDACTED]");
    }
  }
  text = text
    .replace(/((?:https?|ssh):\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/((?:https?|ssh):\/\/[^\s?"'<>]+)\?[^\s"'<>]*/gi, "$1?[REDACTED]")
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|token|password|secret)\b["']?\s*[:=]\s*)[^\r\n]*/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[a-zA-Z0-9_]+|github_pat_[a-zA-Z0-9_]+|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g,
      "[REDACTED]",
    );
  return text.length > limit ? `${text.slice(0, limit)} [truncated]` : text;
}

/** Select bounded error fields and nested causes without serializing arbitrary payloads. */
function diagnosticError(
  error: unknown,
  secrets: readonly string[],
  depth: number,
): Record<string, unknown> {
  if (!error || typeof error !== "object")
    return { message: diagnosticText(error, secrets, 2048) };
  const value = error as Record<string, unknown>;
  return {
    name: diagnosticText(value.name, secrets, 128),
    message: diagnosticText(value.message, secrets, 2048),
    code:
      typeof value.code === "number"
        ? value.code
        : diagnosticText(value.code, secrets, 128),
    signal: diagnosticText(value.signal, secrets, 128),
    killed: typeof value.killed === "boolean" ? value.killed : undefined,
    stderr: diagnosticText(value.stderr, secrets, 8192),
    cause:
      depth < 2 && value.cause && value.cause !== error
        ? diagnosticError(value.cause, secrets, depth + 1)
        : undefined,
  };
}

/**
 * Preserve useful container-only failures while removing supplied credentials, common
 * authentication fields, URL credentials, and unbounded response/command payloads.
 */
export function errorDetails(error: unknown, secrets: readonly string[] = []) {
  try {
    return diagnosticError(error, secrets, 0);
  } catch {
    // Diagnostics must never replace the failure when an error has unsafe getters.
    return { message: "Error diagnostics unavailable" };
  }
}

// Next.js evaluates server modules again during development. Reuse the transport
// rather than creating another worker and stdout/stderr pipe on each reload.
const globalLogger = globalThis as typeof globalThis & {
  razborLogger?: Logger;
};

export const logger: Logger = (globalLogger.razborLogger ??= pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    runnerId: process.env.RAZBOR_RUNNER_ID,
    attemptId: process.env.RAZBOR_ATTEMPT_ID,
  },
  transport: {
    target: "pino-pretty",
    options: {
      colorize: process.stdout.isTTY,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
      singleLine: true,
    },
  },
}));
