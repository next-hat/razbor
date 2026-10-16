import { createHash, timingSafeEqual } from "node:crypto";

import { parse } from "lossless-json";
import { z } from "zod";

import { approvedUrl, providerId } from "@forge-adapters/src/http.js";
import {
  ForgeOperationError,
  ForgeWebhookError,
  type Forge,
  type ForgeChange,
  type ForgePullRequest,
  type ForgePublicationProgress,
  type ForgeReview,
  type ForgeReviewComment,
  type ForgeReviewPublication,
  type ForgeWebhook,
  type InlineComment,
} from "@forge-adapters/src/interactions.js";
import {
  HttpForgeTransport,
  webhookEndpoint,
} from "@forge-adapters/src/transport.js";
import type { ForgeConnection } from "@forge-adapters/src/types.js";

const id = providerId.pipe(z.string().regex(/^\d+$/));

const integer = z.preprocess(
  (value) => Number(String(value)),
  z.number().int().positive().safe(),
);

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i);

const actor = z.object({ id, username: z.string() });

const rangeLine = z.object({
  line_code: z.string().regex(/^[a-f0-9]{40}_\d+_\d+$/),
  type: z.enum(["old", "new"]).nullable(),
  new_line: integer.nullable().optional(),
  old_line: integer.nullable().optional(),
});

const lineRange = z.object({ start: rangeLine, end: rangeLine });

const position = z.object({
  new_path: z.string(),
  old_path: z.string(),
  new_line: integer.nullable().optional(),
  old_line: integer.nullable().optional(),
  line_range: lineRange.nullable().optional(),
  head_sha: sha,
  base_sha: sha,
  start_sha: sha,
});

const note = z.object({
  id,
  body: z.string(),
  author: actor,
  created_at: z.string().datetime({ offset: true }),
  system: z.boolean().optional(),
  position: position.nullable().optional(),
  resolved: z.boolean().optional(),
  resolvable: z.boolean().optional(),
  resolved_by: actor.nullable().optional(),
});

const discussion = z.object({
  id: z.string().min(1).max(256),
  notes: z.array(note),
});

const draft = z.object({
  id,
  author_id: id,
  note: z.string(),
  position: position.nullable().optional(),
});

const fileDiff = z.object({
  new_path: z.string(),
  old_path: z.string(),
  diff: z.string(),
  collapsed: z.boolean().optional(),
  too_large: z.boolean().optional(),
});

const reviewMetadata =
  /<!-- razbor-gitlab:([A-Za-z0-9_]+):([a-f0-9]{40}(?:[a-f0-9]{24})?):(COMMENT|REQUEST_CHANGES):(pending|complete) -->/;

/** Normalize a GitLab user without converting provider IDs to JavaScript numbers. */
function normalizeActor(value: z.infer<typeof actor>) {
  return { id: value.id, login: value.username };
}

/** Find a new-side diff line and its exact native line code, including context. */
function diffPosition(file: z.infer<typeof fileDiff>, line: number) {
  if (file.collapsed || file.too_large)
    throw new ForgeOperationError("invalid-response");
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const row of file.diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (row.startsWith("+") || row.startsWith(" ")) {
      if (newLine === line)
        return {
          new_line: line,
          ...(row.startsWith(" ") ? { old_line: oldLine } : {}),
          // Added lines omit old_line but their native code retains the diff cursor.
          line_code: `${createHash("sha1").update(file.new_path).digest("hex")}_${oldLine}_${newLine}`,
          type: row.startsWith("+") ? ("new" as const) : null,
        };
      newLine++;
    }
    if (row.startsWith("-") || row.startsWith(" ")) oldLine++;
  }
  throw new ForgeOperationError("invalid-response");
}

/** Build an inclusive new-side range with the last line as its native anchor. */
function commentPosition(
  file: z.infer<typeof fileDiff>,
  comment: InlineComment,
): Pick<z.infer<typeof position>, "new_line" | "old_line" | "line_range"> {
  const end = diffPosition(file, integer.parse(comment.lineEnd));
  const anchor = {
    new_line: end.new_line,
    ...(end.old_line !== undefined ? { old_line: end.old_line } : {}),
  };
  if (comment.lineStart === comment.lineEnd) return anchor;
  const start = diffPosition(file, integer.parse(comment.lineStart));
  return {
    ...anchor,
    line_range: {
      start,
      end,
    },
  };
}

