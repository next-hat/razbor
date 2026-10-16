import { publicIdSchema } from "@razbor/contracts";
import { acceptGithubAppWebhook } from "@razbor/database";

import { provisionIndex } from "@web/lib/indexer.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Bound and authenticate shared App deliveries before routing them to a saved installation/repository. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = publicIdSchema("githubApp").safeParse((await params).id);
  const headers = { "Cache-Control": "no-store" };
  if (!id.success) return new Response(null, { status: 404, headers });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 20000);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return new Response(null, { status: 408, headers });
      if (done) break;
      bytes += value.length;
      if (bytes > 1048576) {
        await reader.cancel();
        return new Response(null, { status: 413, headers });
      }
      chunks.push(value);
    }
    return new Response(null, {
      status: await acceptGithubAppWebhook(
        await reviewDatabase(),
        id.data,
        Buffer.concat(chunks),
        Object.fromEntries(request.headers),
        (repositoryId) =>
          provisionIndex(repositoryId, true, AbortSignal.timeout(720000)),
      ),
      headers,
    });
  } catch {
    return new Response(null, { status: 503, headers });
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
