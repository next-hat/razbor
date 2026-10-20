export class IncompleteReviewError extends Error {
  /** Distinguishes an unfinished or budget-limited attempt from a completed clean review. */
  constructor(readonly gaps: string[]) {
    super(`Review incomplete: ${gaps.join(" ")}`);
  }
}
