import { listIndexProjects, listTokens, type Database } from "@razbor/database";

import { indexPreparations } from "@web/lib/indexer.js";
import { reviewDatabase } from "@web/lib/review.js";

/**
 * Loads current data for server rendering; failures become undefined so the hydrated
 * page can recover through its existing refresh state.
 */
export async function pageData<T>(read: (database: Database) => Promise<T>) {
  try {
    return await read(await reviewDatabase());
  } catch {
    return undefined;
  }
}

/**
 * Loads index and token views, optionally narrowing displayed projects and tokens to
 * one repository while retaining repository choices. Live preparation metadata
 * is requested only after context and repository grant filtering; its failure
 * preserves the durable index and token views.
 */
export async function indexData(
  database: Database,
  repositoryId?: string,
  repositoryIds?: string[],
  contextId?: string,
) {
  const [repositoryViews, tokenViews] = await Promise.all([
    listIndexProjects(database, undefined, contextId),
    listTokens(database, undefined, repositoryId, contextId),
  ]);
  const repositories = repositoryIds
    ? repositoryViews.filter((repository) =>
        repositoryIds.includes(repository.repositoryId),
      )
    : repositoryViews;
  const tokens = repositoryIds
    ? tokenViews.filter((token) => repositoryIds.includes(token.repositoryId))
    : tokenViews;
  const projects = repositoryId
    ? repositories.filter((project) => project.repositoryId === repositoryId)
    : repositories;
  let preparations: Awaited<ReturnType<typeof indexPreparations>> = [];
  let preparationAvailable = true;
  try {
    preparations = await indexPreparations([
      ...new Set(
        projects
          .filter(
            (project) =>
              !!project.id && !["deleting", "expired"].includes(project.state),
          )
          .map((project) => project.repositoryId),
      ),
    ]);
  } catch {
    preparationAvailable = false;
  }
  const preparationByRepository = new Map(
    preparations.map((entry) => [entry.repositoryId, entry]),
  );
  if (
    projects.some(
      (project) =>
        project.id &&
        !["deleting", "expired"].includes(project.state) &&
        preparationByRepository.get(project.repositoryId)?.workspaceId !==
          project.id,
    )
  )
    preparationAvailable = false;
  return {
    projects: projects.map((project) => {
      const snapshot = preparationByRepository.get(project.repositoryId);
      // A snapshot for an older workspace must not override the current durable
      // binding after deletion or reprovisioning.
      const preparation =
        snapshot && (!project.id || snapshot.workspaceId === project.id)
          ? snapshot.preparation
          : null;
      return { ...project, preparation };
    }),
    repositories,
    tokens,
    preparationAvailable,
    asOf: new Date().toISOString(),
  };
}
