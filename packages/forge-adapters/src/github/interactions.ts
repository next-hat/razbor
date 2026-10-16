import { createHmac, timingSafeEqual } from "node:crypto";

import { parse } from "lossless-json";
import { z } from "zod";

import {
  approvedUrl,
  providerId,
  repositoryPath,
} from "@forge-adapters/src/http.js";
import {
  ForgeOperationError,
  ForgeWebhookError,
  type Forge,
  type ForgeChange,
  type ForgePullRequest,
  type ForgeReviewComment,
  type ForgeWebhook,
  type InlineComment,
} from "@forge-adapters/src/interactions.js";
import {
  HttpForgeTransport,
  webhookEndpoint,
} from "@forge-adapters/src/transport.js";
import type { ForgeConnection } from "@forge-adapters/src/types.js";

const id = providerId.pipe(z.string().regex(/^\d+$/));

const nodeId = z.string().min(1).max(256);

const user = z.object({ id, login: z.string() });

// GitHub authenticated actors always have decimal IDs. This reserved value
// preserves deleted-user history without matching any bot or signed sender.
const historicalUser = user.nullable().transform(
  (actor) =>
    actor ?? {
      id: "github:deleted",
      login: "[deleted]",
    },
);

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

const number = z.preprocess(
  (value) => Number(String(value)),
  z.number().int().positive().safe(),
);

const hook = z.object({
  id,
  name: z.string(),
  config: z.object({ url: z.string() }),
});

const reviewComment = z.object({
  id,
  node_id: nodeId,
  body: z.string(),
  path: z.string(),
  line: number.nullable().optional(),
  original_line: number.nullable().optional(),
  start_line: number.nullable().optional(),
  original_start_line: number.nullable().optional(),
  user: user.nullable(),
  commit_id: sha,
  pull_request_review_id: id.nullable(),
  in_reply_to_id: id.optional(),
});

const thread = z.object({
  id: nodeId,
  isResolved: z.boolean(),
  viewerCanResolve: z.boolean(),
  comments: z.object({ nodes: z.array(z.object({ id: nodeId })).max(1) }),
});

/** Authenticate the bounded GitHub payload using its SHA-256 signature. */
export function verifyGithubWebhook(
  raw: Uint8Array,
  signature: string | undefined,
  secret: string,
) {
  if (
    raw.byteLength > 1048576 ||
    !signature ||
    !/^sha256=[a-f0-9]{64}$/i.test(signature)
  )
    return false;
  return timingSafeEqual(
    createHmac("sha256", secret).update(raw).digest(),
    Buffer.from(signature.slice(7), "hex"),
  );
}

/** Extract newly created pull request issue comments with matching senders. */
export function parseGithubComment(raw: Uint8Array, event: string | undefined) {
  if (event !== "issue_comment") return undefined;
  const payload = z
    .object({
      action: z.string(),
      issue: z.object({ number, pull_request: z.unknown().optional() }),
      comment: z.object({
        id,
        body: z.string().max(65536),
        user: user.nullable(),
      }),
      repository: z.object({ id }),
      sender: user,
    })
    .parse(parse(Buffer.from(raw).toString("utf8")));
  if (
    payload.action !== "created" ||
    !payload.issue.pull_request ||
    !payload.comment.user ||
    payload.sender.id !== payload.comment.user.id ||
    payload.sender.login.toLowerCase() !==
      payload.comment.user.login.toLowerCase()
  )
    return undefined;
  return {
    repositoryId: payload.repository.id,
    senderId: payload.sender.id,
    sender: payload.sender.login,
    commentId: payload.comment.id,
    body: payload.comment.body,
    number: payload.issue.number,
  };
}

/** Extract repository and author identity for newly opened pull requests. */
export function parseGithubPullRequest(raw: Uint8Array) {
  const value = parse(Buffer.from(raw).toString("utf8"));
  if (z.object({ action: z.string() }).parse(value).action !== "opened")
    return undefined;
  const payload = z
    .object({
      repository: z.object({ id }),
      pull_request: z.object({ number, user: user.nullable() }),
    })
    .parse(value);
  if (!payload.pull_request.user) return undefined;
  return {
    repositoryId: payload.repository.id,
    number: payload.pull_request.number,
    author: payload.pull_request.user.login,
  };
}

