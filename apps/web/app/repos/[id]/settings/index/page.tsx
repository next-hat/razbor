import { requireSettingsRepository } from "@web/app/repos/[id]/settings/repository.js";
import { IndexPanel } from "@web/components/index-panel.js";
import { indexData, pageData } from "@web/lib/page-data.js";
import { requirePageUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/** Loads repository index projects and scoped token controls. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const user = await requirePageUser({ resource: "indexer", repositoryId: id });
  await requireSettingsRepository(id);
  const indexes = await pageData((db) =>
    indexData(db, id, user.repositoryIds, user.context.id),
  );
  return <IndexPanel key={id} repositoryId={id} initialData={indexes} />;
}
