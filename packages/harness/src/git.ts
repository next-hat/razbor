import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);

export const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

export class GitOutputLimitError extends Error {
  readonly code = "GIT_OUTPUT_LIMIT_EXCEEDED";

  /** Report only the trusted output limit, never Git arguments, stderr or partial source. */
  constructor(readonly maxBytes: number) {
    super(`Git output limit exceeded (${maxBytes} bytes)`);
    this.name = "GitOutputLimitError";
  }
}

// Do not inherit GIT_CONFIG_*, SSH helpers, preload settings or user Git configuration.

export const gitEnvironment = {
  PATH: process.env.PATH,
  NODE_ENV: "development" as const,
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_LITERAL_PATHSPECS: "1",
};

export const safeGitOptions = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "protocol.allow=never",
  "-c",
  "safe.directory=*",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=true",
];

/**
 * Runs Git with hooks, external protocols, and user configuration disabled. Enforces a
 * timeout and output cap, rejects invalid UTF-8, and optionally preserves whitespace.
 * Large patch ingestion may opt into a larger buffer up to the fixed 32 MiB ceiling.
 */
export async function git(
  repository: string,
  args: string[],
  signal?: AbortSignal,
  trim = true,
  maxOutputBytes = 1_000_000,
) {
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_GIT_OUTPUT_BYTES
  )
    throw new RangeError("Invalid Git output limit");
  const result = await exec(
    "git",
    [...safeGitOptions, "-C", repository, ...args],
    {
      env: gitEnvironment,
      timeout: 30000,
      maxBuffer: maxOutputBytes,
      signal,
      encoding: "buffer",
    },
  ).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      throw new GitOutputLimitError(maxOutputBytes);
    throw error;
  });
  const stdout = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(result.stdout);
  return trim ? stdout.trim() : stdout;
}
