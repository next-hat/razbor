import { listAgents } from "@razbor/database";

import { RepositoryWizard } from "@web/components/repository-wizard.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";

export const dynamic = "force-dynamic";

/** Loads this account context's reviewers after checking repository management access. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser({ resource: "repository" });
  const query = await searchParams;
  return (
    <RepositoryWizard
      initialAgents={await pageData((db) => listAgents(db, user.context.id))}
      canManageRunners={user.role === "super_admin"}
      canManageAgents={canManageResource(user, "agent")}
      canManageIndexer={canManageResource(user, "indexer")}
      initialGithubApp={
        typeof query.githubApp === "string" ? query.githubApp : undefined
      }
      githubAppError={query.githubAppError === "1"}
    />
  );
}
