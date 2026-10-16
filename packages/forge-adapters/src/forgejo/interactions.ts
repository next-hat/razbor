import { createHmac, timingSafeEqual } from "node:crypto";

import { parse } from "lossless-json";
import { z } from "zod";

import {
  approvedUrl,
  providerId,
  repositoryPath,
} from "@forge-adapters/src/http.js";
import type { ForgeConnection } from "@forge-adapters/src/types.js";
import {
  ForgeOperationError,
  ForgeWebhookError,
  type Forge,
  type ForgeChange,
  type ForgePullRequest,
  type ForgeWebhook,
  type InlineComment,
} from "@forge-adapters/src/interactions.js";

export { ForgeOperationError } from "@forge-adapters/src/interactions.js";

export type { InlineComment } from "@forge-adapters/src/interactions.js";

const id = providerId.pipe(z.string().regex(/^\d+$/));

const user = z.object({ id, login: z.string() });

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

const number = z.preprocess(
  (v) => Number(String(v)),
  z.number().int().positive().safe(),
);

/**
 * Verify the bounded raw payload's SHA-256 HMAC with constant-time digest
 * comparison; reject malformed signatures before comparison.
 */
export function verifyForgejoWebhook(
  raw: Uint8Array,
  signature: string | undefined,
  secret: string,
) {
  if (
    raw.byteLength > 1048576 ||
    !signature ||
    !/^[a-f0-9]{64}$/i.test(signature)
  )
    return false;
  return timingSafeEqual(
    createHmac("sha256", secret).update(raw).digest(),
    Buffer.from(signature, "hex"),
  );
}

/**
 * Extract newly created pull request comments only when the declared sender
 * matches the comment author; return undefined for unrelated events.
 */
export function parseForgejoComment(
  raw: Uint8Array,
  event: string | undefined,
) {
  if (event !== "issue_comment") return undefined;
  const payload = z
    .object({
      action: z.string(),
      is_pull: z.boolean().optional(),
      issue: z.object({ number, pull_request: z.unknown().optional() }),
      comment: z.object({ id, body: z.string().max(65536), user }),
      repository: z.object({ id }),
      sender: user,
    })
    .parse(parse(Buffer.from(raw).toString("utf8")));
  if (
    payload.action !== "created" ||
    !(payload.is_pull === true || payload.issue.pull_request)
  )
    return undefined;
  if (payload.sender.id !== payload.comment.user.id) return undefined;
  return {
    repositoryId: payload.repository.id,
    senderId: payload.sender.id,
    sender: payload.sender.login,
    commentId: payload.comment.id,
    body: payload.comment.body,
    number: payload.issue.number,
  };
}

/**
 * Extract repository, pull request and author identity from an opened event,
 * ignoring other actions.
 */
export function parseForgejoPullRequest(raw: Uint8Array) {
  const value = parse(Buffer.from(raw).toString("utf8"));
  if (z.object({ action: z.string() }).parse(value).action !== "opened")
    return undefined;
  const payload = z
    .object({
      repository: z.object({ id }),
      pull_request: z.object({ number, user }),
    })
    .parse(value);
  return {
    repositoryId: payload.repository.id,
    number: payload.pull_request.number,
    author: payload.pull_request.user.login,
  };
}

/**
 * Extract a validated pushed ref, ignoring deleted refs and all-zero deletion
 * revisions.
 */
export function parseForgejoPush(raw: Uint8Array) {
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

export type ForgejoChange = ForgeChange;

/**
 * Recognize the stable razbor hook path within an approved HTTPS callback
 * URL, returning undefined when invalid.
 */
function webhookEndpoint(value: string) {
  try {
    return /\/webhooks\/hook_[A-Za-z0-9]{16}$/.exec(
      approvedUrl(value, false).pathname,
    )?.[0];
  } catch {
    return undefined;
  }
}

/**
 * Classify provider statuses as permission, unsupported operation or temporary
 * availability failures.
 */
function responseErrorReason(status: number) {
  if (status === 401 || status === 403) return "permission";
  if (status === 404 || status === 405) return "unsupported";
  return "unavailable";
}

/**
 * Read at most four megabytes of provider response data, marking oversized
 * mutation responses as uncertain outcomes.
 */
async function readResponseBody(response: Response, mutating: boolean) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body)
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1048576)
        throw new ForgeOperationError("invalid-response", mutating);
      chunks.push(chunk);
    }
  return Buffer.concat(chunks).toString("utf8");
}

