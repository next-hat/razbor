import { listSkills } from "@razbor/database/skills";

import { SkillsPage } from "@web/components/skills-page.js";
import { pageData } from "@web/lib/page-data.js";
import { requirePageUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/** Server-renders the installed skill catalog, with client recovery for storage failures. */
export default async function Page() {
  const user = await requirePageUser({ resource: "skill" });
  return (
    <SkillsPage
      initialData={await pageData((db) => listSkills(db, user.context.id))}
    />
  );
}
