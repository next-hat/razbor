import type {
  MemoryDocument,
  MemoryOperation,
  MemoryOperationResult,
} from "@razbor/contracts";

/** Carries a failed request's HTTP status and latest document for conflict recovery. */
export class MemoryRequestError extends Error {
  /** Retains conflict content so callers can reconcile without discarding drafts. */
  constructor(
    message: string,
    readonly status: number,
    readonly current?: MemoryDocument,
  ) {
    super(message);
  }
}

/** Sends a scoped memory operation and returns durable results or a typed conflict. */
export async function memoryRequest(
  repositoryId: string,
  operation: MemoryOperation,
  signal?: AbortSignal,
): Promise<MemoryOperationResult> {
  const response = await fetch(`/api/repositories/${repositoryId}/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(operation),
    cache: "no-store",
    signal,
  });
  const result = (await response.json()) as MemoryOperationResult & {
    error?: string;
    current?: MemoryDocument;
  };
  if (!response.ok)
    throw new MemoryRequestError(
      result.error ?? "Unable to load memory",
      response.status,
      result.current,
    );
  return result;
}
