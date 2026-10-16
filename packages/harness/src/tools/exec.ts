import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { textPrefix } from "@harness/src/tools/text.js";

const argument = z
  .string()
  .max(16384)
  .refine((value) => !value.includes("\0"));

export const execArguments = z
  .object({
    argv: z
      .array(argument)
      .min(1)
      .max(256)
      .refine((argv) => !!argv[0]),
    cwd: argument.optional(),
    timeoutMs: z.number().int().min(1).max(300000).optional(),
    maxOutputBytes: z.number().int().min(1).max(1000000).optional(),
  })
  .strict();

const execOptionsSchema = z
  .object({
    // Only the trusted caller supplies env; nothing is inherited implicitly.
    env: z.record(z.string(), z.string().optional()).default({}),
    timeoutMs: z.number().int().min(1).max(300000).default(120000),
    maxOutputBytes: z.number().int().min(1).max(1000000).default(32768),
  })
  .strict();

export type ExecOptions = z.input<typeof execOptionsSchema>;

/**
 * Runs argv without a shell from a repository-confined directory using only
 * caller-approved environment variables. Caps time and combined output, kills child
 * processes on completion or cancellation, and reports exit metadata.
 */
export async function executeCommand(
  repository: string,
  input: unknown,
  options: ExecOptions = {},
  signal?: AbortSignal,
) {
  const args = execArguments.parse(input);
  const policy = execOptionsSchema.parse(options);
  signal?.throwIfAborted();
  const root = await realpath(repository);
  const cwd = await realpath(path.resolve(root, args.cwd ?? "."));
  const relative = path.relative(root, cwd);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("cwd must stay inside the review repository");
  if (!(await stat(cwd)).isDirectory())
    throw new Error("cwd must be a directory");
  signal?.throwIfAborted();
  const timeoutMs = Math.min(
    args.timeoutMs ?? policy.timeoutMs,
    policy.timeoutMs,
  );
  const maxOutputBytes = Math.min(
    args.maxOutputBytes ?? policy.maxOutputBytes,
    policy.maxOutputBytes,
  );
  const started = performance.now();
  return new Promise<{
    ok: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    truncated: boolean;
    durationMs: number;
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }>((resolve, reject) => {
    const child = spawn(args.argv[0], args.argv.slice(1), {
      cwd,
      env: { ...policy.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let captured = 0,
      truncated = false,
      timedOut = false,
      cancelled = false;
    /**
     * Copies output within the shared stdout/stderr byte budget and records whether any
     * incoming bytes were discarded.
     */
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      const length = Math.min(chunk.length, maxOutputBytes - captured);
      if (length) chunks.push(Buffer.from(chunk.subarray(0, length)));
      captured += length;
      truncated ||= length < chunk.length;
    };
    /**
     * Kills the detached process group where supported, tolerating already-exited
     * children and falling back to the direct child when needed.
     */
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          child.kill("SIGKILL");
      }
    };
    /**
     * Marks the result as cancelled and terminates the command and its process group.
     */
    const cancel = () => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    /**
     * Releases the command deadline timer and abort listener when spawning fails or the
     * process closes.
     */
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        new Error(`Command could not start (${error.code ?? "spawn failed"})`),
      );
    });
    child.once("close", (exitCode, exitSignal) => {
      cleanup();
      // Also remove background children that inherited neither output pipe.
      kill();
      const out = new TextDecoder().decode(Buffer.concat(stdout), {
        stream: truncated,
      });
      const err = new TextDecoder().decode(Buffer.concat(stderr), {
        stream: truncated,
      });
      const boundedOut = textPrefix(out, maxOutputBytes);
      const boundedErr = textPrefix(
        err,
        maxOutputBytes - Buffer.byteLength(boundedOut),
      );
      resolve({
        ok: exitCode === 0 && !timedOut && !cancelled,
        exitCode,
        signal: exitSignal,
        stdout: boundedOut,
        stderr: boundedErr,
        timedOut,
        cancelled,
        truncated: truncated || boundedOut !== out || boundedErr !== err,
        durationMs: Math.round(performance.now() - started),
        cwd,
        timeoutMs,
        maxOutputBytes,
      });
    });
  });
}
