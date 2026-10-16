import { listUsers } from "@razbor/database";

import { UsersPage } from "@web/components/users-page.js";
import { authenticationConfig } from "@web/lib/auth-config.js";
import { requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";

export const dynamic = "force-dynamic";

/** Loads instance accounts only after checking super admin access. */
export default async function Page() {
  const user = await requirePageUser({ admin: true });
  const users = await pageData(listUsers);
  return (
    <UsersPage
      initialUsers={users}
      currentUserId={user.id}
      localEnabled={(await authenticationConfig()).local_enabled}
    />
  );
}
