import { getRepository } from "@razbor/database";

import { RepositoryManagement } from "@web/components/repository-management.js";
import { requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";

export const dynamic = "force-dynamic";

/** Loads repository connection and deletion controls for general settings. */
export default async function Page({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;
  const user = await requirePageUser({
    resource: "repository",
    repositoryId: id,
  });
  const repository = await pageData((db) =>
    getRepository(db, id, user.context.id),
  );
  return (
    <RepositoryManagement key={id} id={id} initialRepository={repository} />
  );
}