/** Require the provider to retain both endpoints during draft and write reconciliation. */
function matchesCommentRange(
  actual: z.infer<typeof position> | null | undefined,
  comment: InlineComment,
) {
  if (!actual || actual.new_line !== comment.lineEnd) return false;
  const range = actual.line_range;
  return comment.lineStart === comment.lineEnd
    ? !range ||
        (range.start.type !== "old" &&
          range.end.type !== "old" &&
          range.start.new_line === comment.lineStart &&
          range.end.new_line === comment.lineEnd)
    : range != null &&
        range.start.type !== "old" &&
        range.end.type === "new" &&
        range.start.new_line === comment.lineStart &&
        range.end.new_line === comment.lineEnd;
}

/** Compare exact diff coordinates and codes before publishing a reconciled draft. */
function sameLineRange(
  actual: z.infer<typeof lineRange> | null | undefined,
  expected: z.infer<typeof lineRange> | null | undefined,
) {
  if (!expected) return !actual;
  if (!actual) return false;
  return (["start", "end"] as const).every(
    (key) =>
      actual[key].line_code === expected[key].line_code &&
      actual[key].type === expected[key].type &&
      actual[key].new_line === expected[key].new_line &&
      (actual[key].old_line ?? undefined) === expected[key].old_line,
  );
}

/** Confirm all diff revisions still match before continuing a multi-request publication. */
function sameRevision(expected: ForgeChange, actual: ForgeChange) {
  return (
    expected.headSha === actual.headSha &&
    expected.baseSha === actual.baseSha &&
    expected.mergeBase === actual.mergeBase &&
    expected.startSha === actual.startSha
  );
}

