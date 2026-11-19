import { z } from "zod";

import {
  forgeMergeReasonMessages,
  reviewerUsernameSchema,
} from "@razbor/contracts";

import { providerId } from "@forge-adapters/src/http.js";
import {
  ForgeOperationError,
  type ForgeMergeRequest,
  type ForgeMergeCheckpoint,
  type ForgeMergeWriteStage,
  type ForgeMergeState,
} from "@forge-adapters/src/interactions.js";

export const mergeId = providerId.pipe(z.string().regex(/^[1-9]\d*$/));

export const commitSha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

export const mergeRequestSchema = z.object({
  number: z.number().int().positive().safe(),
  externalRepositoryId: z.string().regex(/^[1-9]\d*$/),
  baseSha: commitSha,
  headSha: commitSha,
  baseBranch: z.string().min(1).max(1024),
  method: z.enum(["merge", "squash", "rebase"]),
  requirePassingChecks: z.boolean(),
  reviewId: z.string().regex(/^rev_[A-Za-z0-9]{16}$/),
});

/** Compare both immutable revisions and the destination before any open PR operation. */
export function differentRevision(
  request: ForgeMergeRequest,
  head: string,
  base: string,
  branch: string,
) {
  return (
    head !== request.headSha ||
    base !== request.baseSha ||
    branch !== request.baseBranch
  );
}

/** Translate a persisted provider reason to administrator-facing text without rendering remote payloads. */
export function forgeMergeReason(code: string) {
  return Object.hasOwn(forgeMergeReasonMessages, code)
    ? forgeMergeReasonMessages[code as keyof typeof forgeMergeReasonMessages]
    : "The provider could not verify all required merge conditions.";
}

/** Supply a stable reason code suitable for recording in the decision history. */
export function mergeState(
  state: ForgeMergeState["state"],
  reason: keyof typeof forgeMergeReasonMessages,
): ForgeMergeState {
  return { state, reason };
}

/** Perform a single account lookup and suppress missing, reserved, non-person or unavailable identities. */
export async function resolveReviewer(
  username: string,
  lookup: (escaped: string) => Promise<string | undefined>,
) {
  if (!reviewerUsernameSchema.safeParse(username).success) return null;
  try {
    const found = await lookup(encodeURIComponent(username));
    return found?.toLowerCase() === username.toLowerCase() ? found : null;
  } catch {
    return null;
  }
}

/** A stale or denied preflight must never reach a mutation. */
export function requireMergeReady(state: ForgeMergeState) {
  if (state.state !== "ready") throw new ForgeOperationError("unsupported");
}

/** Persist a send boundary and restore its prior proof if the transport positively refused dispatch. */
export async function sendMergeMutation(
  checkpoint: ForgeMergeCheckpoint | undefined,
  previous: ForgeMergeWriteStage,
  next: ForgeMergeWriteStage,
  send: () => Promise<unknown>,
) {
  await checkpoint?.(next);
  try {
    return await send();
  } catch (error) {
    // The transport distinguishes a deadline before fetch from a lost response.
    // A definitive 4xx on the native submission remains a recorded refusal.
    if (
      error instanceof ForgeOperationError &&
      !error.uncertain &&
      (error.status === undefined ||
        error.retryAt !== undefined ||
        next !== "submitting")
    )
      await checkpoint?.(previous);
    throw error;
  }
}
