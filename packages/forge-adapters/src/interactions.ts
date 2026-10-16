import type { ForgeType } from "@forge-adapters/src/types.js";

export type ForgeActor = { id: string; login: string };

export type ForgeChange = {
  number: number;
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
  { id?: string; writing?: boolean }
>;

export type ForgeReviewPublication = {
  progress: ForgePublicationProgress;
  /** Persist before each remote mutation; retain uncertain writes for reconciliation. */
  save(progress: ForgePublicationProgress): Promise<void>;
};

export type ForgeWebhook = { deliveryId: string; repositoryId: string } & (
  | { kind: "ping" }
  | { kind: "push"; ref: string }
  | { kind: "opened"; number: number; author: string }
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
      | "invalid-response"
      | "change-closed",
    readonly uncertain = false,
    readonly status?: number,
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

/** Repository-bound provider operations; arrays contain complete, bounded results. */
export interface Forge {
  readonly type: ForgeType;
  readonly label: string;
  readonly hookEvents: readonly string[];
  readonly capabilities: { resolveThreads: boolean };
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
