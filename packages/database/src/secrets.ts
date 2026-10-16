import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@database/src/connection.js";
import { storedSecrets } from "@database/src/schema.js";

/**
 * Read a repository credential by internal ID, rejecting absent values and
 * line or NUL delimiters before use.
 */
export async function readStoredSecret(database: Database, id: string) {
  z.string().uuid().parse(id);
  const [secret] = await database.db
    .select({ value: storedSecrets.value })
    .from(storedSecrets)
    .where(eq(storedSecrets.id, id));
  if (!secret?.value || /[\r\n\0]/.test(secret.value))
    throw new Error("missing or invalid stored credential");
  return secret.value;
}
