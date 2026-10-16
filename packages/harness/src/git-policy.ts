import path from "node:path";

import { z } from "zod";

import { githubInstallationSchema } from "@razbor/contracts";

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

export const absolute = z
  .string()
  .refine(
    (value) =>
      path.isAbsolute(value) &&
      path.normalize(value) === value &&
      value !== "/",
    "expected a normalized absolute non-root path",
  );

const ref = z
  .string()
  .regex(/^refs\/[a-zA-Z0-9_./-]+$/)
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.endsWith(".lock"),
    "invalid Git ref",
  );

const remoteUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      ["https:", "ssh:", "file:"].includes(url.protocol) &&
      !url.password &&
      (url.protocol === "ssh:" || !url.username) &&
      !url.search &&
      !url.hash &&
      !/[\r\n\0]/.test(value)
    );
  } catch {
    return false;
  }
}, "use an HTTPS, ssh:// or explicitly enabled file:// URL without embedded credentials");

export const repositoryConfigSchema = z
  .object({
    branch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/),
    upstream: ref.refine((value) => /^refs\/remotes\/[^/]+\/.+/.test(value)),
    remotes: z
      .record(identifier, remoteUrl)
      .refine((value) => Object.keys(value).length > 0),
    extra_fetch_refs: z.record(identifier, z.array(ref)).default({}),
    allow_local: z.boolean().default(false),
    credentials: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("https"),
            username: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[^:\r\n\0]+$/),
            token_file: absolute.optional(),
            token_id: z.string().uuid().optional(),
            github_app: githubInstallationSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("ssh"),
            key_file: absolute,
            known_hosts_file: absolute,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.credentials?.kind === "https" &&
      [
        value.credentials.token_file,
        value.credentials.token_id,
        value.credentials.github_app,
      ].filter(Boolean).length !== 1
    )
      ctx.addIssue({
        code: "custom",
        path: ["credentials"],
        message:
          "HTTPS credentials require exactly one token_file, token_id or github_app",
      });
    const upstreamRemote = value.upstream.split("/")[2];
    if (!Object.hasOwn(value.remotes, upstreamRemote))
      ctx.addIssue({
        code: "custom",
        message: "upstream must belong to an approved remote",
      });
    for (const [name, url] of Object.entries(value.remotes)) {
      if (url.startsWith("file:") && !value.allow_local)
        ctx.addIssue({
          code: "custom",
          message: "file remotes require allow_local",
        });
      if (value.credentials && !url.startsWith(`${value.credentials.kind}:`))
        ctx.addIssue({
          code: "custom",
          message: "credential kind must match every remote",
        });
      if (
        value.extra_fetch_refs[name]?.some((item) =>
          item.startsWith("refs/remotes/"),
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "fetch source must be an upstream ref, not a remote tracking ref",
        });
    }
    for (const name of Object.keys(value.extra_fetch_refs))
      if (!Object.hasOwn(value.remotes, name))
        ctx.addIssue({
          code: "custom",
          message: "extra fetch refs require an approved remote",
        });
  });
