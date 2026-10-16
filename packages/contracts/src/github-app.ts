import { z } from "zod";

import { publicIdSchema } from "@contracts/src/ids.js";

export const githubInstallationSchema = z
  .object({
    app_id: publicIdSchema("githubApp"),
    installation_id: z.string().regex(/^[1-9]\d{0,19}$/),
    repository_id: z.string().regex(/^[1-9]\d{0,19}$/),
  })
  .strict();

export type GithubInstallation = z.infer<typeof githubInstallationSchema>;
