import {
  listIndexProjects,
  listPullRequests,
  listRepositories,
} from "@razbor/database";

import { RepositoriesPage } from "@web/components/repositories-page.js";
import { pageData } from "@web/lib/page-data.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { sanitizeRepositoryView } from "@web/lib/request-access.js";

export const dynamic = "force-dynamic";

/**
 * Server-renders the repositories visible to the current console user.
 */
export default async function Page({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ sort?: string; view?: string }>;
}>) {
  const user = await requirePageUser();
  const isAdmin = canManageResource(user, "repository");
  const canReadIndexes = isAdmin && canManageResource(user, "indexer");
  const parameters = await searchParams;
  const [repositories, indexes, pullRequests] = await Promise.all([
    pageData(async (db) => {
      const repositories = await listRepositories(
        db,
        user.repositoryIds,
        user.context.id,
      );
      return isAdmin
        ? repositories
        : repositories
            .filter((repository) => user.repositoryIds.includes(repository.id))
            .map(sanitizeRepositoryView);
    }),
    canReadIndexes
      ? pageData(async (db) =>
          (await listIndexProjects(db, undefined, user.context.id)).filter(
            (index) => user.repositoryIds.includes(index.repositoryId),
          ),
        )
      : undefined,
    pageData(async (db) =>
      (await listPullRequests(db, user.repositoryIds)).map(
        ({ repositoryId, state }) => ({ repositoryId, state }),
      ),
    ),
  ]);
  const sort =
    parameters.sort === "name-desc"
      ? "name-desc"
      : parameters.sort === "name" || !canReadIndexes
        ? "name"
        : "indexed";
  return (
    <RepositoriesPage
      initialData={repositories}
      initialIndexes={indexes}
      initialPullRequests={pullRequests}
      isAdmin={isAdmin}
      canReadIndexes={canReadIndexes}
      sort={sort}
      view={parameters.view === "list" ? "list" : "grid"}
    />
  );
}
