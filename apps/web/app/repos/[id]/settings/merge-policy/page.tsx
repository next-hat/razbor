import { requireSettingsRepository } from "@web/app/repos/[id]/settings/repository.js";
import { RepositoryMergePolicy } from "@web/components/repository-merge-policy.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";

export const dynamic = "force-dynamic";

/** Load privileged policy and its concurrency token only after the repository management grant check. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const repository = await requireSettingsRepository(id);
  if (!repository)
    return (
      <Alert>
        <AlertDescription>
          Repository settings are unavailable. Reload this page to try again.
        </AlertDescription>
      </Alert>
    );
  return (
    <RepositoryMergePolicy
      key={id}
      repositoryId={id}
      initial={{
        policy: repository.mergePolicy,
        version: repository.mergePolicyVersion,
      }}
      editable={repository.mergePolicyEditable}
    />
  );
}
