export class PermanentError extends Error {}

/** Stop attempt work with a stable, non-sensitive error when its signal is cancelled. */
export function aborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("attempt cancelled");
}