/** Extract pushed refs while ignoring branch deletions and zero revisions. */
export function parseGithubPush(raw: Uint8Array) {
  const payload = z
    .object({
      ref: z.string(),
      after: sha,
      deleted: z.boolean().optional(),
      repository: z.object({ id }),
    })
    .parse(parse(Buffer.from(raw).toString("utf8")));
  if (payload.deleted || /^0+$/.test(payload.after)) return undefined;
  return { repositoryId: payload.repository.id, ref: payload.ref };
}

/** GitHub REST reviews and GraphQL thread operations for one repository. */
export class GithubForge implements Forge {
  readonly type = "github" as const;

  readonly label = "GitHub";

  readonly hookEvents = [
    "pull_request",
    "issue_comment",
    "pull_request_review_comment",
    "push",
  ] as const;

  readonly capabilities = { resolveThreads: true };

  private readonly route: string;

  private readonly owner: string;

  private readonly repository: string;

  private readonly transport: HttpForgeTransport;

  private readonly graphqlTransport: HttpForgeTransport;

  private readonly commentsCache = new Map<
    number,
    Promise<z.infer<typeof reviewComment>[]>
  >();

  private readonly threadsCache = new Map<
    number,
    Promise<z.infer<typeof thread>[]>
  >();

  /** Bind REST and GraphQL credentials to trusted origins under one deadline. */
  constructor(
    private readonly connection: ForgeConnection,
    selector: string,
    budgetMs = 20000,
  ) {
    if (connection.type !== "github")
      throw new ForgeOperationError("unsupported");
    this.route = `repos/${repositoryPath(selector)}`;
    [this.owner, this.repository] = selector.split("/") as [string, string];
    const headers = {
      Authorization: `Bearer ${connection.token ?? ""}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const base = approvedUrl(connection.apiUrl, connection.allowHttp);
    const graphqlBase = new URL(base);
    if (
      (base.hostname === "api.github.com" ||
        /^api\.[a-z0-9-]+\.ghe\.com$/.test(base.hostname)) &&
      base.pathname === "/"
    ) {
      graphqlBase.pathname = "/";
    } else if (/\/api\/v3\/?$/.test(base.pathname)) {
      graphqlBase.pathname = base.pathname.replace(/\/v3\/?$/, "");
    } else {
      throw new ForgeOperationError("invalid-response");
    }
    this.transport = new HttpForgeTransport(connection, headers, budgetMs);
    this.graphqlTransport = new HttpForgeTransport(
      { ...connection, apiUrl: graphqlBase.href },
      headers,
      budgetMs,
    );
  }

  /** Authenticate the raw delivery before extracting supported GitHub events. */
  webhook(
    raw: Uint8Array,
    headers: Record<string, string | undefined>,
    secret: string,
  ): ForgeWebhook | undefined {
    if (!verifyGithubWebhook(raw, headers["x-hub-signature-256"], secret))
      throw new ForgeWebhookError(401, "invalid webhook signature");
    const deliveryId = headers["x-github-delivery"];
    if (!deliveryId || !/^[A-Za-z0-9-]{1,200}$/.test(deliveryId))
      throw new ForgeWebhookError(400, "invalid webhook delivery");
    try {
      const event = headers["x-github-event"];
      if (event === "ping") {
        const value = z
          .object({ repository: z.object({ id }) })
          .parse(parse(Buffer.from(raw).toString("utf8")));
        return {
          kind: "ping",
          repositoryId: value.repository.id,
          deliveryId,
        };
      }
      if (event === "pull_request") {
        const value = parseGithubPullRequest(raw);
        return value ? { ...value, kind: "opened", deliveryId } : undefined;
      }
      if (event === "push") {
        const value = parseGithubPush(raw);
        return value ? { ...value, kind: "push", deliveryId } : undefined;
      }
      if (event === "pull_request_review_comment") {
        const value = z
          .object({
            action: z.string(),
            repository: z.object({ id }),
            pull_request: z.object({ number }),
            comment: z.object({
              id,
              body: z.string().max(65536),
              user: user.nullable(),
            }),
            sender: user,
          })
          .parse(parse(Buffer.from(raw).toString("utf8")));
        if (
          value.action !== "created" ||
          !value.comment.user ||
          value.sender.id !== value.comment.user.id ||
          value.sender.login.toLowerCase() !==
            value.comment.user.login.toLowerCase()
        )
          return undefined;
        return {
          kind: "comment",
          deliveryId,
          repositoryId: value.repository.id,
          number: value.pull_request.number,
          commentId: `review:${value.comment.id}`,
          senderId: value.sender.id,
          sender: value.sender.login,
          body: value.comment.body,
        };
      }
      const value = parseGithubComment(raw, event);
      return value ? { ...value, kind: "comment", deliveryId } : undefined;
    } catch (error) {
      if (error instanceof ForgeWebhookError) throw error;
      throw new ForgeWebhookError(400, "invalid webhook payload");
    }
  }

  /** Use the trusted App bot identity or read the personal token owner's identity. */
  async identity() {
    return user.parse(
      this.connection.githubAppBot ?? (await this.transport.request("user")),
    );
  }

  /** Read all open pull requests, checking repository links and complete bounded pagination. */
  async openChanges(): Promise<ForgePullRequest[]> {
    const result: ForgePullRequest[] = [];
    const seen = new Set<number>();
    const expected = approvedUrl(
      this.connection.webUrl,
      this.connection.allowHttp,
    );
    for (let page = 1; page <= 20; page++) {
      const pulls = z
        .array(
          z.object({
            number,
            state: z.literal("open"),
            title: z.string(),
            html_url: z.string().url(),
            user: user.nullable(),
            base: z.object({ sha, ref: z.string().min(1).max(1024) }),
            head: z.object({ sha, ref: z.string().min(1).max(1024) }),
            updated_at: z.string().datetime({ offset: true }),
          }),
        )
        .max(50)
        .parse(
          await this.transport.request(
            `${this.route}/pulls?state=open&sort=created&direction=asc&per_page=50&page=${page}`,
          ),
        );
      if (pulls.length === 0) return result;
      for (const pull of pulls) {
        const url = approvedUrl(pull.html_url, this.connection.allowHttp);
        if (
          seen.has(pull.number) ||
          url.origin !== expected.origin ||
          url.pathname !==
            `${expected.pathname.replace(/\/$/, "")}/${repositoryPath(`${this.owner}/${this.repository}`)}/pull/${pull.number}`
        )
          throw new ForgeOperationError("invalid-response");
        seen.add(pull.number);
        result.push({
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          author: pull.user?.login,
          headSha: pull.head.sha,
          baseSha: pull.base.sha,
          headBranch: pull.head.ref,
          baseBranch: pull.base.ref,
          updatedAt: pull.updated_at,
          state: "open",
        });
      }
    }
    throw new ForgeOperationError("invalid-response");
  }

  /** Validate pull request identity, reject closed or merged requests, and compare exact open revisions. */
  async change(n: number): Promise<ForgeChange> {
    number.parse(n);
    const pull = z
      .object({
        number,
        state: z.enum(["open", "closed"]),
        merged: z.boolean(),
        title: z.string(),
        html_url: z.string().url(),
        user: user.nullable(),
        base: z.object({ sha, ref: z.string().min(1).max(1024).optional() }),
        head: z.object({ sha, ref: z.string().min(1).max(1024).optional() }),
      })
      .parse(await this.transport.request(`${this.route}/pulls/${n}`));
    const expected = approvedUrl(
      this.connection.webUrl,
      this.connection.allowHttp,
    );
    const url = approvedUrl(pull.html_url, this.connection.allowHttp);
    if (
      pull.number !== n ||
      url.origin !== expected.origin ||
      url.pathname !==
        `${expected.pathname.replace(/\/$/, "")}/${repositoryPath(`${this.owner}/${this.repository}`)}/pull/${n}`
    )
      throw new ForgeOperationError("invalid-response");
    if (pull.state === "closed" || pull.merged)
      throw new ForgeOperationError("change-closed");
    const compared = z
      .object({ merge_base_commit: z.object({ sha }) })
      .parse(
        await this.transport.request(
          `${this.route}/compare/${pull.base.sha}...${pull.head.sha}?per_page=1`,
        ),
      );
    return {
      number: n,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      mergeBase: compared.merge_base_commit.sha,
      headBranch: pull.head.ref,
      baseBranch: pull.base.ref,
      title: pull.title,
      url: pull.html_url,
      author: pull.user?.login,
    };
  }

  /** Re-read a comment, verify its exact change location, and normalize inline links. */
  async comment(commentId: string, n?: number) {
    const inline = commentId.startsWith("review:");
    const providerCommentId = id.parse(inline ? commentId.slice(7) : commentId);
    const value = z
      .object({
        id,
        body: z.string(),
        user: user.nullable(),
        issue_url: z.string().default(""),
        pull_request_url: z.string().default(""),
      })
      .parse(
        await this.transport.request(
          `${this.route}/${inline ? "pulls" : "issues"}/comments/${providerCommentId}`,
        ),
      );
    if (value.id !== providerCommentId)
      throw new ForgeOperationError("invalid-response");
    if (!value.user) throw new ForgeOperationError("permission");
    if (n !== undefined) {
      number.parse(n);
      const api = approvedUrl(
        this.connection.apiUrl,
        this.connection.allowHttp,
      );
      const location = approvedUrl(
        inline ? value.pull_request_url : value.issue_url,
        this.connection.allowHttp,
      );
      if (
        location.origin !== api.origin ||
        location.pathname !==
          `${api.pathname.replace(/\/$/, "")}/${this.route}/${inline ? "pulls" : "issues"}/${n}`
      )
        throw new ForgeOperationError("invalid-response");
      if (inline) {
        const web = approvedUrl(
          this.connection.webUrl,
          this.connection.allowHttp,
        );
        value.pull_request_url = `${web.href.replace(/\/$/, "")}/${repositoryPath(`${this.owner}/${this.repository}`)}/pull/${n}`;
      }
    }
    return { ...value, id: commentId, user: value.user };
  }

  /** Read every top-level comment for publication marker reconciliation. */
  async comments(n: number) {
    return z
      .array(z.object({ id, body: z.string(), user: historicalUser }))
      .parse(await this.transport.list(`${this.route}/issues/${n}/comments`));
  }

  /** Read all native review states, including pending and dismissed reviews. */
  async reviews(n: number) {
    return z
      .array(
        z.object({
          id,
          body: z.string(),
          user: historicalUser,
          commit_id: sha,
          state: z.string(),
        }),
      )
      .parse(await this.transport.list(`${this.route}/pulls/${n}/reviews`));
  }

  /** Execute a GraphQL operation without logging provider error payloads. */
  private async graphql(
    query: string,
    variables: Record<string, unknown>,
    mutating = false,
  ) {
    const value = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.unknown()).optional(),
      })
      .safeParse(
        await this.graphqlTransport.request(
          "graphql",
          "POST",
          { query, variables },
          false,
          {},
          mutating,
        ),
      );
    if (!value.success || value.data.errors?.length || !value.data.data)
      throw new ForgeOperationError("invalid-response", mutating);
    return value.data.data;
  }

  /** Read complete thread roots and resolution state without deprecated integer IDs. */
  private async readThreads(n: number) {
    const all: z.infer<typeof thread>[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const value = z
        .object({
          repository: z.object({
            pullRequest: z.object({
              reviewThreads: z.object({
                nodes: z.array(thread),
                pageInfo: z.object({
                  hasNextPage: z.boolean(),
                  endCursor: z.string().nullable(),
                }),
              }),
            }),
          }),
        })
        .parse(
          await this.graphql(
            `query RazborThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 50, after: $after) {
                  nodes { id isResolved viewerCanResolve comments(first: 1) { nodes { id } } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
            { owner: this.owner, name: this.repository, number: n, after },
          ),
        );
      const result = value.repository.pullRequest.reviewThreads;
      all.push(...result.nodes);
      if (!result.pageInfo.hasNextPage) return all;
      if (!result.pageInfo.endCursor || result.pageInfo.endCursor === after)
        throw new ForgeOperationError("invalid-response");
      after = result.pageInfo.endCursor;
    }
    throw new ForgeOperationError("invalid-response");
  }

  /** Reuse complete thread reads within one repository-bound operation budget. */
  private threads(n: number) {
    let result = this.threadsCache.get(n);
    if (!result) {
      result = this.readThreads(n);
      this.threadsCache.set(n, result);
    }
    return result;
  }

  /** Read complete inline comments once, retaining replies from other review objects. */
  private allReviewComments(n: number) {
    let result = this.commentsCache.get(n);
    if (!result) {
      result = this.transport
        .list(`${this.route}/pulls/${n}/comments?sort=created&direction=asc`)
        .then((rows) => z.array(reviewComment).parse(rows));
      this.commentsCache.set(n, result);
    }
    return result;
  }

  /** Group roots from the requested review with every reply and native thread state. */
  async reviewComments(
    n: number,
    reviewId: string,
  ): Promise<ForgeReviewComment[]> {
    id.parse(reviewId);
    const rows = await this.allReviewComments(n);
    const roots = rows.filter(
      (row) => row.pull_request_review_id === reviewId && !row.in_reply_to_id,
    );
    if (!roots.length) return [];
    const threads = await this.threads(n);
    const result: ForgeReviewComment[] = [];
    for (const root of roots) {
      const nativeThread = threads.find(
        (candidate) => candidate.comments.nodes[0]?.id === root.node_id,
      );
      if (!nativeThread) throw new ForgeOperationError("invalid-response");
      for (const row of [
        root,
        ...rows.filter((candidate) => candidate.in_reply_to_id === root.id),
      ]) {
        result.push({
          id: `review:${row.id}`,
          body: row.body,
          path: row.path,
          lineStart:
            root.line != null
              ? (root.start_line ?? root.line)
              : (root.original_start_line ?? root.original_line ?? undefined),
          lineEnd: root.line ?? root.original_line ?? undefined,
          user: row.user ?? undefined,
          commit_id: row.commit_id,
          threadId: nativeThread.id,
          resolved: nativeThread.isResolved,
        });
      }
    }
    return result;
  }

  /** Add one thumbs-up reaction after checking the complete reaction history. */
  async react(commentId: string, botId: string) {
    const inline = commentId.startsWith("review:");
    const providerCommentId = id.parse(inline ? commentId.slice(7) : commentId);
    const route = `${this.route}/${inline ? "pulls" : "issues"}/comments/${providerCommentId}/reactions`;
    const reactions = z
      .array(z.object({ content: z.string(), user: user.nullable() }))
      .parse(await this.transport.list(route));
    if (
      !reactions.some(
        (reaction) => reaction.content === "+1" && reaction.user?.id === botId,
      )
    )
      await this.transport.request(route, "POST", { content: "+1" });
  }

  /** Create a remote resource and retain uncertainty if its ID cannot be decoded. */
  private async create(route: string, body: unknown) {
    const result = await this.transport.request(route, "POST", body);
    const decoded = z.object({ id }).safeParse(result);
    if (!decoded.success)
      throw new ForgeOperationError("invalid-response", true);
    return decoded.data.id;
  }

  /** Publish a top-level pull request comment and return its exact REST ID. */
  async postComment(n: number, body: string) {
    return this.create(`${this.route}/issues/${n}/comments`, { body });
  }

  /** Reply only to a root comment belonging to the requested review and thread. */
  async replyToReview(n: number, reviewId: string, comment: InlineComment) {
    const rows = await this.reviewComments(n, reviewId);
    const root = rows.find((row) => row.threadId === comment.threadId);
    if (!root || root.id !== comment.commentId)
      throw new ForgeOperationError("invalid-response");
    const result = await this.create(
      `${this.route}/pulls/${n}/comments/${id.parse(root.id.slice(7))}/replies`,
      { body: comment.body },
    );
    this.commentsCache.delete(n);
    return `review:${result}`;
  }

  /** Publish the summary and inclusive right-side ranges in one revision-bound review. */
  async postReview(
    n: number,
    head: string,
    body: string,
    comments: InlineComment[],
    event: "COMMENT" | "REQUEST_CHANGES",
  ) {
    sha.parse(head);
    const result = await this.create(`${this.route}/pulls/${n}/reviews`, {
      event,
      commit_id: head,
      body,
      comments: comments.map((comment) => ({
        path: comment.path,
        line: comment.lineEnd,
        side: "RIGHT",
        ...(comment.lineStart < comment.lineEnd
          ? { start_line: comment.lineStart, start_side: "RIGHT" }
          : {}),
        body: comment.body,
      })),
    });
    this.commentsCache.delete(n);
    this.threadsCache.delete(n);
    return result;
  }

  /** Replace a bot-owned native recap and confirm its body without altering inline threads. */
  async editReview(n: number, reviewId: string, body: string): Promise<void> {
    number.parse(n);
    id.parse(reviewId);
    const bot = await this.identity();
    const route = `${this.route}/pulls/${n}/reviews/${reviewId}`;
    const summary = z.object({ id, body: z.string(), user: historicalUser });
    const original = summary.parse(await this.transport.request(route));
    if (original.id !== reviewId || original.user.id !== bot.id)
      throw new ForgeOperationError("invalid-response");
    if (original.body === body) return;
    const updated = summary.parse(
      await this.transport.request(route, "PUT", { body }),
    );
    if (
      updated.id !== reviewId ||
      updated.user.id !== bot.id ||
      updated.body !== body
    )
      throw new ForgeOperationError("invalid-response");
    const confirmed = summary.parse(await this.transport.request(route));
    if (
      confirmed.id !== reviewId ||
      confirmed.user.id !== bot.id ||
      confirmed.body !== body
    )
      throw new ForgeOperationError("invalid-response");
  }

  /** Fetch GitHub's complete bounded unified diff for the current pull request. */
  async diff(n: number) {
    return z
      .string()
      .parse(
        await this.transport.request(
          `${this.route}/pulls/${n}`,
          "GET",
          undefined,
          true,
          { Accept: "application/vnd.github.v3.diff" },
        ),
      );
  }

  /** Resolve a thread only after verifying its membership in the bound pull request. */
  async resolveThread(n: number, threadId: string) {
    nodeId.parse(threadId);
    const nativeThread = (await this.threads(n)).find(
      (candidate) => candidate.id === threadId,
    );
    if (!nativeThread) throw new ForgeOperationError("invalid-response");
    if (nativeThread.isResolved) return;
    if (!nativeThread.viewerCanResolve)
      throw new ForgeOperationError("permission");
    const result = z
      .object({
        resolveReviewThread: z.object({
          thread: z.object({ id: nodeId, isResolved: z.literal(true) }),
        }),
      })
      .safeParse(
        await this.graphql(
          `mutation RazborResolve($threadId: ID!) {
        resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } }
      }`,
          { threadId },
          true,
        ),
      );
    if (
      !result.success ||
      result.data.resolveReviewThread.thread.id !== threadId
    )
      throw new ForgeOperationError("invalid-response", true);
    this.threadsCache.delete(n);
  }

  /** Reconcile only the saved or exact-callback repository webhook. */
  async reconcileHook(
    callback: string,
    secret: string,
    enabled: boolean,
    ownedId: string | null,
  ) {
    const endpoint = webhookEndpoint(callback);
    if (!endpoint) throw new ForgeOperationError("invalid-response");
    const hooks = z
      .array(hook)
      .parse(await this.transport.list(`${this.route}/hooks`));
    const matching = hooks.filter(
      (candidate) => candidate.config.url === callback,
    );
    if (matching.length > 1) throw new ForgeOperationError("invalid-response");
    const owned =
      (ownedId
        ? hooks.find((candidate) => candidate.id === ownedId)
        : undefined) ?? matching.find((candidate) => candidate.name === "web");
    if (
      owned &&
      (owned.name !== "web" ||
        (owned.config.url !== callback &&
          !(
            owned.id === ownedId &&
            webhookEndpoint(owned.config.url) === endpoint
          )))
    )
      throw new ForgeOperationError("invalid-response");
    if (!enabled && !owned) return null;
    const body = {
      name: "web",
      active: enabled,
      events: [...this.hookEvents],
      config: {
        url: callback,
        content_type: "json",
        secret,
        insecure_ssl: "0",
      },
    };
    const result = z
      .object({ id })
      .safeParse(
        await this.transport.request(
          `${this.route}/hooks${owned ? `/${owned.id}` : ""}`,
          owned ? "PATCH" : "POST",
          body,
        ),
      );
    if (!result.success)
      throw new ForgeOperationError("invalid-response", true);
    return result.data.id;
  }

  /** Delete the owned generated webhook, allowing callback base changes and prior deletion. */
  async removeHook(callback: string, ownedId: string | null) {
    const endpoint = webhookEndpoint(callback);
    if (!endpoint) throw new ForgeOperationError("invalid-response");
    try {
      const hooks = z
        .array(hook)
        .parse(await this.transport.list(`${this.route}/hooks`));
      const matching = hooks.filter(
        (candidate) => candidate.config.url === callback,
      );
      if (matching.length > 1)
        throw new ForgeOperationError("invalid-response");
      const owned =
        (ownedId
          ? hooks.find((candidate) => candidate.id === ownedId)
          : undefined) ??
        matching.find((candidate) => candidate.name === "web");
      if (!owned) return;
      if (
        owned.name !== "web" ||
        (owned.config.url !== callback &&
          !(
            owned.id === ownedId &&
            webhookEndpoint(owned.config.url) === endpoint
          ))
      )
        throw new ForgeOperationError("invalid-response");
      await this.transport.request(`${this.route}/hooks/${owned.id}`, "DELETE");
    } catch (error) {
      if (error instanceof ForgeOperationError && error.status === 404) return;
      throw error;
    }
  }
}
