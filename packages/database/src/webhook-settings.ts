import { z } from "zod";

import { publicIdSchema } from "@razbor/contracts";
import { absolute } from "@razbor/harness/git-policy";

const secretReferenceSchema = z.union([
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict(),
  z.object({ file: absolute }).strict(),
  z.object({ stored: z.string().uuid() }).strict(),
  z.object({ githubApp: publicIdSchema("githubApp") }).strict(),
]);

export const webhookSettingsSchema = z
  .object({
    enabled: z.boolean(),
    callback_base: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          ![
            "localhost",
            "127.0.0.1",
            "[::1]",
            "web",
            "webhooks",
            "indexer",
          ].includes(u.hostname)
        );
      }, "Use an HTTPS callback reachable from your forge"),
    secret: secretReferenceSchema,
    permitted_senders: z
      .array(
        z.union([
          z.literal("*"),
          z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict();