/** Bound and authenticate GitLab's legacy secret-token delivery mechanism. */
function verifyWebhook(
  raw: Uint8Array,
  token: string | undefined,
  secret: string,
) {
  if (raw.byteLength > 1048576 || !secret || !token) return false;
  const expected = Buffer.from(secret);
  const received = Buffer.from(token);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

/** GitLab merge-request reviews, discussions and managed project webhooks. */
export class GitlabForge implements Forge {
  readonly type = "gitlab" as const;

  readonly label = "GitLab";

  readonly hookEvents = ["merge_requests_events", "note_events", "push_events"];

  readonly capabilities = { resolveThreads: true };

  private readonly route: string;

  private readonly transport: HttpForgeTransport;

  /** Bind one project, credentials and a bounded total API-request budget. */
  constructor(
    private readonly connection: ForgeConnection,
    selector: string,
    budgetMs = 20000,
  ) {
    if (
      connection.type !== "gitlab" ||
      selector.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new ForgeOperationError("unsupported");
    this.route = `projects/${encodeURIComponent(selector)}`;
    this.transport = new HttpForgeTransport(
      connection,
      { "PRIVATE-TOKEN": connection.token ?? "" },
      budgetMs,
    );
  }

  /** Validate delivery identity and normalize only new MR comments, opens and pushes. */
  webhook(
    raw: Uint8Array,
    headers: Record<string, string | undefined>,
    secret: string,
  ): ForgeWebhook | undefined {
    if (!verifyWebhook(raw, headers["x-gitlab-token"], secret))
      throw new ForgeWebhookError(401, "invalid signature");
    const deliveryId =
      headers["webhook-id"] ??
      headers["idempotency-key"] ??
      headers["x-gitlab-webhook-uuid"];
    if (!deliveryId || !/^[A-Za-z0-9_-]{1,200}$/.test(deliveryId))
      throw new ForgeWebhookError(400, "invalid delivery ID");
    try {
      const value = parse(Buffer.from(raw).toString("utf8"));
      if (headers["x-gitlab-event"] === "Note Hook") {
        const kind = z
          .object({
            object_attributes: z.object({
              action: z.string(),
              noteable_type: z.string(),
            }),
          })
          .parse(value);
        if (
          kind.object_attributes.action !== "create" ||
          kind.object_attributes.noteable_type !== "MergeRequest"
        )
          return undefined;
        const payload = z
          .object({
            object_kind: z.literal("note"),
            project: z.object({ id }),
            user: actor,
            merge_request: z.object({ iid: integer }),
            object_attributes: z.object({
              id,
              note: z.string().max(65536),
              author_id: id,
              system: z.boolean().optional(),
            }),
          })
          .parse(value);
        if (
          payload.user.id !== payload.object_attributes.author_id ||
          payload.object_attributes.system
        )
          return undefined;
        return {
          kind: "comment",
          deliveryId,
          repositoryId: payload.project.id,
          number: payload.merge_request.iid,
          commentId: payload.object_attributes.id,
          senderId: payload.user.id,
          sender: payload.user.username,
          body: payload.object_attributes.note,
        };
      }
      if (headers["x-gitlab-event"] === "Merge Request Hook") {
        const action = z
          .object({ object_attributes: z.object({ action: z.string() }) })
          .parse(value);
        if (action.object_attributes.action !== "open") return undefined;
        const payload = z
          .object({
            object_kind: z.literal("merge_request"),
            project: z.object({ id }),
            user: actor,
            object_attributes: z.object({ iid: integer, author_id: id }),
          })
          .parse(value);
        if (payload.user.id !== payload.object_attributes.author_id)
          return undefined;
        return {
          kind: "opened",
          deliveryId,
          repositoryId: payload.project.id,
          number: payload.object_attributes.iid,
          author: payload.user.username,
        };
      }
      if (headers["x-gitlab-event"] === "Push Hook") {
        const payload = z
          .object({
            object_kind: z.literal("push"),
            project: z.object({ id }),
            after: sha,
            ref: z.string(),
          })
          .parse(value);
        if (/^0+$/.test(payload.after)) return undefined;
        return {
          kind: "push",
          deliveryId,
          repositoryId: payload.project.id,
          ref: payload.ref,
        };
      }
      return undefined;
    } catch {
      throw new ForgeWebhookError(400, "invalid webhook payload");
    }
  }

  /** Return the authenticated token owner's provider identity. */
  async identity() {
    return normalizeActor(actor.parse(await this.transport.request("user")));
  }

  /** List every open MR and its exact target tip without filtering by the token owner's reviews. */
  async openChanges(): Promise<ForgePullRequest[]> {
    const result: ForgePullRequest[] = [];
    const seen = new Set<number>();
    const targets = new Map<string, string>();
    const expected = approvedUrl(
      this.connection.webUrl,
      this.connection.allowHttp,
    );
    for (let page = 1; page <= 20; page++) {
      const pulls = z
        .array(
          z.object({
            iid: integer,
            state: z.literal("opened"),
            title: z.string(),
            web_url: z.string().url(),
            author: actor.nullable(),
            sha,
            source_branch: z.string().min(1).max(1024),
            target_branch: z.string().min(1).max(1024),
            updated_at: z.string().datetime({ offset: true }),
          }),
        )
        .max(50)
        .parse(
          await this.transport.request(
            `${this.route}/merge_requests?state=opened&scope=all&order_by=created_at&sort=asc&per_page=50&page=${page}`,
          ),
        );
      if (pulls.length === 0) return result;
      for (const pull of pulls) {
        const url = approvedUrl(pull.web_url, this.connection.allowHttp);
        if (seen.has(pull.iid) || url.origin !== expected.origin)
          throw new ForgeOperationError("invalid-response");
        seen.add(pull.iid);
        let baseSha = targets.get(pull.target_branch);
        if (!baseSha) {
          const target = z
            .object({ name: z.string(), commit: z.object({ id: sha }) })
            .parse(
              await this.transport.request(
                `${this.route}/repository/branches/${encodeURIComponent(pull.target_branch)}`,
              ),
            );
          if (target.name !== pull.target_branch)
            throw new ForgeOperationError("invalid-response");
          baseSha = target.commit.id;
          targets.set(pull.target_branch, baseSha);
        }
        result.push({
          number: pull.iid,
          title: pull.title,
          url: pull.web_url,
          author: pull.author?.username,
          headSha: pull.sha,
          baseSha,
          headBranch: pull.source_branch,
          baseBranch: pull.target_branch,
          updatedAt: pull.updated_at,
          state: "open",
        });
      }
    }
    throw new ForgeOperationError("invalid-response");
  }

  /** Build a route only from a positive, safely represented merge-request IID. */
  private changeRoute(n: number | undefined) {
    return `${this.route}/merge_requests/${integer.parse(n)}`;
  }

  /**
   * Authenticate MR identity before rejecting closed or merged state. Open
   * requests retain their diff-version triplet, live target tip and branch names.
   */
  async change(n: number): Promise<ForgeChange> {
    const response = await this.transport.request(this.changeRoute(n));
    const identity = z
      .object({
        iid: integer,
        project_id: id.optional(),
        state: z.enum(["opened", "closed", "merged", "locked"]),
        web_url: z.string().url(),
      })
      .parse(response);
    const expected = approvedUrl(
      this.connection.webUrl,
      this.connection.allowHttp,
    );
    const actual = approvedUrl(identity.web_url, this.connection.allowHttp);
    const selector = decodeURIComponent(this.route.slice("projects/".length));
    const repository = selector.split("/").map(encodeURIComponent).join("/");
    const path = `${expected.pathname.replace(/\/$/, "")}/${repository}`;
    // Numeric API selectors identify a project independently of its web namespace.
    const repositoryMatches = /^\d+$/.test(selector)
      ? identity.project_id === selector.replace(/^0+(?=\d)/, "")
      : [
          `${path}/-/merge_requests/${n}`,
          `${path}/merge_requests/${n}`,
        ].includes(actual.pathname);
    if (
      identity.iid !== n ||
      actual.origin !== expected.origin ||
      !repositoryMatches
    )
      throw new ForgeOperationError("invalid-response");
    if (identity.state === "closed" || identity.state === "merged")
      throw new ForgeOperationError("change-closed");
    const result = z
      .object({
        iid: integer,
        state: z.literal("opened"),
        title: z.string(),
        web_url: z.string().url(),
        author: actor,
        target_branch: z.string().min(1),
        source_branch: z.string().min(1).max(1024).optional(),
        diff_refs: z.object({ base_sha: sha, head_sha: sha, start_sha: sha }),
      })
      .parse(response);
    const target = z
      .object({
        name: z.string(),
        commit: z.object({ id: sha }),
      })
      .parse(
        await this.transport.request(
          `${this.route}/repository/branches/${encodeURIComponent(result.target_branch)}`,
        ),
      );
    if (target.name !== result.target_branch)
      throw new ForgeOperationError("invalid-response");
    return {
      number: n,
      title: result.title,
      url: result.web_url,
      author: result.author.username,
      baseSha: target.commit.id,
      headSha: result.diff_refs.head_sha,
      mergeBase: result.diff_refs.base_sha,
      startSha: result.diff_refs.start_sha,
      headBranch: result.source_branch,
      baseBranch: result.target_branch,
    };
  }

  /** Re-read a triggering note from the exact merge request before authorizing commands. */
  async comment(commentId: string, n?: number) {
    const result = note.parse(
      await this.transport.request(
        `${this.changeRoute(n)}/notes/${id.parse(commentId)}`,
      ),
    );
    if (result.id !== commentId)
      throw new ForgeOperationError("invalid-response");
    const location = (await this.change(integer.parse(n))).url;
    return {
      id: result.id,
      body: result.body,
      user: normalizeActor(result.author),
      issue_url: location,
      pull_request_url: location,
    };
  }

  /** Read ordinary MR notes in chronological order for summary and command reconciliation. */
  async comments(n: number) {
    const notes = z
      .array(note)
      .parse(
        await this.transport.list(
          `${this.changeRoute(n)}/notes?sort=asc&order_by=created_at`,
        ),
      );
    return notes
      .filter((item) => !item.system)
      .map((item) => ({
        id: item.id,
        body: item.body,
        user: normalizeActor(item.author),
      }));
  }

  /** Reconstruct durable reviews from revision-bound summary notes, preserving pending writes. */
  async reviews(n: number): Promise<ForgeReview[]> {
    const notes = await this.comments(n);
    return notes.flatMap((item) => {
      const metadata = reviewMetadata.exec(item.body);
      if (!metadata) return [];
      return [
        {
          ...item,
          commit_id: metadata[2]!,
          state: metadata[4] === "complete" ? metadata[3]! : "PENDING",
        },
      ];
    });
  }

  /** Read bounded complete discussions; preserve provider order within each thread. */
  private async discussions(n: number) {
    return z
      .array(discussion)
      .parse(await this.transport.list(`${this.changeRoute(n)}/discussions`));
  }

  /** Associate inline roots and replies with their review summary's stable run marker. */
  async reviewComments(
    n: number,
    reviewId: string,
  ): Promise<ForgeReviewComment[]> {
    const review = (await this.reviews(n)).find((item) => item.id === reviewId);
    const metadata = review && reviewMetadata.exec(review.body);
    if (!review || !metadata) throw new ForgeOperationError("invalid-response");
    const marker = `<!-- razbor:${metadata[1]}:`;
    const threads = await this.discussions(n);
    return threads.flatMap((thread) => {
      const root = thread.notes[0];
      if (
        !root?.position ||
        root.author.id !== review.user.id ||
        !root.body.includes(marker)
      )
        return [];
      return [...thread.notes]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((item) => ({
          id: item.id,
          body: item.body,
          user: normalizeActor(item.author),
          path: root.position!.new_path,
          lineStart:
            root.position!.line_range?.start.new_line ??
            root.position!.new_line ??
            undefined,
          lineEnd:
            root.position!.line_range?.end.new_line ??
            root.position!.new_line ??
            undefined,
          commit_id: root.position!.head_sha,
          threadId: thread.id,
          resolved: root.resolved === true,
          resolver: root.resolved_by ? normalizeActor(root.resolved_by) : null,
        }));
    });
  }

  /** Ensure one thumbs-up award by this bot on the triggering merge-request note. */
  async react(commentId: string, botId: string, n?: number) {
    const route = `${this.changeRoute(n)}/notes/${id.parse(commentId)}/award_emoji`;
    const awards = z
      .array(z.object({ name: z.string(), user: actor }))
      .parse(await this.transport.list(route));
    if (
      !awards.some(
        (award) => award.name === "thumbsup" && award.user.id === botId,
      )
    )
      await this.transport.request(route, "POST", { name: "thumbsup" });
  }

  /** Publish one ordinary note and preserve its lossless GitLab ID. */
  async postComment(n: number, body: string) {
    return z.object({ id }).parse(
      await this.transport.request(`${this.changeRoute(n)}/notes`, "POST", {
        body,
      }),
    ).id;
  }

  /** Reply in the verified original discussion, never a new inline location. */
  async replyToReview(n: number, reviewId: string, comment: InlineComment) {
    const thread = (await this.reviewComments(n, reviewId)).find(
      (item) =>
        item.threadId === comment.threadId &&
        (!comment.commentId || item.id === comment.commentId),
    );
    if (!thread) throw new ForgeOperationError("invalid-response");
    return z
      .object({ id })
      .parse(
        await this.transport.request(
          `${this.changeRoute(n)}/discussions/${encodeURIComponent(thread.threadId)}/notes`,
          "POST",
          { body: comment.body },
        ),
      ).id;
  }

  /** GitLab returns all the current user's drafts in one unpaginated, bounded response. */
  private async drafts(n: number) {
    return z
      .array(draft)
      .max(1000)
      .parse(
        await this.transport.request(`${this.changeRoute(n)}/draft_notes`),
      );
  }

  /** Read the explicit reviewer state, not the user-account state on the MR resource. */
  private async reviewerState(n: number, botId: string) {
    const reviewers = z
      .array(z.object({ user: actor, state: z.string() }))
      .max(1000)
      .parse(await this.transport.request(`${this.changeRoute(n)}/reviewers`));
    return reviewers.find((item) => item.user.id === botId)?.state;
  }

  /**
   * Publish only this run's drafts, checkpointing each write and making the
   * summary final only after notes and the native reviewer state are verified.
   * An ambiguous absent write is never recreated automatically.
   */
  async postReview(
    n: number,
    head: string,
    body: string,
    comments: InlineComment[],
    event: "COMMENT" | "REQUEST_CHANGES",
    publication?: ForgeReviewPublication,
  ) {
    const run = /<!-- razbor:([A-Za-z0-9_]+):result -->/.exec(body)?.[1];
    if (!publication || !run) throw new ForgeOperationError("invalid-response");
    sha.parse(head);
    const bot = await this.identity();
    const metadata = `<!-- razbor-gitlab:${run}:${head}:${event}:`;
    const pendingBody = `${body}\n\n${metadata}pending -->`;
    const completeBody = `${body}\n\n${metadata}complete -->`;
    const state =
      event === "REQUEST_CHANGES" ? "requested_changes" : "reviewed";
    let summaries = (await this.comments(n)).filter(
      (item) => item.user.id === bot.id && item.body.includes(metadata),
    );
    if (summaries.length > 1)
      throw new ForgeOperationError("invalid-response", true);
    if (summaries[0]?.body === completeBody) return summaries[0].id;
    const current = await this.change(n);
    if (current.headSha !== head)
      throw new ForgeOperationError("invalid-response");
    const progress = { ...publication.progress };
    const expected = comments.map((comment, index) => ({
      comment,
      key: `draft-${index}`,
      body: `${comment.body}\n\n<!-- razbor-gitlab-draft:${run}:${index}:${head} -->`,
    }));
    let drafts = await this.drafts(n);
    if (
      drafts.some(
        (item) =>
          item.author_id !== bot.id ||
          !expected.some((entry) => entry.body === item.note),
      )
    )
      throw new ForgeOperationError("invalid-response");
    if (!summaries.length && !progress.bulk?.writing) {
      const files = comments.length
        ? z
            .array(fileDiff)
            .parse(await this.transport.list(`${this.changeRoute(n)}/diffs`))
        : [];
      for (const entry of expected) {
        const candidates = drafts.filter((item) => item.note === entry.body);
        if (candidates.length > 1)
          throw new ForgeOperationError("invalid-response", true);
        const file = files.find((item) => item.new_path === entry.comment.path);
        if (!file) throw new ForgeOperationError("invalid-response");
        const anchor = commentPosition(file, entry.comment);
        let remote = candidates[0];
        if (!remote) {
          if (progress[entry.key]?.writing || progress[entry.key]?.id)
            throw new ForgeOperationError("unavailable", true);
          if (!sameRevision(current, await this.change(n)))
            throw new ForgeOperationError("invalid-response");
          progress[entry.key] = { writing: true };
          await publication.save(progress);
          try {
            remote = draft.parse(
              await this.transport.request(
                `${this.changeRoute(n)}/draft_notes`,
                "POST",
                {
                  note: entry.body,
                  position: {
                    position_type: "text",
                    base_sha: current.mergeBase,
                    start_sha: current.startSha,
                    head_sha: head,
                    old_path: file.old_path,
                    new_path: file.new_path,
                    ...anchor,
                  },
                },
              ),
            );
          } catch (error) {
            if (error instanceof ForgeOperationError && !error.uncertain) {
              progress[entry.key] = {};
              await publication.save(progress);
              throw error;
            }
            throw new ForgeOperationError("unavailable", true);
          }
          drafts.push(remote);
        }
        if (
          remote.author_id !== bot.id ||
          remote.note !== entry.body ||
          remote.position?.head_sha !== head ||
          remote.position.new_path !== entry.comment.path ||
          remote.position.old_path !== file.old_path ||
          remote.position.base_sha !== current.mergeBase ||
          remote.position.start_sha !== current.startSha ||
          !matchesCommentRange(remote.position, entry.comment) ||
          (remote.position.old_line ?? undefined) !== anchor.old_line ||
          !sameLineRange(remote.position.line_range, anchor.line_range)
        )
          throw new ForgeOperationError("invalid-response", true);
        progress[entry.key] = { id: remote.id };
        await publication.save(progress);
      }
      // Bulk publication affects every draft belonging to this identity. Re-read
      // immediately before publishing and reject any unowned concurrent draft.
      drafts = await this.drafts(n);
      if (
        drafts.length !== expected.length ||
        drafts.some(
          (item) =>
            !expected.some(
              (entry) =>
                progress[entry.key]?.id === item.id &&
                entry.body === item.note &&
                item.author_id === bot.id &&
                item.position?.head_sha === head &&
                item.position.base_sha === current.mergeBase &&
                item.position.start_sha === current.startSha &&
                item.position.new_path === entry.comment.path &&
                matchesCommentRange(item.position, entry.comment),
            ),
        )
      )
        throw new ForgeOperationError("invalid-response");
      if (!sameRevision(current, await this.change(n)))
        throw new ForgeOperationError("invalid-response");
      progress.bulk = { writing: true };
      await publication.save(progress);
      try {
        await this.transport.request(
          `${this.changeRoute(n)}/draft_notes/bulk_publish`,
          "POST",
          { note: pendingBody, reviewer_state: state },
        );
      } catch (error) {
        if (
          error instanceof ForgeOperationError &&
          [401, 403, 404, 405].includes(error.status ?? 0)
        ) {
          progress.bulk = {};
          await publication.save(progress);
          throw error;
        }
        throw new ForgeOperationError("unavailable", true);
      }
      summaries = (await this.comments(n)).filter(
        (item) => item.user.id === bot.id && item.body.includes(metadata),
      );
    }
    const summary = summaries[0];
    if (summaries.length !== 1 || summary?.body !== pendingBody)
      throw new ForgeOperationError("unsupported", true);
    const remaining = await this.drafts(n);
    if (
      remaining.some((item) =>
        expected.some((entry) => entry.body === item.note),
      )
    )
      throw new ForgeOperationError("unavailable", true);
    const threads = await this.discussions(n);
    for (const entry of expected) {
      const published = threads
        .flatMap((thread) => thread.notes)
        .filter(
          (item) =>
            item.author.id === bot.id &&
            item.body === entry.body &&
            item.position?.head_sha === head &&
            item.position.new_path === entry.comment.path &&
            matchesCommentRange(item.position, entry.comment),
        );
      if (published.length !== 1)
        throw new ForgeOperationError("invalid-response", true);
    }
    if ((await this.reviewerState(n, bot.id)) !== state)
      throw new ForgeOperationError("unsupported", true);
    if (!sameRevision(current, await this.change(n)))
      throw new ForgeOperationError("invalid-response", true);
    progress.summary = { id: summary.id, writing: true };
    await publication.save(progress);
    const finalized = note.parse(
      await this.transport.request(
        `${this.changeRoute(n)}/notes/${summary.id}`,
        "PUT",
        { body: completeBody },
      ),
    );
    if (
      finalized.id !== summary.id ||
      finalized.body !== completeBody ||
      finalized.author.id !== bot.id
    )
      throw new ForgeOperationError("invalid-response", true);
    progress.summary = { id: summary.id };
    progress.bulk = { id: summary.id };
    await publication.save(progress);
    return summary.id;
  }

  /**
   * Replace a bot-owned summary note while retaining its original completed
   * review metadata, so prior revision and inline-thread associations survive.
   */
  async editReview(n: number, reviewId: string, body: string): Promise<void> {
    const route = `${this.changeRoute(n)}/notes/${id.parse(reviewId)}`;
    const bot = await this.identity();
    const original = note.parse(await this.transport.request(route));
    const metadata = reviewMetadata.exec(original.body);
    if (
      original.id !== reviewId ||
      original.author.id !== bot.id ||
      original.system ||
      !metadata ||
      metadata[4] !== "complete"
    )
      throw new ForgeOperationError("invalid-response");
    const completeBody = `${body}\n\n${metadata[0]}`;
    if (original.body === completeBody) return;
    const updated = note.parse(
      await this.transport.request(route, "PUT", { body: completeBody }),
    );
    if (
      updated.id !== reviewId ||
      updated.author.id !== bot.id ||
      updated.body !== completeBody
    )
      throw new ForgeOperationError("invalid-response");
    const confirmed = note.parse(await this.transport.request(route));
    if (
      confirmed.id !== reviewId ||
      confirmed.author.id !== bot.id ||
      confirmed.body !== completeBody
    )
      throw new ForgeOperationError("invalid-response");
  }

  /**
   * Delete only this run's unpublished bot-authored drafts after a review
   * becomes stale. A saved ID or uncertain draft step plus the exact trailing
   * run marker proves ownership; published discussions are never touched.
   */
  async discardPendingReview(
    n: number,
    reviewPublicId: string,
    progress: ForgePublicationProgress,
  ) {
    if (!/^[A-Za-z0-9_]+$/.test(reviewPublicId))
      throw new ForgeOperationError("invalid-response");
    const bot = await this.identity();
    const marker = new RegExp(
      `<!-- razbor-gitlab-draft:${reviewPublicId}:(\\d+):[a-f0-9]{40}(?:[a-f0-9]{24})? -->$`,
    );
    for (const item of await this.drafts(n)) {
      const match = marker.exec(item.note);
      if (!match || item.author_id !== bot.id) continue;
      const step = progress[`draft-${match[1]}`];
      if (!step || !(step.id === item.id || (!step.id && step.writing)))
        continue;
      try {
        await this.transport.request(
          `${this.changeRoute(n)}/draft_notes/${item.id}`,
          "DELETE",
        );
      } catch (error) {
        if (error instanceof ForgeOperationError && error.status === 404)
          continue;
        throw error;
      }
    }
  }

  /** Read GitLab's unified diff without following a web redirect. */
  async diff(n: number) {
    return z
      .string()
      .parse(
        await this.transport.request(
          `${this.changeRoute(n)}/raw_diffs`,
          "GET",
          undefined,
          true,
        ),
      );
  }

  /** Resolve a known native discussion and verify the provider returned resolved notes. */
  async resolveThread(n: number, threadId: string) {
    const result = discussion.parse(
      await this.transport.request(
        `${this.changeRoute(n)}/discussions/${encodeURIComponent(threadId)}`,
        "PUT",
        { resolved: true },
      ),
    );
    if (
      result.id !== threadId ||
      !result.notes.length ||
      !result.notes.every(
        (item) => item.resolvable !== true || item.resolved === true,
      ) ||
      !result.notes.some((item) => item.resolved === true)
    )
      throw new ForgeOperationError("invalid-response", true);
  }

  /** Verify saved-hook ownership, allowing callback base URL changes only for its stable endpoint. */
  private async ownedHook(callback: string, ownedId: string | null) {
    const endpoint = webhookEndpoint(callback);
    if (!endpoint) throw new ForgeOperationError("invalid-response");
    const hooks = z
      .array(z.object({ id, url: z.string() }))
      .parse(await this.transport.list(`${this.route}/hooks`));
    const matches = hooks.filter((hook) => hook.url === callback);
    if (matches.length > 1) throw new ForgeOperationError("invalid-response");
    const owned =
      (ownedId ? hooks.find((hook) => hook.id === ownedId) : undefined) ??
      matches[0];
    if (
      owned &&
      owned.url !== callback &&
      !(owned.id === ownedId && webhookEndpoint(owned.url) === endpoint)
    )
      throw new ForgeOperationError("invalid-response");
    return owned;
  }

  /** Register the dedicated project callback using GitLab's broadly supported secret token. */
  async reconcileHook(
    callback: string,
    secret: string,
    enabled: boolean,
    ownedId: string | null,
  ) {
    const owned = await this.ownedHook(callback, ownedId);
    if (!enabled && !owned) return null;
    return z.object({ id }).parse(
      await this.transport.request(
        `${this.route}/hooks${owned ? `/${owned.id}` : ""}`,
        owned ? "PUT" : "POST",
        {
          url: callback,
          token: secret,
          enable_ssl_verification: true,
          push_events: enabled,
          merge_requests_events: enabled,
          note_events: enabled,
          confidential_note_events: false,
          issues_events: false,
          confidential_issues_events: false,
          tag_push_events: false,
          job_events: false,
          pipeline_events: false,
          wiki_page_events: false,
          deployment_events: false,
          releases_events: false,
        },
      ),
    ).id;
  }

  /** Remove only this repository's verified webhook, treating a missing hook as already removed. */
  async removeHook(callback: string, ownedId: string | null) {
    try {
      const owned = await this.ownedHook(callback, ownedId);
      if (owned)
        await this.transport.request(
          `${this.route}/hooks/${owned.id}`,
          "DELETE",
        );
    } catch (error) {
      if (error instanceof ForgeOperationError && error.status === 404) return;
      throw error;
    }
  }
}
