import { listAgents } from "@razbor/database";

import { requireSettingsRepository } from "@web/app/repos/[id]/settings/repository.js";
import { RepositoryAgent } from "@web/components/repository-agent.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";

export const dynamic = "force-dynamic";

/** Loads the assigned reviewer and available agents for this repository only. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const repository = await requireSettingsRepository(id);
  const user = await requirePageUser({
    resource: "repository",
    repositoryId: id,
  });
  if (!repository)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Repository details are unavailable. Reload this page to try again.
        </AlertDescription>
      </Alert>
    );
  const agents = await pageData((db) => listAgents(db, user.context.id));
  return (
    <RepositoryAgent
      key={id}
      initialRepository={repository}
      initialAgents={agents}
      canCreate={canManageResource(user, "agent")}
    />
  );
}
