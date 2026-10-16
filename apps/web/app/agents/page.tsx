import { listAgents, listRepositories } from "@razbor/database";

import { AgentsPage } from "@web/components/agents-page.js";
import { pageData } from "@web/lib/page-data.js";
import { requirePageUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/**
 * Loads context-owned reviewer profiles and granted repository assignments for
 * the page, exposing only agent IDs and lifecycle states in the assignment snapshot.
 * Failed reads remain recoverable through the client's existing loading states.
 */
export default async function Page() {
  const user = await requirePageUser({ resource: "agent" });
  const [agents, repositories] = await Promise.all([
    pageData((db) => listAgents(db, user.context.id)),
    pageData(async (db) =>
      (await listRepositories(db, user.repositoryIds, user.context.id)).map(
        ({ agentId, status }) => ({ agentId, status }),
      ),
    ),
  ]);
  return <AgentsPage initialData={agents} initialRepositories={repositories} />;
}
