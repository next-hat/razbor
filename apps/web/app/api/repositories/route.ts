import {
  AgentInputError,
  listRepositories,
  createRepositoryFromUi,
  RepositoryRegistrationError,
  reconcileWebhook,
} from "@razbor/database";

import { canManageResource } from "@web/lib/auth.js";
import { requestContextId } from "@web/lib/auth.js";
import {
  apiAccessResponse,
  sanitizeRepositoryView,
} from "@web/lib/request-access.js";
import {
  authErrorResponse,
  requireApiUser,
  requestSessionToken,
} from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";
import {
  managementRequest,
  managementJson,
} from "@web/lib/management-request.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Returns the registered repository list or an unavailable response when storage cannot
 * be read.
 */
export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const repositories = await listRepositories(
      await reviewDatabase(),
      user.repositoryIds,
      await requestContextId(request),
    );
    return Response.json(
      canManageResource(user, "repository")
        ? repositories
        : repositories.map(sanitizeRepositoryView),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      { error: "repository storage unavailable" },
      { status: 503 },
    );
  }
}

/**
 * Verifies and registers a repository from management JSON, then reconciles its webhook
 * while retaining registration and reviewer errors. A webhook setup failure
 * does not undo registration or hide its one-time signing secret.
 */
export async function POST(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403 },
    );
  try {
    const database = await reviewDatabase();
    const repository = await createRepositoryFromUi(
      database,
      await managementJson(request),
      requestSessionToken(request),
      await requestContextId(request),
    );
    if (repository) {
      try {
        await reconcileWebhook(database, repository.id);
      } catch {
        // Registration is committed. The setup checklist can reload status and
        // retry webhook setup without asking the user to create a duplicate.
      }
    }
    return Response.json(repository, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      {
        error:
          error instanceof RepositoryRegistrationError ||
          error instanceof AgentInputError
            ? error.message
            : "Could not add this repository. Check the URL, token, branch, webhook address, and permitted reviewers.",
      },
      {
        status:
          error instanceof RepositoryRegistrationError ||
          error instanceof AgentInputError
            ? error.status
            : 400,
      },
    );
  }
}