export class ForgejoInteractions implements Forge {
  readonly type = "forgejo" as const;

  readonly label = "Forgejo";

  readonly hookEvents = ["pull_request", "pull_request_comment", "push"];

  readonly capabilities = { resolveThreads: false };

  private readonly route: string;

  private readonly deadline: number;
  /**
   * Bind interactions to one Forgejo repository and establish a shared time
   * budget for its requests.
   */
  constructor(
    private readonly connection: ForgeConnection,
    selector: string,
    budgetMs = 20000,
  ) {
    this.deadline = Date.now() + budgetMs;
    if (connection.type !== "forgejo")
      throw new ForgeOperationError("unsupported");
    this.route = `repos/${repositoryPath(selector)}`;
  }

  /** Verify the original bytes and delivery identity before normalizing Forgejo events. */
  webhook(
    raw: Uint8Array,
    headers: Record<string, string | undefined>,
    secret: string,
  ): ForgeWebhook | undefined {
    if (!verifyForgejoWebhook(raw, headers["x-forgejo-signature"], secret))
      throw new ForgeWebhookError(401, "invalid-signature");
    const deliveryId = headers["x-forgejo-delivery"];
    if (!deliveryId || !/^[a-zA-Z0-9_-]{1,128}$/.test(deliveryId))
      throw new ForgeWebhookError(400, "invalid-delivery-id");
    if (headers["x-forgejo-event"] === "push") {
      const event = parseForgejoPush(raw);
      return event ? { ...event, deliveryId, kind: "push" } : undefined;
    }
    if (headers["x-forgejo-event"] === "pull_request") {
      const event = parseForgejoPullRequest(raw);
      return event ? { ...event, deliveryId, kind: "opened" } : undefined;
    }
    const event = parseForgejoComment(raw, headers["x-forgejo-event"]);
    return event ? { ...event, deliveryId, kind: "comment" } : undefined;
  }

