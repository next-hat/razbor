import { notFound } from "next/navigation.js";

import { publicIdSchema, type SkillDetail } from "@razbor/contracts";
import { getSkill } from "@razbor/database/skills";

import { SkillDetailPage } from "@web/components/skill-detail-page.js";
import { requirePageUser } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";

export const dynamic = "force-dynamic";

/** Reads one skill in the selected account context, separating missing content from storage failures. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const user = await requirePageUser({ resource: "skill" });
  const { id } = await params;
  if (!publicIdSchema("skill").safeParse(id).success) notFound();
  let skill: SkillDetail | undefined;
  let unavailable = false;
  try {
    skill = await getSkill(await reviewDatabase(), id, user.context.id);
  } catch {
    unavailable = true;
  }
  if (!unavailable && !skill) notFound();
  return (
    <SkillDetailPage
      key={`${user.context.id}:${id}`}
      skillId={id}
      initialData={skill}
    />
  );
}
