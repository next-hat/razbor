import { publicMergeDecision } from "@razbor/contracts";
import type { PullRequestDetail, PullRequestView } from "@razbor/database";

import { sanitizeReviewView } from "@web/lib/request-access.js";

/** Removes administrative reviewer configuration from every nested PR review. */
export function visiblePullRequest<T extends PullRequestView>(
  pullRequest: T,
  isAdmin: boolean,
): T {
  if (isAdmin) return pullRequest;
  return {
    ...pullRequest,
    ...(pullRequest.merge
      ? {
          merge: {
            ...pullRequest.merge,
            decision: publicMergeDecision(pullRequest.merge.decision),
          },
        }
      : {}),
    ...(pullRequest.latestReview
      ? { latestReview: sanitizeReviewView(pullRequest.latestReview) }
      : {}),
    ...("reviews" in pullRequest
      ? {
          reviews: (pullRequest as unknown as PullRequestDetail).reviews.map(
            sanitizeReviewView,
          ),
        }
      : {}),
  };
}
