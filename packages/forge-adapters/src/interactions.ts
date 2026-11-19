import type { ForgeType } from "@forge-adapters/src/types.js";

export type ForgeActor = { id: string; login: string };

/** An absent result permits read-only reconciliation of a potentially delayed vote. */
export type ForgeApprovalResult =
  "approved" | "absent" | "unsupported" | "stale" | "dismissed";

export type ForgeChange = {
  number: number;
  /** Only an explicit false from the provider authorizes an automatic review. */
  draft?: boolean;
  baseSha: string;
  headSha: string;
  mergeBase: string;
  startSha?: string;
  /** Source and target branch names captured with the immutable revision snapshot. */
  headBranch?: string;
  baseBranch?: string;
  title: string;
  url: string;
  author?: string;
};

export type ForgePullRequest = {
  number: number;
  /** Explicit readiness from the provider listing, when exposed by this forge version. */
  draft?: boolean;
  title: string;
  url: string;
  author?: string;
  headSha: string;
  baseSha: string;
  headBranch?: string;
  baseBranch?: string;
  updatedAt: string;
  state: "open";
};

/** Last durable boundary before a provider mutation, or its positive acknowledgement. */
export type ForgeMergeWriteStage =
  | "prepared"
  | "creating_check"
  | "submitting"
  | "armed"
  | "releasing"
  | "acknowledged";

/** Commit before sending the next mutation, independently of the worker's enclosing transaction. */
export type ForgeMergeCheckpoint = (
  stage: ForgeMergeWriteStage,
) => Promise<void>;

/** Trusted review authorization passed to a repository-bound adapter by the decision outbox. */
export type ForgeMergeRequest = {
  externalRepositoryId: string;
  number: number;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  method: "merge" | "squash" | "rebase";
  requirePassingChecks: boolean;
  reviewId: string;
  writeStage?: ForgeMergeWriteStage;
};

export type ForgeMergeState = {
  state:
    "ready" | "awaiting_checks" | "blocked" | "stale" | "scheduled" | "merged";
  reason: string;
  /** An acknowledged, owned schedule can resume publication of its missing revision check. */
  resume?: boolean;
  /** An exact pending App check and this App's active native request were both observed. */
  nativeArmed?: boolean;
  /** One pending App check for this exact PR and base belongs to this earlier review ID. */
  pendingCheckReviewId?: string;
  /** The provider permanently merged this PR with another revision or destination. */
  terminal?: boolean;
};

export type InlineComment = {
  path: string;
  lineStart: number;
  lineEnd: number;
  body: string;
  commentId?: string;
  threadId?: string;
};

export type ForgeComment = {
  id: string;
  createdAt?: string;
  body: string;
  user: ForgeActor;
  issue_url: string;
  pull_request_url: string;
};

export type ForgeReview = {
  id: string;
  body: string;
  user: ForgeActor;
  commit_id: string;
  state: string;
};

export type ForgeReviewComment = {
  id: string;
  body: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  user?: ForgeActor;
  resolver?: ForgeActor | null;
  commit_id?: string;
  threadId: string;
  resolved: boolean;
};

export type ForgePublicationProgress = Record<
  string,
  {
    id?: string;
    writing?: boolean;
    /** GitLab identity that owned the draft set when the bulk submission was fenced. */
    botId?: string;
    submitted?: boolean;
    /** The first complete draft listing that found an uncertain create absent during cleanup. */
    missingSince?: number;
    /** Evidence captured around the original GitLab bulk POST, never reconstructed from later reviewer state. */
    confirmation?:
      | "confirmed"
      | "revision-unconfirmed"
      | "verdict-unconfirmed"
      | "response-unconfirmed";
  }
>;

export type ForgeReviewPublication = {
  progress: ForgePublicationProgress;
  /** Full frozen result for the GitLab follow-up summary when the verdict is unconfirmed. */
  unconfirmedBody?: string;
  /** Persisted review snapshot to verify before submitting a native review. */
  revision?: ForgeChange;
  /** Automatic reviews must still be ready when the provider receives the review. */
  requireReady?: boolean;
  /** Serialize a new native verdict with changes to the policy that authorized it. */
  submit?<T>(write: () => Promise<T>): Promise<T>;
  /** Persist before each remote mutation; retain uncertain writes for reconciliation. */
  save(progress: ForgePublicationProgress): Promise<void>;
};

