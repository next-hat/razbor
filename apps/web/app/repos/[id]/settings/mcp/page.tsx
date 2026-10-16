import { getRepositoryMcpAccess, listMcpServers } from "@razbor/database/mcp";

import { requireSettingsRepository } from "@web/app/repos/[id]/settings/repository.js";
import { RepositoryMcp } from "@web/components/repository-mcp.js";
import { requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";

export const dynamic = "force-dynamic";

/** Loads explicit repository MCP grants and the available server library. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  await requireSettingsRepository(id);
  const user = await requirePageUser({
    resource: "repository",
    repositoryId: id,
  });
  const [access, servers] = await Promise.all([
    pageData((db) => getRepositoryMcpAccess(db, id)),
    pageData((db) => listMcpServers(db, user.context.id)),
  ]);
  return (
    <RepositoryMcp
      key={id}
      repositoryId={id}
      initialAccess={access}
      initialServers={servers}
    />
  );
}
