import { getRepositoryGuidance, listSkills } from "@razbor/database/skills";

import { requireSettingsRepository } from "@web/app/repos/[id]/settings/repository.js";
import { RepositoryGuidance } from "@web/components/repository-guidance.js";
import { requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";

export const dynamic = "force-dynamic";

/** Loads repository instruction switches and installed skill choices. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  await requireSettingsRepository(id);
  const user = await requirePageUser({
    resource: "repository",
    repositoryId: id,
  });
  const [guidance, skills] = await Promise.all([
    pageData((db) => getRepositoryGuidance(db, id)),
    pageData((db) => listSkills(db, user.context.id)),
  ]);
  return (
    <RepositoryGuidance
      key={id}
      repositoryId={id}
      initialGuidance={guidance}
      initialSkills={skills}
    />
  );
}
