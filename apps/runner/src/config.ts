import path from "node:path";
import { readFile } from "node:fs/promises";

import { z } from "zod";
import { parse } from "smol-toml";

import {
  capabilityLimitsSchema,
  modelProviderSchema,
  reasoningEffortSchema,
  runnerCreateSchema,
  reviewMaxTurnsSchema,
  reviewBudgetSchema,
} from "@razbor/contracts";

import { PermanentError } from "@runner/src/errors.js";

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

const absolute = z
  .string()
  .refine(
    (v) => path.isAbsolute(v) && path.normalize(v) === v && v !== "/",
    "expected a normalized absolute non-root path",
  );

const reference = z.union([
  z.string().min(1),
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict(),
  z.object({ file: absolute }).strict(),
]);

export const runnerConfigSchema = z
  .object({
    control: z
      .object({
        url: z
          .string()
          .url()
          .refine((value) => {
            try {
              const url = new URL(value);
              return (
                ["https:", "http:"].includes(url.protocol) &&
                !url.username &&
                !url.password &&
                !url.search &&
                !url.hash &&
                url.pathname === "/"
              );
            } catch {
              return false;
            }
          }, "expected an HTTP(S) origin"),
        allow_http: z.boolean().default(false),
        enrollment_token: reference.optional(),
      })
      .strict()
      .optional(),
    registration: z
      .object({
        key: name,
        name: runnerCreateSchema.shape.name,
        repositories: z
          .array(z.string().trim().min(1).max(100))
          .max(1000)
          .default([]),
      })
      .strict()
      .optional(),
    runner: z
      .object({
        name: name.default("enrolled"),
        concurrency: z.number().int().min(1).max(32).default(1),
        timeout_ms: z.number().int().min(1000).max(3600000).default(3600000),
        shutdown_grace_ms: z.number().int().min(0).max(300000).default(15000),
      })
      .strict()
      .prefault({}),
    docker: z
      .object({
        socket: absolute.default("/var/run/docker.sock"),
        runtime: name.default("runc"),
        image: z.string().min(1).default("node:24-bookworm"),
        network: reference.default("razbor-jobs"),
        container_id_env: z.string().optional(),
        relay_host: z.union([z.ipv4(), z.ipv6()]).optional(),
        cpus: z.number().positive().max(64).default(2),
        memory_mb: z.number().int().min(128).max(131072).default(1024),
        pids: z.number().int().min(16).max(4096).default(128),
        uid: z.number().int().positive().default(1000),
        gid: z.number().int().positive().default(1000),
      })
      .strict()
      .prefault({}),
    storage: z
      .object({
        root: absolute.default("/job-data"),
        host_root: reference.default("/job-data"),
        runtime_root: absolute.default("/workspace"),
        dependencies_volume: reference.default("razbor-runtime"),
      })
      .strict()
      .prefault({}),
    capabilities: z
      .object({
        base_instructions: z.boolean().default(false),
        instruction_file: absolute.optional(),
        skill_directories: z.array(absolute).max(16).default([]),
        limits: capabilityLimitsSchema.prefault({}),
      })
      .strict()
      .optional(),
    harness: z
      .object({
        initialDiffMaxBytes: z.number().int().min(0).max(1000000).default(4096),
        reviewBudget: reviewBudgetSchema.prefault({}),
        contextWindowTokens: z
          .number()
          .int()
          .min(1024)
          .max(10000000)
          .optional(),
        compactionThresholdTokens: z
          .number()
          .int()
          .min(1024)
          .max(1000000)
          .default(80000),
      })
      .strict()
      .prefault({}),
    model: z
      .object({
        provider: modelProviderSchema.default("openai"),
        endpoint: reference.optional(),
        api_key: reference.optional(),
        model: z.string().min(1).optional(),
        supports_tools: z.boolean().default(true),
        reasoning_effort: reasoningEffortSchema.default("high"),
        max_requests: reviewMaxTurnsSchema,
        max_retries: z.number().int().min(0).max(10).default(0),
        max_request_bytes: z
          .number()
          .int()
          .min(1024)
          .max(10000000)
          .default(2000000),
        max_response_bytes: z
          .number()
          .int()
          .min(1024)
          .max(10000000)
          .default(1000000),
        max_output_tokens: z.number().int().min(1).max(32768).default(4096),
        timeout_ms: z.number().int().min(100).max(3600000).default(3600000),
        relay_port: z.number().int().min(1024).max(65535).default(8787),
      })
      .strict()
      .refine(
        (model) =>
          [model.endpoint, model.api_key, model.model].every(
            (value) => value === undefined,
          ) ||
          [model.endpoint, model.api_key, model.model].every(
            (value) => value !== undefined,
          ),
        "legacy model endpoint, api_key and model must be configured together",
      )
      .prefault({}),
  })
  .strict();

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

export type ResolvedConfig = RunnerConfig & {
  hostRoot: string;
  dependenciesVolume: string;
  network: string;
  endpoint?: string;
  apiKey?: string;
};

/** Resolve a literal, environment variable, or secret file; reject empty or multiline values. */
export async function resolveReference(ref: z.infer<typeof reference>) {
  const value =
    typeof ref === "string"
      ? ref
      : "env" in ref
        ? process.env[ref.env]
        : (await readFile(ref.file, "utf8")).trimEnd();
  if (!value || /[\r\n\0]/.test(value))
    throw new PermanentError("missing or invalid configuration reference");
  return value;
}

/**
 * Parse optional TOML and apply defaults without resolving host-specific references or
 * secrets.
 */
export async function loadRunnerConfig(file?: string): Promise<RunnerConfig> {
  return runnerConfigSchema.parse(
    file ? parse(await readFile(file, "utf8")) : {},
  );
}

/**
 * Resolve runtime references and validate model transport, Docker names, and separation of
 * job storage from trusted runtime files.
 */
export async function loadConfig(file?: string): Promise<ResolvedConfig> {
  const config = await loadRunnerConfig(file);
  const [hostRoot, dependenciesVolume, network] = await Promise.all(
    [
      config.storage.host_root,
      config.storage.dependencies_volume,
      config.docker.network,
    ].map(resolveReference),
  );
  absolute.parse(hostRoot);
  name.parse(network);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(dependenciesVolume))
    throw new PermanentError("invalid dependency volume name");
  const endpoint = config.model.endpoint
    ? await resolveReference(config.model.endpoint)
    : undefined;
  const apiKey = config.model.api_key
    ? await resolveReference(config.model.api_key)
    : undefined;
  if (endpoint) {
    const url = new URL(endpoint);
    const nativePath =
      config.model.provider === "anthropic" ? "/messages" : "/responses";
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith(nativePath)
    )
      throw new PermanentError(
        `model endpoint must be a fixed ${config.model.provider === "anthropic" ? "Anthropic Messages" : "Responses"} URL ending in ${nativePath}`,
      );
  }
  if (
    isInside(config.storage.runtime_root, config.storage.root) ||
    isInside(config.storage.root, config.storage.runtime_root)
  )
    throw new PermanentError("storage must be separate from runtime");
  return {
    ...config,
    hostRoot,
    dependenciesVolume,
    network,
    endpoint,
    apiKey,
  };
}

/**
 * Check lexical containment, including equality; callers must resolve symlinks separately
 * when enforcing filesystem boundaries.
 */
export function isInside(root: string, candidate: string) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
