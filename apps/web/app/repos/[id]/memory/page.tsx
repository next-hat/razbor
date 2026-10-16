import { memoryOperation } from "@razbor/database/memory";

import { MemoryEditor } from "@web/components/memory-editor.js";
import { pageData } from "@web/lib/page-data.js";
import { requirePageUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/** Loads the repository's visible memory collections and initial document list. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  await requirePageUser({ resource: "repository", repositoryId: id });
  const initialData = await pageData((database) =>
    memoryOperation(
      database,
      id,
      { operation: "list", limit: 100 },
      {
        actor: "human",
      },
    ),
  );
  return <MemoryEditor key={id} repositoryId={id} initialData={initialData} />;
}
