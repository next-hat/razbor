import { and, eq, sql } from "drizzle-orm";

import { reviewConversationSchema } from "@razbor/contracts";
import type { ForgeChange, Forge } from "@razbor/forge-adapters";

import type { Database } from "@database/src/connection.js";
import { findingKey } from "@database/src/presentation.js";
import {
  dispatchOutbox,
  reviews,
  reviewTriggers,
} from "@database/src/schema.js";

/**
 * Reconstruct a bounded conversation only after matching the incoming reply to
 * a bot-owned finding thread in a saved completed review.
 */
export async function reviewConversation(
  database: Database,
  repositoryId: string,
  change: ForgeChange,
  bot: string,
  api: Forge,
  event: { commentId: string; senderId: string },
) {
  const saved = await database.db
    .select({ review: reviews, publication: dispatchOutbox.publication })
    .from(reviewTriggers)
    .innerJoin(reviews, eq(reviewTriggers.reviewId, reviews.id))
    .innerJoin(dispatchOutbox, eq(dispatchOutbox.reviewId, reviews.id))
    .where(
      and(
        eq(reviewTriggers.repositoryId, repositoryId),
        sql`${reviewTriggers.change}->>'number' = ${String(change.number)}`,
        eq(reviews.status, "completed"),
      ),
    );
  if (!saved.length) return;
  const remoteReviews = await api.reviews(change.number);
  for (const { review, publication } of saved) {
    if (!review.result?.findings.length || review.source.conversation) continue;
    const remote = remoteReviews.find(
      (r) =>
        r.user.id === bot &&
        r.state !== "PENDING" &&
        r.commit_id === review.headSha &&
        (r.body.includes(`<!-- razbor:${review.publicId}:result -->`) ||
          (publication?.mode === "review" && publication.remoteId === r.id)),
    );
    if (!remote) continue;
    const comments = await api.reviewComments(change.number, remote.id);
    const reply = comments.find((c) => c.id === event.commentId);
    if (
      !reply ||
      reply.user?.id !== event.senderId ||
      !reply.body.trim() ||
      !reply.lineStart ||
      !reply.lineEnd
    )
      continue;
    const thread = comments.filter((c) => c.threadId === reply.threadId);
    const replyIndex = thread.findIndex((c) => c.id === reply.id);
    const parent = thread.find(
      (c) =>
        c.user?.id === bot &&
        thread.indexOf(c) < replyIndex &&
        review.result!.findings.some((f) =>
          c.body.includes(
            `<!-- razbor:${review.publicId}:${findingKey(f)} -->`,
          ),
        ),
    );
    if (!parent?.lineStart || !parent.lineEnd) continue;
    return reviewConversationSchema.parse({
      reviewId: review.publicId,
      originalBase: review.baseSha,
      originalHead: review.headSha,
      originalReview: review.result,
      title: change.title,
      target: {
        commentId: parent.id,
        threadId: parent.threadId,
        reviewId: remote.id,
        path: parent.path,
        lineStart: parent.lineStart,
        lineEnd: parent.lineEnd,
      },
      history: thread.slice(0, replyIndex).map((c) => ({
        id: c.id,
        author: c.user?.login ?? "deleted user",
        body: c.body,
      })),
      reply: { id: reply.id, author: reply.user.login, body: reply.body },
    });
  }
}
