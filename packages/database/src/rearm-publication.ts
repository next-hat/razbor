import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@database/src/connection.js";
import { dispatchOutbox } from "@database/src/schema.js";

/**
 * Offer a completed result for the same immutable revision to the publisher
 * again. Only a safely settled stale notice or a pre-write stale decision can
 * be replayed. Frozen native operations and uncertain writes keep their fences.
 */
export async function rearmStalePublication(tx: Transaction, reviewId: string) {
  await tx
    .update(dispatchOutbox)
    .set({
      interactionAfter: new Date(),
      publication: sql`jsonb_strip_nulls(jsonb_build_object(
        'state', 'pending', 'rearmed', true,
        'staleNoticeId', coalesce(${dispatchOutbox.publication}->>'remoteId',
          ${dispatchOutbox.publication}->>'staleNoticeId')))`,
    })
    .where(
      and(
        eq(dispatchOutbox.reviewId, reviewId),
        sql`${dispatchOutbox.publication}->>'state' = 'stale'
          and ${dispatchOutbox.publication}->>'writing' is distinct from 'true'
          and coalesce(${dispatchOutbox.publication}->>'mode', 'comment') = 'comment'
          and not (${dispatchOutbox.publication} ?| array['reviewPayload', 'providerProgress', 'inlineIds'])`,
      ),
    );
}