  /** Forgejo's supported REST API has no operation for resolving an inline thread. */
  async resolveThread(): Promise<void> {
    throw new ForgeOperationError("unsupported");
  }
  /**
   * Send a bounded request within the approved API prefix and shared deadline;
   * disable redirects and preserve uncertainty when mutations may have reached
   * the provider.
   */
  private async request(
    route: string,
    method = "GET",
    body?: unknown,
    text = false,
  ): Promise<unknown> {
    const base = approvedUrl(this.connection.apiUrl, this.connection.allowHttp);
    const url = new URL(`${base.href.replace(/\/$/, "")}/${route}`);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)
    )
      throw new ForgeOperationError("invalid-response");
    const mutating = method !== "GET";
    try {
      const response = await fetch(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(
            1,
            Math.min(
              this.connection.timeoutMs ?? 5000,
              this.deadline - Date.now(),
            ),
          ),
        ),
        headers: {
          Authorization: `token ${this.connection.token ?? ""}`,
          Accept: text ? "text/plain" : "application/json",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ForgeOperationError(
          responseErrorReason(response.status),
          mutating && response.status >= 500,
          response.status,
        );
      }
      const raw = await readResponseBody(response, mutating);
      if (text) return raw;
      try {
        return raw ? parse(raw) : null;
      } catch {
        // A completed response with invalid JSON is distinct from a transport
        // failure; a mutation may still have succeeded before decoding failed.
        throw new ForgeOperationError("invalid-response", mutating);
      }
    } catch (error) {
      if (error instanceof ForgeOperationError) throw error;
      throw new ForgeOperationError("unavailable", mutating);
    }
  }
  /** Read and validate the authenticated bot's provider identity. */
  async identity() {
    return user.parse(await this.request("user"));
  }

  /** List every open pull request, continuing past server-capped short pages within the budget. */
  async openChanges(): Promise<ForgePullRequest[]> {
    const result: ForgePullRequest[] = [];
    const seen = new Set<number>();
    const expected = approvedUrl(
      this.connection.webUrl,
      this.connection.allowHttp,
    );
    for (let page = 1; page <= 20; page++) {
      if (Date.now() >= this.deadline)
        throw new ForgeOperationError("unavailable");
      const pulls = z
        .array(
          z.object({
            number,
            state: z.literal("open"),
            merged: z.literal(false),
            title: z.string(),
            html_url: z.string().url(),
            user: user.nullable().optional(),
            base: z.object({ sha, ref: z.string().min(1).max(1024) }),
            head: z.object({ sha, ref: z.string().min(1).max(1024) }),
            updated_at: z.string().datetime({ offset: true }),
          }),
        )
        .max(50)
        .parse(
          await this.request(
            `${this.route}/pulls?state=open&limit=50&page=${page}`,
          ),
        );
      if (pulls.length === 0) return result;
      for (const pull of pulls) {
        const url = approvedUrl(pull.html_url, this.connection.allowHttp);
        if (
          seen.has(pull.number) ||
          url.origin !== expected.origin ||
          url.pathname !==
            `${expected.pathname.replace(/\/$/, "")}/${this.route.slice("repos/".length)}/pulls/${pull.number}`
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

  /**
   * Authenticate a pull request's identity before rejecting closed or merged
   * state. Open requests retain exact revisions and source and target branches.
   */
  async change(n: number): Promise<ForgejoChange> {
    number.parse(n);
    const response = await this.request(`${this.route}/pulls/${n}`);
    const identity = z
      .object({
        number,
        state: z.enum(["open", "closed"]),
        merged: z.boolean(),
        html_url: z.string().url(),
      })
      .parse(response);
    const url = approvedUrl(identity.html_url, this.connection.allowHttp);
    const expected = approvedUrl(
      this.connection.webUrl,
      this.connection.allowHttp,
    );
    if (
      identity.number !== n ||
      url.origin !== expected.origin ||
      url.pathname !==
        `${expected.pathname.replace(/\/$/, "")}/${this.route.slice("repos/".length)}/pulls/${n}`
    )
      throw new ForgeOperationError("invalid-response");
    if (identity.state === "closed" || identity.merged)
      throw new ForgeOperationError("change-closed");
    const p = z
      .object({
        number,
        state: z.literal("open"),
        merged: z.literal(false),
        title: z.string(),
        user: user.optional(),
        html_url: z.string().url(),
        base: z.object({ sha, ref: z.string().min(1).max(1024).optional() }),
        head: z.object({ sha, ref: z.string().min(1).max(1024).optional() }),
        merge_base: sha,
      })
      .parse(response);
    return {
      number: n,
      baseSha: p.base.sha,
      headSha: p.head.sha,
      mergeBase: p.merge_base,
      headBranch: p.head.ref,
      baseBranch: p.base.ref,
      title: p.title,
      url: p.html_url,
      author: p.user?.login,
    };
  }
  /**
   * Read a comment's author, text and issue or pull request location for
   * independent webhook verification.
   */
  async comment(commentId: string) {
    return z
      .object({
        id,
        body: z.string(),
        user,
        issue_url: z.string(),
        pull_request_url: z.string().default(""),
      })
      .parse(await this.request(`${this.route}/issues/comments/${commentId}`));
  }
  /**
   * Read complete provider pagination within twenty pages; fail at the bound
   * so truncated results cannot be mistaken for absence.
   */
  private async list(route: string): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const rows =
        z
          .array(z.unknown())
          .nullable()
          .parse(await this.request(`${route}?limit=50&page=${page}`)) ?? [];
      all.push(...rows);
      if (rows.length < 50) return all;
    }
    throw new ForgeOperationError("invalid-response"); // Never treat a truncated list as absence.
  }
  /**
   * Read validated issue comments for a pull request using bounded complete
   * pagination.
   */
  async comments(n: number) {
    return z
      .array(z.object({ id, body: z.string(), user }))
      .parse(await this.list(`${this.route}/issues/${n}/comments`));
  }
  /**
   * Read native reviews with bot identity, commit and publication state for
   * write reconciliation.
   */
  async reviews(n: number) {
    return z
      .array(
        z.object({
          id,
          body: z.string(),
          user,
          commit_id: z.string(),
          state: z.string(),
        }),
      )
      .parse(await this.list(`${this.route}/pulls/${n}/reviews`));
  }
  /**
   * Read native inline comments with thread location, author and resolution
   * metadata for finding reconciliation.
   */
  async reviewComments(n: number, reviewId: string) {
    const comments = z
      .array(
        z.object({
          id,
          body: z.string(),
          path: z.string(),
          position: z
            .preprocess(
              (v) => Number(String(v)),
              z.number().int().nonnegative().safe(),
            )
            .optional(),
          extra_lines_count: z
            .preprocess(
              (v) => Number(String(v)),
              z.number().int().nonnegative().safe(),
            )
            .default(0),
          user: user.optional(),
          resolver: user.nullable().optional(),
          commit_id: z.string().optional(),
        }),
      )
      .parse(
        await this.list(
          `${this.route}/pulls/${n}/reviews/${reviewId}/comments`,
        ),
      )
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return comments.map((comment) => {
      const lineEnd =
        comment.position === undefined
          ? undefined
          : comment.position + comment.extra_lines_count;
      if (lineEnd !== undefined && !Number.isSafeInteger(lineEnd))
        throw new ForgeOperationError("invalid-response");
      // Native conversations group by their displayed last line. UI replies
      // can use that single line while inheriting the first comment's range.
      const root =
        comments.find(
          (candidate) =>
            candidate.path === comment.path &&
            candidate.position !== undefined &&
            candidate.position + candidate.extra_lines_count === lineEnd,
        ) ?? comment;
      return {
        id: comment.id,
        body: comment.body,
        path: root.path,
        user: comment.user,
        resolver: comment.resolver,
        commit_id: comment.commit_id,
        lineStart: root.position,
        lineEnd,
        threadId: `${reviewId}:${root.id}`,
        resolved: !!root.resolver,
      };
    });
  }
  /**
   * Add a thumbs-up acknowledgement only if the bot has not already posted
   * that reaction.
   */
  async react(commentId: string, botId: string) {
    const route = `${this.route}/issues/comments/${commentId}/reactions`;
    // Forgejo serializes an empty reaction list as null.
    const rows =
      z
        .array(z.object({ content: z.string(), user }))
        .nullable()
        .parse(await this.request(route)) ?? [];
    if (!rows.some((r) => r.content === "+1" && r.user.id === botId))
      await this.request(route, "POST", { content: "+1" });
  }
  /** Publish a pull request issue comment and return its lossless provider ID. */
  async postComment(n: number, body: string) {
    return z.object({ id }).parse(
      await this.request(`${this.route}/issues/${n}/comments`, "POST", {
        body,
      }),
    ).id;
  }
  /**
   * Publish a new-side inline reply in the specified native review and return
   * its provider ID.
   */
  async replyToReview(n: number, reviewId: string, comment: InlineComment) {
    const ranges =
      comment.lineStart < comment.lineEnd && (await this.supportsLineRanges());
    return z.object({ id }).parse(
      await this.request(
        `${this.route}/pulls/${n}/reviews/${id.parse(reviewId)}/comments`,
        "POST",
        {
          path: comment.path,
          new_position: ranges ? comment.lineStart : comment.lineEnd,
          ...(ranges
            ? { extra_lines_count: comment.lineEnd - comment.lineStart }
            : {}),
          body: comment.body,
          old_position: 0,
        },
      ),
    ).id;
  }

  /**
   * Detect Forgejo 16 range support before writing. Unsupported or malformed
   * capability responses use the last line; permission and transport failures
   * still propagate.
   */
  private async supportsLineRanges() {
    try {
      const result = z
        .object({ version: z.string().max(128) })
        .safeParse(await this.request("version"));
      if (!result.success) return false;
      const major = /^v?(\d+)\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.exec(
        result.data.version,
      )?.[1];
      return major !== undefined && Number(major) >= 16;
    } catch (error) {
      if (
        error instanceof ForgeOperationError &&
        !error.uncertain &&
        ["unsupported", "invalid-response"].includes(error.reason)
      )
        return false;
      throw error;
    }
  }
  /**
   * Publish a revision-bound native review with new-side inline comments;
   * omit marker-only descriptions on neutral inline follow-ups so Forgejo does
   * not render an empty comment box. Frozen inline markers identify those runs.
   * Preserve permission errors and classify other failed outcomes as uncertain
   * to prevent duplicate writes.
   */
  async postReview(
    n: number,
    head: string,
    body: string,
    comments: InlineComment[],
    event: "COMMENT" | "REQUEST_CHANGES",
  ) {
    const reviewBody =
      event === "COMMENT" &&
      comments.length > 0 &&
      /^<!-- razbor:[A-Za-z0-9_]+:result -->$/.test(body)
        ? ""
        : body;
    const ranges =
      comments.some((comment) => comment.lineStart < comment.lineEnd) &&
      (await this.supportsLineRanges());
    try {
      return z.object({ id }).parse(
        await this.request(`${this.route}/pulls/${n}/reviews`, "POST", {
          event,
          commit_id: head,
          body: reviewBody,
          comments: comments.map((comment) => ({
            path: comment.path,
            body: comment.body,
            new_position: ranges ? comment.lineStart : comment.lineEnd,
            old_position: 0,
            ...(ranges
              ? { extra_lines_count: comment.lineEnd - comment.lineStart }
              : {}),
          })),
        }),
      ).id;
    } catch (error) {
      if (error instanceof ForgeOperationError && error.reason === "permission")
        throw error;
      throw new ForgeOperationError("unavailable", true);
    }
  }
  /**
   * Replace the bot-owned review's timeline comment, preserving the native
   * review revision and inline threads; confirm the visible body afterward.
   */
  async editReview(n: number, reviewId: string, body: string): Promise<void> {
    number.parse(n);
    id.parse(reviewId);
    const bot = await this.identity();
    const owned = (await this.reviews(n)).filter(
      (review) => review.id === reviewId && review.user.id === bot.id,
    );
    if (owned.length !== 1 || owned[0]!.state === "PENDING")
      throw new ForgeOperationError("invalid-response");
    const timelineEntry = z.object({
      id,
      type: z.string(),
      review_id: id,
      body: z.string(),
      user,
    });
    // Unrelated entries may use Forgejo's negative ghost or system actor IDs;
    // validate recap fields only after selecting this review's entries.
    const entries = z
      .array(z.object({ type: z.string(), review_id: id }).passthrough())
      .parse(await this.list(`${this.route}/issues/${n}/timeline`))
      .filter(
        (entry) => entry.type === "review" && entry.review_id === reviewId,
      )
      .map((entry) => timelineEntry.parse(entry));
    const summary = entries[0];
    if (entries.length !== 1 || summary?.user.id !== bot.id)
      throw new ForgeOperationError("invalid-response");
    if (summary.body === body) return;
    const updated = z
      .object({ id, body: z.string(), user })
      .parse(
        await this.request(
          `${this.route}/issues/comments/${summary.id}`,
          "PATCH",
          { body },
        ),
      );
    if (
      updated.id !== summary.id ||
      updated.user.id !== bot.id ||
      updated.body !== body
    )
      throw new ForgeOperationError("invalid-response");
    // Forgejo's native review body remains separate from the editable timeline
    // comment, so reconciliation of this edit must read the timeline itself.
    const confirmed = z
      .array(z.object({ type: z.string(), review_id: id }).passthrough())
      .parse(await this.list(`${this.route}/issues/${n}/timeline`))
      .filter(
        (entry) => entry.type === "review" && entry.review_id === reviewId,
      )
      .map((entry) => timelineEntry.parse(entry));
    if (
      confirmed.length !== 1 ||
      confirmed[0]!.id !== summary.id ||
      confirmed[0]!.user.id !== bot.id ||
      confirmed[0]!.body !== body
    )
      throw new ForgeOperationError("invalid-response");
  }
  /**
   * Read the pull request's unified diff as bounded text for publication
   * anchor validation.
   */
  async diff(n: number) {
    return z
      .string()
      .parse(
        await this.request(
          `${this.route}/pulls/${n}.diff`,
          "GET",
          undefined,
          true,
        ),
      );
  }
  /**
   * Create or update the persisted or exact-callback Forgejo hook, rejecting
   * duplicate callback matches and avoiding creation when disabled.
   */
  async reconcileHook(
    callback: string,
    secret: string,
    enabled: boolean,
    ownedId: string | null,
  ) {
    const hooks = z
      .array(
        z.object({
          id,
          config: z.object({ url: z.string() }),
          type: z.string(),
        }),
      )
      .parse(await this.list(`${this.route}/hooks`));
    const owned =
      (ownedId ? hooks.find((h) => h.id === ownedId) : undefined) ??
      hooks.find((h) => h.config.url === callback && h.type === "forgejo");

    if (hooks.filter((h) => h.config.url === callback).length > 1)
      throw new ForgeOperationError("invalid-response");
    const body = {
      type: "forgejo",
      active: enabled,
      events: ["pull_request", "pull_request_comment", "push"],
      config: { url: callback, content_type: "json", secret },
    };
    if (!enabled && !owned) return null;
    const suffix = owned ? `/${owned.id}` : "";
    return z
      .object({ id })
      .parse(
        await this.request(
          `${this.route}/hooks${suffix}`,
          owned ? "PATCH" : "POST",
          body,
        ),
      ).id;
  }

  /**
   * Delete only a verified owned hook, allowing its stable endpoint to survive
   * callback-base changes; treat provider 404 as already removed.
   */
  async removeHook(callback: string, ownedId: string | null) {
    const expectedEndpoint = webhookEndpoint(callback);
    if (!expectedEndpoint) throw new ForgeOperationError("invalid-response");
    try {
      const hooks = z
        .array(
          z.object({
            id,
            config: z.object({ url: z.string() }),
            type: z.string(),
          }),
        )
        .parse(await this.list(`${this.route}/hooks`));
      const matching = hooks.filter((hook) => hook.config.url === callback);
      if (matching.length > 1)
        throw new ForgeOperationError("invalid-response");
      const owned =
        (ownedId ? hooks.find((hook) => hook.id === ownedId) : undefined) ??
        matching.find((hook) => hook.type === "forgejo");
      if (!owned) return;
      const remoteEndpoint = webhookEndpoint(owned.config.url);
      // A failed callback-base update can leave the prior host/path on the
      // persisted owned hook. Its stable generated endpoint still proves
      // ownership; an unbound fallback must match the entire callback URL.
      if (
        owned.type !== "forgejo" ||
        !remoteEndpoint ||
        (owned.config.url !== callback &&
          !(owned.id === ownedId && remoteEndpoint === expectedEndpoint))
      )
        throw new ForgeOperationError("invalid-response");
      await this.request(`${this.route}/hooks/${owned.id}`, "DELETE");
    } catch (error) {
      // A removed source repository or hook is already clean. Unsupported
      // routes and denied permissions are not proof that the hook is absent.
      if (error instanceof ForgeOperationError && error.status === 404) return;
      throw error;
    }
  }
}