export type ForgeWebhook = { deliveryId: string; repositoryId: string } & (
  | { kind: "ping" }
  | { kind: "push"; ref: string }
  | { kind: "opened"; number: number; author: string; occurredAt?: string }
  | {
      kind: "reopened" | "ready" | "draft" | "updated" | "closed";
      number: number;
      occurredAt?: string;
    }
  | {
      kind: "comment";
      number: number;
      commentId: string;
      senderId: string;
      sender: string;
      body: string;
    }
);

export class ForgeOperationError extends Error {
  /** Expose a safe failure category and whether a remote write may have succeeded. */
  constructor(
    readonly reason:
      | "permission"
      | "unsupported"
      | "unavailable"
      | "diff-pending"
      | "invalid-response"
      | "change-closed",
    readonly uncertain = false,
    readonly status?: number,
    /** Earliest retry time (epoch milliseconds) after a confirmed provider rate-limit refusal. */
    readonly retryAt?: number,
  ) {
    super(`Forge operation: ${reason}`);
  }
}

export class ForgeWebhookError extends Error {
  /** Carry a safe ingress rejection without exposing the payload or signature. */
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** Read the reviewed revision immediately before a provider write and classify a rejected preflight as unsubmitted. */
export async function reviewRevision(
  forge: Forge,
  number: number,
  head: string,
  {
    revision,
    requireReady,
  }: Pick<ForgeReviewPublication, "revision" | "requireReady">,
) {
  try {
    const current = await forge.change(number);
    if (
      current.headSha !== head ||
      (requireReady && current.draft !== false) ||
      (revision &&
        (revision.headSha !== current.headSha ||
          revision.baseSha !== current.baseSha ||
          revision.mergeBase !== current.mergeBase ||
          revision.startSha !== current.startSha))
    )
      throw new ForgeOperationError("invalid-response");
    return current;
  } catch (error) {
    if (error instanceof ForgeOperationError) throw error;
    throw new ForgeOperationError("invalid-response");
  }
}

const temporaryStatusMarker = /^<!-- razbor:rev_[A-Za-z0-9]{16}:status -->$/;

const escalationReservationMarker =
  /^<!-- razbor:pr_[A-Za-z0-9]{16}:escalation-pending -->$/;

const escalationMarker = /^<!-- razbor:pr_[A-Za-z0-9]{16}:escalation -->$/;

/** Remove only a temporary review status or an unused escalation reservation, confirming a masked or repeated 404 by a complete change-scoped read. */
export async function removeTemporaryStatus(
  commentId: string,
  marker: string,
  remove: () => Promise<void>,
  list: () => Promise<{ id: string }[]>,
) {
  if (
    !temporaryStatusMarker.test(marker) &&
    !escalationReservationMarker.test(marker)
  )
    throw new ForgeOperationError("permission");
  await removeIfPresent(commentId, remove, list);
}

/** Confirm a masked or repeated DELETE's 404 against a successful complete, change-scoped read. */
export async function removeIfPresent(
  commentId: string,
  remove: () => Promise<void>,
  list: () => Promise<{ id: string }[]>,
) {
  try {
    await remove();
  } catch (error) {
    if (!(error instanceof ForgeOperationError && error.status === 404))
      throw error;
    if ((await list()).some((comment) => comment.id === commentId)) throw error;
  }
}

/** Check the exact returned ID, owner and trailing status marker before editing or deleting. */
export function verifyStatusComment(
  comment: { id: string; body: string; user: ForgeActor },
  commentId: string,
  botId: string,
  marker: string,
) {
  if (
    comment.id !== commentId ||
    comment.user.id !== botId ||
    (!temporaryStatusMarker.test(marker) &&
      !escalationReservationMarker.test(marker) &&
      !escalationMarker.test(marker)) ||
    !comment.body.endsWith(`\n${marker}`)
  )
    throw new ForgeOperationError("permission");
}

/** Repository-bound provider operations; arrays contain complete, bounded results. */
export interface Forge {
  readonly type: ForgeType;
  readonly label: string;
  readonly hookEvents: readonly string[];
  readonly capabilities: {
    resolveThreads: boolean;
    guardedMerge: "conditional" | "unsupported";
  };
  /** Read authoritative revisions, native restrictions, and the existing schedule without writing. */
  inspectMerge(request: ForgeMergeRequest): Promise<ForgeMergeState>;
  /** Inspect the reviewed revision for a bot vote independently of native merge configuration. */
  inspectApproval(
    request: ForgeMergeRequest,
    bot: ForgeActor,
  ): Promise<ForgeMergeState>;
  /** Reconcile this actor's vote, fencing a first submission immediately before the provider call. */
  approveReview(
    request: ForgeMergeRequest,
    bot: ForgeActor,
    reconcileOnly: boolean,
    beforeWrite: () => Promise<void>,
    acknowledged?: boolean,
  ): Promise<ForgeApprovalResult>;
  /** Revalidate immediately and schedule only a guarded, non-bypassing native operation. */
  scheduleMerge(
    request: ForgeMergeRequest,
    resumeOnly?: boolean,
    checkpoint?: ForgeMergeCheckpoint,
  ): Promise<"scheduled" | "merged">;
  /** Retire an owned authorization only where the provider offers a race-safe cancellation. */
  cancelMerge(
    request: ForgeMergeRequest,
  ): Promise<"cancelled" | "absent" | "unsupported">;
  /** Resolve a configured username to an individual provider account before mentioning it. */
  reviewerLogin(username: string): Promise<string | null>;
  /** Authenticate raw delivery bytes and normalize supported events; ignore unrelated events. */
  webhook(
    raw: Uint8Array,
    headers: Record<string, string | undefined>,
    secret: string,
  ): ForgeWebhook | undefined;
  /** Read the current authenticated actor. */
  identity(): Promise<ForgeActor>;
  /** List every open change within the request budget; reject incomplete pagination. */
  openChanges(): Promise<ForgePullRequest[]>;
  /** Read an open change and its exact source, target and merge-base revisions. */
  change(number: number): Promise<ForgeChange>;
  /** Re-read a triggering comment in the bound repository and change. */
  comment(commentId: string, number?: number): Promise<ForgeComment>;
  /** Read top-level change comments for marker reconciliation. */
  comments(
    number: number,
    options?: { complete: boolean },
  ): Promise<{ id: string; body: string; user: ForgeActor }[]>;
  /** Read published and pending reviews for marker and revision reconciliation. */
  reviews(number: number): Promise<ForgeReview[]>;
  /** Read review threads, including replies, in chronological order within each thread. */
  reviewComments(
    number: number,
    reviewId: string,
  ): Promise<ForgeReviewComment[]>;
  /** Ensure one acknowledgement reaction by this bot on the triggering comment. */
  react(commentId: string, botId: string, number?: number): Promise<void>;
  /** Create a top-level comment and return its exact provider ID. */
  postComment(number: number, body: string): Promise<string>;
  /** Replace only this review's bot-owned top-level status in the indicated change. */
  editStatusComment(
    number: number,
    id: string,
    botId: string,
    marker: string,
    body: string,
  ): Promise<void>;
  /** Delete the verified status comment, tolerating a previously completed deletion. */
  deleteStatusComment(
    number: number,
    id: string,
    botId: string,
    marker: string,
  ): Promise<void>;
  /** Reply in the identified original thread without creating a new finding. */
  replyToReview(
    number: number,
    reviewId: string,
    comment: InlineComment,
  ): Promise<string>;
  /** Publish a revision-bound review, persisting multi-step progress when required. */
  postReview(
    number: number,
    head: string,
    body: string,
    comments: InlineComment[],
    event: "COMMENT" | "REQUEST_CHANGES",
    publication?: ForgeReviewPublication,
  ): Promise<string>;
  /** Replace a bot-owned review recap without changing its revision or inline threads. */
  editReview(number: number, reviewId: string, body: string): Promise<void>;
  /** Read the current bounded unified diff for anchoring; callers recheck its revisions. */
  diff(number: number): Promise<string>;
  /** Remove only this run's unpublished drafts when publication becomes stale or fails. */
  discardPendingReview?(
    number: number,
    reviewId: string,
    progress: ForgePublicationProgress,
    save: ForgeReviewPublication["save"],
  ): Promise<void>;
  /** Resolve a known thread; unsupported providers must report that explicitly. */
  resolveThread(number: number, threadId: string): Promise<void>;
  /** Reconcile only the repository's saved or exact-callback webhook. */
  reconcileHook(
    callback: string,
    secret: string,
    enabled: boolean,
    ownedId: string | null,
  ): Promise<string | null>;
  /** Remove only the verified owned webhook, retaining unrelated hooks. */
  removeHook(callback: string, ownedId: string | null): Promise<void>;
}
