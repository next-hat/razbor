import { publicIdSchema, type ReviewJobView } from "@razbor/contracts";
import {
  getReview,
  listIndexProjects,
  listTokens,
  type listRepositories,
} from "@razbor/database";

import {
  assertSameOrigin,
  authenticationUnavailable,
  requireApiUser,
  type ManagedResource,
  AuthError,
  canAccessRepository,
} from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";

/**
 * Rejects unauthorized console route requests before reading input or storage,
 * and checks the origin of every cookie-authenticated mutation.
 */
export async function apiAccessResponse(
  request: Request,
  options: {
    admin?: boolean;
    resource?: ManagedResource;
    repositoryId?: string;
  } = {},
) {
  try {
    const path = new URL(request.url).pathname;
    const segments = (
      /^\/(?:health|review|reviews|repositories)(?:\/|$)/.test(path)
        ? `/api${path}`
        : path
    )
      .split("/")
      .map((segment) => decodeURIComponent(segment));
    const repositoryId =
      segments[2] === "repositories" &&
      segments[3] &&
      !["setup", "verify"].includes(segments[3])
        ? segments[3]
        : options.repositoryId;
    if (
      repositoryId &&
      !publicIdSchema("repository").safeParse(repositoryId).success
    )
      throw new AuthError(404, "Repository not found.");
    const user = await requireApiUser(request, { ...options, repositoryId });
    if (options.resource && segments[2] === "reviews" && segments[3]) {
      const review = await getReview(await reviewDatabase(), segments[3]);
      if (!review || !canAccessRepository(user, review.repositoryId))
        throw new AuthError(404, "Review not found.");
    }
    if (options.resource === "indexer" && segments[3]) {
      const database = await reviewDatabase();
      if (segments[2] === "indexes") {
        const projects = await listIndexProjects(database);
        if (
          !projects.some(
            (entry) =>
              entry.id === segments[3] &&
              canAccessRepository(user, entry.repositoryId),
          )
        )
          throw new AuthError(404, "Index not found.");
      } else if (segments[2] === "index-tokens") {
        const tokens = await listTokens(database);
        if (
          !tokens.some(
            (entry) =>
              entry.id === segments[3] &&
              canAccessRepository(user, entry.repositoryId) &&
              entry.scopes.every((scope) =>
                canAccessRepository(user, scope.repositoryId),
              ),
          )
        )
          throw new AuthError(404, "Token not found.");
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
      assertSameOrigin(request);
    return undefined;
  } catch (error) {
    return authenticationUnavailable(error);
  }
}

/** Removes reviewer connection details and administrative setup errors from a member's view. */
export function sanitizeRepositoryView(
  repository: Awaited<ReturnType<typeof listRepositories>>[number],
) {
  return { ...repository, agent: null, agentId: null, setupError: null };
}

/** Omits captured reviewer connection and guidance configuration from a member's review view. */
export function sanitizeReviewView<T extends ReviewJobView>(review: T) {
  const visible = { ...review };
  delete visible.agent;
  delete visible.guidance;
  return visible;
}
