import { approvedUrl, ForgeReadError } from "@forge-adapters/src/http.js";
import {
  readGithub,
  verifyGithubRegistration,
} from "@forge-adapters/src/github/index.js";
import {
  readGitlab,
  verifyGitlabRegistration,
} from "@forge-adapters/src/gitlab/index.js";
import {
  readForgejo,
  verifyForgejoRegistration,
} from "@forge-adapters/src/forgejo/index.js";
import type { ForgeConnection } from "@forge-adapters/src/types.js";
import { ForgejoInteractions } from "@forge-adapters/src/forgejo/interactions.js";
import { GithubForge } from "@forge-adapters/src/github/interactions.js";
import { GitlabForge } from "@forge-adapters/src/gitlab/interactions.js";
import type { Forge } from "@forge-adapters/src/interactions.js";

export type * from "@forge-adapters/src/types.js";

export { approvedUrl, ForgeReadError } from "@forge-adapters/src/http.js";

export {
  createGithubAppJwt,
  convertGithubAppManifest,
  readGithubApp,
  listGithubAppInstallations,
  createGithubInstallationToken,
  listGithubInstallationRepositories,
  type GithubAppCredentials,
} from "@forge-adapters/src/github/app.js";

export { verifyGithubWebhook } from "@forge-adapters/src/github/interactions.js";

/**
 * Read provider metadata and require its repository web URL to remain within
 * the configured web origin and path; sanitize invalid responses.
 */
export async function verifyRepository(
  c: ForgeConnection,
  selector: string,
  signal?: AbortSignal,
) {
  try {
    const result = await {
      github: readGithub,
      gitlab: readGitlab,
      forgejo: readForgejo,
    }[c.type](c, selector, signal);
    const web = approvedUrl(result.webUrl, c.allowHttp);
    const approved = approvedUrl(c.webUrl, c.allowHttp);
    if (
      web.origin !== approved.origin ||
      !(
        web.pathname === approved.pathname ||
        web.pathname.startsWith(`${approved.pathname.replace(/\/$/, "")}/`)
      )
    )
      throw new Error("unapproved repository web URL");
    return result;
  } catch (error) {
    if (error instanceof ForgeReadError) throw error;
    throw new ForgeReadError("invalid-response");
  }
}

export {
  ForgejoInteractions,
  ForgeOperationError,
  parseForgejoComment,
  parseForgejoPullRequest,
  parseForgejoPush,
  verifyForgejoWebhook,
  type ForgejoChange,
  type InlineComment,
} from "@forge-adapters/src/forgejo/interactions.js";

export {
  renderForgejoInline,
  renderForgejoReview,
  forgeMarkdown,
  forgejoSourceUrl,
} from "@forge-adapters/src/forgejo/presentation.js";

export { verifyForgejoRegistration } from "@forge-adapters/src/forgejo/index.js";

export type {
  Forge,
  ForgeChange,
  ForgePullRequest,
  ForgeReviewComment,
  ForgePublicationProgress,
  ForgeWebhook,
} from "@forge-adapters/src/interactions.js";

export { ForgeWebhookError } from "@forge-adapters/src/interactions.js";

/** Bind provider interactions to one configured repository and request budget. */
export function createForge(
  connection: ForgeConnection,
  selector: string,
  budgetMs = 20000,
): Forge {
  switch (connection.type) {
    case "github":
      return new GithubForge(connection, selector, budgetMs);
    case "gitlab":
      return new GitlabForge(connection, selector, budgetMs);
    case "forgejo":
      return new ForgejoInteractions(connection, selector, budgetMs);
  }
}

/** Verify provider identity, repository, branch and clone credentials for registration. */
export async function verifyRegistration(
  connection: ForgeConnection,
  selector: string,
  branch?: string,
  signal?: AbortSignal,
) {
  const verified = await {
    github: verifyGithubRegistration,
    gitlab: verifyGitlabRegistration,
    forgejo: verifyForgejoRegistration,
  }[connection.type](connection, selector, branch, signal);
  return {
    ...verified,
    gitUsername:
      "gitUsername" in verified
        ? String(verified.gitUsername)
        : verified.identity.login,
  };
}

/** Describe webhook setup without loading credentials or contacting a provider. */
export function forgeWebhookSettings(type: ForgeConnection["type"]) {
  return {
    forgejo: {
      label: "Forgejo",
      events: ["pull_request", "pull_request_comment", "push"],
      secretHeader: "X-Forgejo-Signature",
    },
    github: {
      label: "GitHub",
      events: [
        "pull_request",
        "issue_comment",
        "pull_request_review_comment",
        "push",
      ],
      secretHeader: "X-Hub-Signature-256",
    },
    gitlab: {
      label: "GitLab",
      events: ["merge_requests_events", "note_events", "push_events"],
      secretHeader: "X-Gitlab-Token",
    },
  }[type];
}

export {
  renderInline,
  renderReview,
  forgeSourceUrl,
} from "@forge-adapters/src/presentation.js";
