import { IndexPanel } from "@web/components/index-panel.js";
import { pageData, indexData } from "@web/lib/page-data.js";
import { requirePageUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/**
 * Seeds the index management panel with a current server snapshot when storage is
 * available.
 */
export default async function Page() {
  const user = await requirePageUser({ resource: "indexer" });
  const initialData = await pageData((db) =>
    indexData(db, undefined, user.repositoryIds, user.context.id),
  );
  return <IndexPanel initialData={initialData} />;
}
