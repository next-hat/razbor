import { SkillCreatePage } from "@web/components/skill-create-page.js";
import { requirePageUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/** Checks skill-management access before rendering the local creation form. */
export default async function Page({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ mode?: string | string[] }>;
}>) {
  await requirePageUser({ resource: "skill" });
  const query = await searchParams;
  return (
    <SkillCreatePage
      initialMode={query.mode === "files" ? "files" : "template"}
    />
  );
}
