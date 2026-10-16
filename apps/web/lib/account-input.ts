import { z } from "zod";

import { AuthError } from "@web/lib/auth.js";
import { managementJson } from "@web/lib/management-request.js";

export const credentialsSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(1024),
  })
  .strict();

export const userInputSchema = z
  .object({
    username: z.string().trim().min(3).max(64),
    password: z.string().min(12).max(1024),
    role: z.enum(["admin", "super_admin", "user"]),
  })
  .strict();

export const userUpdateSchema = userInputSchema
  .omit({ username: true })
  .partial()
  .extend({
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(12).max(1024),
  })
  .strict();

/** Reads a bounded JSON request and reports only safe validation errors. */
export async function accountInput<T>(request: Request, schema: z.ZodType<T>) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new AuthError(400, "JSON request required.");
  try {
    const result = schema.safeParse(await managementJson(request, 65536));
    if (!result.success) throw new AuthError(400, "Invalid account details.");
    return result.data;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof Error && error.message === "request too large")
      throw new AuthError(413, "Account request is too large.");
    throw new AuthError(400, "Invalid account details.");
  }
}
