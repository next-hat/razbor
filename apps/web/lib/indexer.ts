import {
  Agent,
  Dispatcher1Wrapper,
  type RequestInit as UndiciRequestInit,
} from "undici";

import {
  indexPreparationSnapshotsSchema,
  indexPreparationStatusRequestSchema,
  publicIdSchema,
} from "@razbor/contracts";

const state = globalThis as typeof globalThis & {
  razborIndexPreparationDispatcher?: Dispatcher1Wrapper;
};

// Preparation sends headers only after Git, graph, and embedding work completes.
// Its caller's finite abort deadline controls the whole request instead of the
// transport's independent five-minute header and body timers.
// Native Node.js fetch requires Undici's legacy dispatcher protocol.
export const indexPreparationDispatcher =
  (state.razborIndexPreparationDispatcher ??= new Dispatcher1Wrapper(
    new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
    }),
  ));

/**
 * Provisions or refreshes a repository workspace through the configured indexer,
 * propagating cancellation and rejecting invalid workspace IDs. Background
 * preparation returns after the indexer accepts ownership of the operation.
 */
export async function provisionIndex(
  repositoryId: string,
  prepare: boolean,
  signal: AbortSignal,
  background = false,
) {
  publicIdSchema("repository").parse(repositoryId);
  const endpoint = process.env.RAZBOR_INDEX_ENDPOINT;
  const token = process.env.RAZBOR_INDEX_MANAGEMENT_TOKEN;
  if (!endpoint || !token)
    throw new Error("indexer management is not configured");
  if (background && !prepare)
    throw new Error("background indexing requires preparation");
  // Background starts have a short acceptance deadline. Awaited preparation has
  // room beyond the indexer's one-hour work deadline for transport and encoding.
  const timeoutMs = background ? 30000 : prepare ? 4500000 : 720000;
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  const response = await fetch(
    new URL(`/repositories/${repositoryId}/index`, endpoint),
    {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      dispatcher: prepare ? indexPreparationDispatcher : undefined,
      signal: requestSignal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(background ? { prepare, background } : { prepare }),
    } as RequestInit & Pick<UndiciRequestInit, "dispatcher">,
  );
  if (!response.ok || (background && response.status !== 202)) {
    await response.body?.cancel();
    throw new Error("indexer operation failed");
  }
  const result = await indexerJson(response, requestSignal, 16384);
  if (!result || typeof result !== "object" || !("workspaceId" in result))
    throw new Error("indexer workspace response is invalid");
  return publicIdSchema("workspace").parse(result.workspaceId);
}

/**
 * Reads a bounded service response under the same finite request deadline,
 * cancelling the response reader on invalid, oversized, or interrupted JSON.
 */
async function indexerJson(
  response: Response,
  signal: AbortSignal,
  limit: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("indexer response is empty");
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("indexer response is too large");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Loads live preparation snapshots for server-authorized repository IDs. A short
 * deadline bounds each console refresh, and unexpected or duplicate bindings are
 * rejected before any service data is merged into the repository view.
 */
export async function indexPreparations(repositoryIds: string[]) {
  if (!repositoryIds.length) return [];
  const endpoint = process.env.RAZBOR_INDEX_ENDPOINT;
  const token = process.env.RAZBOR_INDEX_MANAGEMENT_TOKEN;
  if (!endpoint || !token)
    throw new Error("indexer management is not configured");
  const signal = AbortSignal.timeout(5000);
  const snapshots = [];
  for (let offset = 0; offset < repositoryIds.length; offset += 1000) {
    const ids = repositoryIds.slice(offset, offset + 1000);
    const body = indexPreparationStatusRequestSchema.parse({
      repositoryIds: ids,
    });
    const response = await fetch(new URL("/index-progress", endpoint), {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("indexer progress is unavailable");
    }
    const result = indexPreparationSnapshotsSchema.parse(
      await indexerJson(response, signal, 1048576),
    );
    const expected = new Set(ids);
    if (
      result.length !== expected.size ||
      result.some((entry) => !expected.delete(entry.repositoryId))
    )
      throw new Error("indexer progress bindings are invalid");
    snapshots.push(...result);
  }
  return snapshots;
}
