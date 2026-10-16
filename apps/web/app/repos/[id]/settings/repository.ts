import { notFound, redirect } from "next/navigation.js";

import { getRepository } from "@razbor/database";

import { requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";

/**
 * Checks context repository management access before loading a section and sends deleting repositories
 * to the general settings page, where deletion progress is polled.
 */
export async function requireSettingsRepository(id: string) {
  const user = await requirePageUser({
    resource: "repository",
    repositoryId: id,
  });
  const repository = await pageData((db) =>
    getRepository(db, id, user.context.id),
  );
  if (repository === null) notFound();
  if (repository?.status === "deleting") redirect(`/repos/${id}/settings`);
  return repository;
}
