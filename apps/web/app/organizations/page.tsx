import {
  listAccountInvitations,
  listOrganizationInvitations,
  listOrganizationMembers,
  listRepositories,
} from "@razbor/database";

import { OrganizationsPage } from "@web/components/organizations-page.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";

export const dynamic = "force-dynamic";

/** Loads account invitations for everyone and organization management data only for current managers. */
export default async function Page() {
  const user = await requirePageUser();
  const canManageMembers =
    user.context.kind === "organization" &&
    canManageResource(user, "organization");
  const canManageAccess =
    user.context.kind === "organization" &&
    canManageResource(user, "repository");
  const [invitations, organization] = await Promise.all([
    pageData((db) => listAccountInvitations(db, user)),
    canManageAccess
      ? pageData(async (db) => {
          const [members, invitations, repositories] = await Promise.all([
            listOrganizationMembers(db, user.context.id, user),
            canManageMembers
              ? listOrganizationInvitations(db, user.context.id, user)
              : Promise.resolve([]),
            listRepositories(db, undefined, user.context.id),
          ]);
          return { members, invitations, repositories };
        })
      : undefined,
  ]);
  return (
    <OrganizationsPage
      key={user.context.id}
      currentUserId={user.id}
      initialContexts={{
        contexts: user.contexts,
        currentContext: user.context,
        invitations: invitations ?? [],
      }}
      initialOrganization={organization}
      canManageMembers={canManageMembers}
      canManageAccess={canManageAccess}
    />
  );
}
